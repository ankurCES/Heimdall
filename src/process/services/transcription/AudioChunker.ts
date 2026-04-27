// AudioChunker — v1.4.10 silence-aware splitter for long audio.
//
// Why this matters:
//   whisper.cpp holds the whole audio file in RAM. A 2-hour recording
//   uses ~3 GB and either OOMs on smaller boxes or stalls progress
//   feedback for 15+ minutes. Real analyst material — depositions,
//   surveillance, podcasts, congressional hearings — routinely
//   exceeds 1 h, so we need to split.
//
// Strategy:
//   1. probeDuration(path)  — ffprobe (or ffmpeg -i parse) gets the
//                             total length without reading samples.
//   2. detectSilences(path) — ffmpeg's silencedetect filter emits
//                             timestamped silence start/end pairs to
//                             stderr. We parse them into cut candidates.
//   3. planChunks(...)      — pick cut points such that each chunk is
//                             at most `targetSec` long and falls inside
//                             a silence (so we never split mid-word).
//                             When no silence is available within the
//                             window, hard-cut at the deadline; whisper
//                             handles word boundaries fine, just not as
//                             cleanly.
//   4. extractChunk(...)    — copy a [start, end) slice into a temp WAV
//                             via ffmpeg `-ss / -to` with codec re-mux.
//
// Cleanup is the caller's responsibility (TranscriptionService deletes
// each chunk's temp file after the corresponding whisper pass).

import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from 'electron-log'

export interface ChunkPlan {
  index: number          // 0-based
  startSec: number
  endSec: number
  durationSec: number
}

interface SilenceWindow {
  start: number          // seconds
  end: number
}

const DEFAULT_TARGET_SEC = 600       // 10 minutes per chunk
const MIN_TARGET_SEC = 120           // anything shorter than 2 min isn't worth chunking
const SILENCE_NOISE_DB = '-30dB'     // anything below -30 dB counts as silence
const SILENCE_MIN_DUR = '0.5'        // half a second of silence to qualify as a cut

/** Resolve `ffmpeg` (and optionally `ffprobe`) on PATH. Returns null if
 *  ffmpeg is missing — caller should skip chunking and pass the file
 *  through whole. */
async function findTool(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(which, [name], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const first = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean)
      resolve(first || null)
    })
  })
}

/** Run ffmpeg / ffprobe and return combined stdout+stderr (silencedetect
 *  emits its events to stderr, so we can't use stdout-only).
 *
 *  v1.4.11 — lower scheduler priority of the spawned process so a
 *  full-CPU ffmpeg pass (audio re-encode + silence detect on a 2 h
 *  file is ~30 s of pegged cores) doesn't starve the Electron main
 *  process and stall the UI. */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* */ }
    }
    let buf = ''
    child.stdout.on('data', (b: Buffer) => { buf += b.toString() })
    child.stderr.on('data', (b: Buffer) => { buf += b.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      // ffmpeg exits 0 even when only stderr is meaningful, but in
      // analysis-only mode (`-f null -`) it always exits 0.
      if (code === 0 || code === null) resolve(buf)
      else reject(new Error(`${cmd} exit ${code}: ${buf.slice(0, 300)}`))
    })
  })
}

/** Parse the total duration in seconds from an ffmpeg `-i` invocation.
 *  ffmpeg writes a "Duration: HH:MM:SS.mm" line to stderr that we scan. */
export async function probeDuration(filePath: string): Promise<number | null> {
  const ffmpeg = await findTool('ffmpeg')
  if (!ffmpeg) return null
  try {
    // -hide_banner trims noise; routing to /dev/null forces ffmpeg to
    // produce only the analysis stderr we want.
    const out = await runCapture(ffmpeg, ['-hide_banner', '-i', filePath, '-f', 'null', '-'])
    const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
    if (!m) return null
    const [, hh, mm, ss, frac] = m
    return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(`0.${frac}`)
  } catch (err) {
    log.debug(`audio-chunker: probeDuration failed: ${(err as Error).message}`)
    return null
  }
}

/** Run ffmpeg silencedetect over the entire file and return the
 *  detected silence windows. Output line format:
 *    [silencedetect @ 0x...] silence_start: 12.345
 *    [silencedetect @ 0x...] silence_end: 13.500 | silence_duration: 1.155
 */
export async function detectSilences(filePath: string): Promise<SilenceWindow[]> {
  const ffmpeg = await findTool('ffmpeg')
  if (!ffmpeg) return []
  try {
    const args = [
      '-hide_banner', '-nostats',
      '-i', filePath,
      '-af', `silencedetect=n=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_DUR}`,
      '-f', 'null', '-'
    ]
    const out = await runCapture(ffmpeg, args)
    const windows: SilenceWindow[] = []
    let pendingStart: number | null = null
    for (const line of out.split(/\r?\n/)) {
      const ms = line.match(/silence_start:\s*([0-9.]+)/)
      if (ms) { pendingStart = Number(ms[1]); continue }
      const me = line.match(/silence_end:\s*([0-9.]+)/)
      if (me && pendingStart != null) {
        windows.push({ start: pendingStart, end: Number(me[1]) })
        pendingStart = null
      }
    }
    return windows
  } catch (err) {
    log.debug(`audio-chunker: detectSilences failed: ${(err as Error).message}`)
    return []
  }
}

/** Decide chunk boundaries given total duration and detected silences.
 *  Aim for chunks ≤ targetSec; prefer cuts that fall inside a silence
 *  window so we never split mid-word. When no silence is available
 *  within ±10% of the target, hard-cut at the deadline. */
export function planChunks(
  totalSec: number,
  silences: SilenceWindow[],
  targetSec: number = DEFAULT_TARGET_SEC
): ChunkPlan[] {
  if (totalSec <= 0 || !Number.isFinite(totalSec)) return []
  const target = Math.max(MIN_TARGET_SEC, targetSec)
  if (totalSec <= target) {
    return [{ index: 0, startSec: 0, endSec: totalSec, durationSec: totalSec }]
  }
  // Sort silences by start; we iterate left-to-right.
  const sortedSilences = silences.slice().sort((a, b) => a.start - b.start)
  const cuts: number[] = []
  let cursor = 0
  while (cursor + target < totalSec) {
    const ideal = cursor + target
    const minAllowed = cursor + target * 0.8   // don't make tiny chunks
    const maxAllowed = Math.min(cursor + target * 1.1, totalSec - 1)
    // Prefer the silence window whose midpoint is closest to `ideal`
    // and that lies within [minAllowed, maxAllowed].
    let pick: number | null = null
    let bestDistance = Infinity
    for (const sw of sortedSilences) {
      const mid = (sw.start + sw.end) / 2
      if (mid < minAllowed || mid > maxAllowed) continue
      const d = Math.abs(mid - ideal)
      if (d < bestDistance) { bestDistance = d; pick = mid }
    }
    cuts.push(pick ?? ideal)
    cursor = cuts[cuts.length - 1]
  }
  // Build chunk list from cuts.
  const chunks: ChunkPlan[] = []
  let prev = 0
  cuts.forEach((c, i) => {
    chunks.push({ index: i, startSec: prev, endSec: c, durationSec: c - prev })
    prev = c
  })
  chunks.push({ index: chunks.length, startSec: prev, endSec: totalSec, durationSec: totalSec - prev })
  return chunks
}

/** Extract a single [startSec, endSec) slice into a temp WAV. Uses
 *  re-encode (not stream copy) so the output is always whisper-friendly
 *  16 kHz mono regardless of source codec. */
export async function extractChunk(
  filePath: string,
  startSec: number,
  endSec: number,
  index: number
): Promise<string> {
  const ffmpeg = await findTool('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg required for chunked transcription')
  const tmpDir = app.getPath('temp')
  const out = path.join(tmpDir, `heimdall-chunk-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}.wav`)
  const args = [
    '-y', '-hide_banner',
    '-i', filePath,
    '-ss', startSec.toFixed(3),
    '-to', endSec.toFixed(3),
    '-ac', '1', '-ar', '16000', '-vn',
    out
  ]
  await runCapture(ffmpeg, args)
  return out
}

/** True when the file is long enough to benefit from chunking. The
 *  caller threads through the user's `transcription.chunking` setting:
 *    'auto'   — chunk only when totalSec > targetSec
 *    'always' — chunk regardless
 *    'never'  — never chunk
 */
export function shouldChunk(
  totalSec: number | null,
  mode: 'auto' | 'always' | 'never',
  targetSec: number
): boolean {
  if (mode === 'never') return false
  if (totalSec == null || !Number.isFinite(totalSec) || totalSec <= 0) return false
  if (mode === 'always') return true
  return totalSec > targetSec
}
