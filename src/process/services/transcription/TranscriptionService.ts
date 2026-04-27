// TranscriptionService — v1.4.2 local-first audio/video transcription.
//
// Engine priority (configurable per deployment):
//   1. Local whisper.cpp binary (`whisper-cli` from
//      ggerganov/whisper.cpp) when settings.transcription.binaryPath
//      points at an executable. This is the default and the only
//      path that runs offline / air-gapped.
//   2. Self-hosted OpenAI-compatible /v1/audio/transcriptions
//      endpoint (e.g. faster-whisper-server, whisperX) when
//      settings.transcription.cloudEndpoint is set.
//   3. OpenAI's hosted Whisper, only if settings.transcription.allowCloud
//      AND apikeys.openai is set. Off by default — never silently leaks.
//
// Video files are accepted; audio is extracted via `ffmpeg` if the
// binary is in PATH. If ffmpeg is missing we still try the file
// (whisper.cpp 1.5+ accepts mp4/mkv directly via its own decoder).
//
// Output schema (transcripts table, migration 047):
//   - full_text: joined plain text for FTS / RAG
//   - segments_json: [{start, end, text}, ...] for scrubbing
//   - duration_ms / language / model / engine for provenance
//
// Like DocumentOcrService, substantial transcripts (>500 chars)
// auto-create an intel_reports row tagged source='transcription'.

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { spawn } from 'child_process'
import log from 'electron-log'
import { app } from 'electron'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { modelDownloadManager } from '../models/ModelDownloadManager'
import { findBinary } from '../models/BinaryLocator'

export interface TranscriptSegment {
  start: number   // seconds
  end: number     // seconds
  text: string
}

export interface TranscriptRow {
  id: string
  source_path: string
  source_kind: 'file' | 'url'
  file_name: string | null
  file_size: number | null
  mime_type: string | null
  sha256: string | null
  duration_ms: number | null
  language: string | null
  model: string | null
  engine: string | null
  full_text: string | null
  segments_json: string | null
  report_id: string | null
  ingested_at: number
  // v1.4.6 — translation columns (migration 048)
  translated_text?: string | null
  translated_lang?: string | null
  translated_at?: number | null
  // v1.4.7 — segment-level translation (migration 049)
  translated_segments_json?: string | null
}

export interface TranscribeOptions {
  reportId?: string | null
  language?: string         // ISO code or 'auto'
  forceEngine?: 'whisper-cli' | 'openai-compat' | 'openai-cloud'
}

interface TranscribeResult {
  fullText: string
  segments: TranscriptSegment[]
  language: string | null
  durationMs: number | null
  model: string
  engine: string
}

interface TranscriptionConfig {
  binaryPath?: string                // path to whisper-cli executable
  modelPath?: string                 // path to .bin model file (whisper.cpp)
  model?: string                     // model name (e.g. "base", "small", "medium")
  language?: string                  // default language hint
  cloudEndpoint?: string             // OpenAI-compatible URL (no /v1)
  cloudModel?: string                // remote model name; defaults to "whisper-1"
  cloudApiKey?: string               // overrides apikeys.openai
  allowCloud?: boolean               // hard gate for OpenAI cloud
  threads?: number                   // whisper.cpp -t flag
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.webm'])
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.mpeg', '.mpg', '.m4v'])
const MAX_TEXT_PERSIST = 2_000_000  // truncate full_text in DB
const MAX_SEGMENTS = 5000           // cap to keep segments_json bounded
const REPORT_AUTOCREATE_MIN_CHARS = 500

export class TranscriptionService {
  // Short-lived cache for the auto-detected binary path. We don't want
  // to re-`which` on every transcribe call (hundreds of times per
  // session), but we also can't permanently cache `null` — the analyst
  // may install whisper-cli mid-session via brew, and the next
  // testEngine() call needs to pick that up. 10s TTL strikes the
  // balance: fast enough for hot loops, fresh enough for the UI's
  // "Re-check" button to surface a newly-installed binary.
  private detectedBinary: { path: string | null; expiresAt: number } | null = null
  private readonly DETECT_TTL_MS = 10_000

  /** Force the next getConfig() call to re-run binary detection.
   *  Called from testEngine() so the engine banner's manual refresh
   *  reflects the current state of PATH (e.g. after brew install). */
  invalidateBinaryCache(): void {
    this.detectedBinary = null
  }

  /** Read & merge config each call so settings hot-reload works. Auto-fills
   *  missing fields from ModelDownloadManager + BinaryLocator so the
   *  default install (no manual config) just works. */
  private async getConfig(): Promise<TranscriptionConfig> {
    const user = settingsService.get<TranscriptionConfig>('transcription') || {}
    const merged: TranscriptionConfig = { ...user }

    // Auto-resolve model path from the download manager. Preference
    // order is multilingual-first because the analyst use case spans
    // many languages (HUMINT interviews, SOCMINT recordings, etc.) and
    // base.en silently produces garbled English when fed non-English
    // audio. base (multilingual) and base.en have identical inference
    // speed at the same model size, so multilingual is the better
    // default whenever it's installed. Falls back to base.en (which
    // we auto-fetch on first run) and finally small.en for the
    // analyst who explicitly opted into the bigger English model.
    if (!merged.modelPath) {
      const auto = modelDownloadManager.path('whisper-base-multilingual')
        ?? modelDownloadManager.path('whisper-base-en')
        ?? modelDownloadManager.path('whisper-small-en')
      if (auto) merged.modelPath = auto
    }

    // Auto-detect binary from PATH + common install dirs (10s cache)
    if (!merged.binaryPath) {
      const now = Date.now()
      if (!this.detectedBinary || this.detectedBinary.expiresAt < now) {
        const found = await findBinary(['whisper-cli', 'whisper-cpp', 'whisper', 'main'])
        this.detectedBinary = { path: found, expiresAt: now + this.DETECT_TTL_MS }
        if (found) log.info(`transcription: auto-detected binary at ${found}`)
      }
      if (this.detectedBinary.path) merged.binaryPath = this.detectedBinary.path
    }

    return merged
  }

  /** Ingest one local file: dedup → transcribe → persist → optional intel_report. */
  async ingestFile(filePath: string, opts: TranscribeOptions = {}): Promise<TranscriptRow> {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
    const buf = await fs.readFile(filePath)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')

    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM transcripts WHERE sha256 = ? LIMIT 1').get(sha) as { id: string } | undefined
    if (existing) {
      log.info(`transcription: dedup hit for ${path.basename(filePath)} → ${existing.id}`)
      return this.get(existing.id)!
    }

    const ext = path.extname(filePath).toLowerCase()
    const isAudio = AUDIO_EXTS.has(ext)
    const isVideo = VIDEO_EXTS.has(ext)
    if (!isAudio && !isVideo) {
      throw new Error(`Unsupported media extension: ${ext || 'no extension'}`)
    }

    // Whisper.cpp accepts most formats directly, but always-WAV resampling
    // gives the best compatibility across engines. Try ffmpeg if present.
    const audioPath = await maybeTranscodeToWav(filePath, isVideo)

    const result = await this.transcribe(audioPath, opts)

    // Clean up the temp wav if we created one
    if (audioPath !== filePath) {
      try { await fs.unlink(audioPath) } catch { /* */ }
    }

    const id = generateId()
    const now = Date.now()
    const name = path.basename(filePath)
    const mime = guessMime(ext)
    const segmentsCapped = result.segments.slice(0, MAX_SEGMENTS)
    const fullTextCapped = result.fullText.slice(0, MAX_TEXT_PERSIST)

    db.prepare(`
      INSERT INTO transcripts
        (id, source_path, source_kind, file_name, file_size, mime_type, sha256,
         duration_ms, language, model, engine, full_text, segments_json,
         report_id, ingested_at)
      VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, filePath, name, stat.size, mime, sha,
      result.durationMs, result.language, result.model, result.engine,
      fullTextCapped, JSON.stringify(segmentsCapped),
      opts.reportId ?? null, now
    )

    // Auto-create an intel_reports row when transcript is substantial
    let newReportId: string | null = null
    if (!opts.reportId && fullTextCapped.replace(/\s/g, '').length > REPORT_AUTOCREATE_MIN_CHARS) {
      newReportId = crypto.randomUUID()
      const hash = crypto.createHash('sha256').update(fullTextCapped).digest('hex')
      const title = `Transcript: ${name}`
      const content = buildReportContent(fullTextCapped, segmentsCapped, result)
      db.prepare(`
        INSERT INTO intel_reports
          (id, discipline, title, content, summary, severity, source_id, source_url, source_name,
           content_hash, verification_score, reviewed, created_at, updated_at)
        VALUES (?, 'osint', ?, ?, NULL, 'medium', 'transcription', ?, 'Audio/Video Transcript', ?, 60, 0, ?, ?)
      `).run(newReportId, title, content.slice(0, 200_000), filePath, hash, now, now)
      db.prepare('UPDATE transcripts SET report_id = ? WHERE id = ?').run(newReportId, id)
    }

    log.info(`transcription: ${name} — ${(result.durationMs ?? 0) / 1000}s, ${segmentsCapped.length} segments, ${fullTextCapped.length} chars [${result.engine}/${result.model}, lang=${result.language || 'auto'}]${newReportId ? ` intel_report=${newReportId}` : ''}`)

    return this.get(id)!
  }

  /** Engine dispatcher. Picks the highest-priority engine the config + env supports. */
  private async transcribe(audioPath: string, opts: TranscribeOptions): Promise<TranscribeResult> {
    const cfg = await this.getConfig()
    const force = opts.forceEngine

    // 1. Local whisper.cpp binary
    if ((!force || force === 'whisper-cli') && cfg.binaryPath && existsSync(cfg.binaryPath)) {
      try {
        return await this.transcribeWhisperCpp(audioPath, cfg, opts)
      } catch (err) {
        log.warn(`transcription: whisper-cli failed, will try fallback: ${(err as Error).message}`)
        if (force === 'whisper-cli') throw err
      }
    }

    // 2. OpenAI-compatible self-hosted endpoint
    if ((!force || force === 'openai-compat') && cfg.cloudEndpoint) {
      try {
        return await this.transcribeOpenAiCompat(audioPath, cfg, opts, /*cloud=*/false)
      } catch (err) {
        log.warn(`transcription: openai-compat endpoint failed: ${(err as Error).message}`)
        if (force === 'openai-compat') throw err
      }
    }

    // 3. OpenAI hosted Whisper (opt-in)
    if ((!force || force === 'openai-cloud') && cfg.allowCloud) {
      const cloudKey = cfg.cloudApiKey || settingsService.get<string>('apikeys.openai')
      if (!cloudKey) {
        throw new Error('Cloud Whisper enabled but no OpenAI API key (settings.apikeys.openai)')
      }
      return await this.transcribeOpenAiCompat(audioPath, { ...cfg, cloudEndpoint: 'https://api.openai.com', cloudApiKey: cloudKey }, opts, /*cloud=*/true)
    }

    throw new Error(
      'No transcription engine available. Configure Settings → Transcription with either ' +
      'a whisper.cpp binary path, an OpenAI-compatible endpoint, or enable cloud Whisper.'
    )
  }

  /** whisper.cpp via child_process. Parses JSON output for segments+language. */
  private async transcribeWhisperCpp(
    audioPath: string,
    cfg: TranscriptionConfig,
    opts: TranscribeOptions
  ): Promise<TranscribeResult> {
    if (!cfg.binaryPath) throw new Error('binaryPath required')
    const modelPath = cfg.modelPath
    if (!modelPath || !existsSync(modelPath)) {
      throw new Error(`whisper.cpp model file missing: ${modelPath || '(unset)'}. Download from huggingface.co/ggerganov/whisper.cpp`)
    }

    const lang = opts.language || cfg.language || 'auto'
    const threads = cfg.threads ?? Math.max(2, Math.min(8, os.cpus().length - 1))
    // -oj writes a sidecar .json next to the audio path (whisper.cpp behavior)
    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-t', String(threads),
      '-l', lang,
      '-oj',                    // output JSON
      '-of', audioPath          // output prefix; whisper.cpp adds .json
    ]

    log.debug(`transcription: spawn ${cfg.binaryPath} ${args.join(' ')}`)
    await runChild(cfg.binaryPath, args, { cwd: path.dirname(audioPath) })

    const jsonPath = `${audioPath}.json`
    if (!existsSync(jsonPath)) {
      throw new Error('whisper.cpp produced no JSON output (check stderr)')
    }
    const raw = await fs.readFile(jsonPath, 'utf-8')
    try { await fs.unlink(jsonPath) } catch { /* */ }
    const parsed = JSON.parse(raw) as {
      result?: { language?: string }
      transcription?: Array<{ offsets?: { from: number; to: number }; timestamps?: { from: string; to: string }; text?: string }>
    }

    const rawSegs = parsed.transcription || []
    const segments: TranscriptSegment[] = rawSegs.map((s) => ({
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
      text: (s.text || '').trim()
    })).filter((s) => s.text)

    const fullText = segments.map((s) => s.text).join(' ').trim()
    const durationMs = segments.length ? Math.round(segments[segments.length - 1].end * 1000) : null

    return {
      fullText,
      segments,
      language: parsed.result?.language || null,
      durationMs,
      model: cfg.model || path.basename(modelPath, '.bin'),
      engine: 'whisper-cli'
    }
  }

  /** OpenAI-compatible /v1/audio/transcriptions request. Used by both
   *  self-hosted (faster-whisper-server etc.) and api.openai.com. */
  private async transcribeOpenAiCompat(
    audioPath: string,
    cfg: TranscriptionConfig,
    opts: TranscribeOptions,
    cloud: boolean
  ): Promise<TranscribeResult> {
    const base = (cfg.cloudEndpoint || '').replace(/\/+$/, '')
    if (!base) throw new Error('cloudEndpoint required')
    const url = `${base}/v1/audio/transcriptions`
    const model = cfg.cloudModel || (cloud ? 'whisper-1' : 'whisper-1')

    const buf = await fs.readFile(audioPath)
    const fileName = path.basename(audioPath)

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buf)]), fileName)
    form.append('model', model)
    form.append('response_format', 'verbose_json')
    if (opts.language && opts.language !== 'auto') form.append('language', opts.language)
    else if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language)

    const headers: Record<string, string> = {}
    if (cfg.cloudApiKey) headers.Authorization = `Bearer ${cfg.cloudApiKey}`

    const resp = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error(`OpenAI-compat transcription failed: HTTP ${resp.status} ${txt.slice(0, 200)}`)
    }
    const data = await resp.json() as {
      text?: string
      language?: string
      duration?: number
      segments?: Array<{ start: number; end: number; text: string }>
    }

    const segments: TranscriptSegment[] = (data.segments || []).map((s) => ({
      start: s.start, end: s.end, text: (s.text || '').trim()
    })).filter((s) => s.text)
    const fullText = (data.text || segments.map((s) => s.text).join(' ')).trim()
    const durationMs = data.duration ? Math.round(data.duration * 1000) : null

    return {
      fullText,
      segments,
      language: data.language || null,
      durationMs,
      model,
      engine: cloud ? 'openai-cloud' : 'openai-compat'
    }
  }

  get(id: string): TranscriptRow | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, source_path, source_kind, file_name, file_size, mime_type, sha256,
             duration_ms, language, model, engine, full_text, segments_json,
             report_id, ingested_at,
             translated_text, translated_lang, translated_at,
             translated_segments_json
      FROM transcripts WHERE id = ?
    `).get(id) as TranscriptRow) || null
  }

  list(limit = 100): TranscriptRow[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, source_path, source_kind, file_name, file_size, mime_type, sha256,
             duration_ms, language, model, engine, full_text, segments_json,
             report_id, ingested_at,
             translated_text, translated_lang, translated_at,
             translated_segments_json
      FROM transcripts ORDER BY ingested_at DESC LIMIT ?
    `).all(limit) as TranscriptRow[]
  }

  remove(id: string): void {
    getDatabase().prepare('DELETE FROM transcripts WHERE id = ?').run(id)
  }

  /**
   * v1.4.6 / v1.4.7 — translate a non-English transcript to English.
   *
   * Uses the existing TranslationService (LLM-backed, 24h SHA-1 cache).
   * Original full_text and segments_json are NEVER mutated; translation
   * lands in translated_text and (v1.4.7) translated_segments_json so
   * the renderer can show timestamp-jump UX in the translated view.
   *
   * Strategy:
   *   1. Translate full_text once to get the canonical English copy.
   *   2. Send the segments to the LLM as a numbered list and parse a
   *      same-length numbered list back. Single LLM call for all
   *      segments — robust to length and dramatically cheaper than N
   *      independent calls. Segment timestamps are preserved verbatim.
   *   3. If the segment-level call produces fewer / more lines than
   *      expected, fall back to a heuristic split of full_text by
   *      proportional segment length (degraded but never blank).
   *
   * Idempotent: re-running on an already-translated row is a no-op.
   * Returns null when no translation is needed (already English / too
   * short / already translated).
   */
  async translate(id: string): Promise<TranscriptRow | null> {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, language, full_text, segments_json, translated_text
      FROM transcripts WHERE id = ?
    `).get(id) as {
      id: string
      language: string | null
      full_text: string | null
      segments_json: string | null
      translated_text: string | null
    } | undefined
    if (!row) return null
    if (row.translated_text) return this.get(id)
    if (!row.full_text || row.full_text.length < 30) return null

    const { translationService } = await import('../translation/TranslationService')
    const fullResult = await translationService.translate(row.full_text, 'en')
    if (!fullResult.translatedText || fullResult.translatedText === row.full_text) {
      log.info(`transcription: translation no-op for ${id} (lang=${fullResult.originalLang})`)
      return null
    }

    // Segment-level pass — only when we have segments and translation was non-trivial
    let translatedSegmentsJson: string | null = null
    let segments: TranscriptSegment[] = []
    try { segments = row.segments_json ? JSON.parse(row.segments_json) as TranscriptSegment[] : [] } catch { /* */ }
    if (segments.length > 0 && segments.length <= 1000) {
      try {
        const translatedTexts = await translateSegmentsViaLlm(segments)
        if (translatedTexts && translatedTexts.length === segments.length) {
          translatedSegmentsJson = JSON.stringify(
            segments.map((s, i) => ({ start: s.start, end: s.end, text: translatedTexts[i] }))
          )
        } else {
          // Fall back to proportional-length split of the full translated text
          translatedSegmentsJson = JSON.stringify(splitTranslationProportional(segments, fullResult.translatedText))
          log.info(`transcription: segment-level LLM returned ${translatedTexts?.length ?? 0}/${segments.length}; using proportional split`)
        }
      } catch (err) {
        log.warn(`transcription: segment translation failed for ${id}: ${(err as Error).message}; using proportional split`)
        translatedSegmentsJson = JSON.stringify(splitTranslationProportional(segments, fullResult.translatedText))
      }
    }

    const now = Date.now()
    db.prepare(`
      UPDATE transcripts
      SET translated_text = ?, translated_lang = 'en', translated_at = ?,
          translated_segments_json = ?,
          language = COALESCE(language, ?)
      WHERE id = ?
    `).run(
      fullResult.translatedText.slice(0, MAX_TEXT_PERSIST),
      now,
      translatedSegmentsJson,
      fullResult.originalLang,
      id
    )
    log.info(`transcription: translated ${id} ${fullResult.originalLang}→en (${fullResult.durationMs}ms${fullResult.fromCache ? ', cached' : ''}${translatedSegmentsJson ? `, ${segments.length} segments` : ''})`)
    return this.get(id)
  }

  /** Quick preflight for the Settings UI test button. Always
   *  invalidates the binary cache first so a newly-installed
   *  whisper-cli (e.g. via brew install run from the Models tab) is
   *  picked up by the very next call. */
  async testEngine(): Promise<{ ok: boolean; engine: string | null; message: string }> {
    this.invalidateBinaryCache()
    const cfg = await this.getConfig()
    if (cfg.binaryPath && existsSync(cfg.binaryPath)) {
      if (!cfg.modelPath || !existsSync(cfg.modelPath)) {
        return { ok: false, engine: 'whisper-cli', message: `Model file missing: ${cfg.modelPath || '(unset)'}` }
      }
      try {
        const helpOut = await runChild(cfg.binaryPath, ['--help'], { cwd: app.getPath('userData') }).catch(() => '')
        if (typeof helpOut === 'string' && helpOut.toLowerCase().includes('whisper')) {
          return { ok: true, engine: 'whisper-cli', message: `whisper.cpp ready (model: ${path.basename(cfg.modelPath)})` }
        }
        return { ok: true, engine: 'whisper-cli', message: 'binary callable but --help did not match expected output' }
      } catch (err) {
        return { ok: false, engine: 'whisper-cli', message: `binary not executable: ${(err as Error).message}` }
      }
    }
    if (cfg.cloudEndpoint) {
      return { ok: true, engine: 'openai-compat', message: `endpoint configured: ${cfg.cloudEndpoint}` }
    }
    if (cfg.allowCloud) {
      const cloudKey = cfg.cloudApiKey || settingsService.get<string>('apikeys.openai')
      if (!cloudKey) return { ok: false, engine: 'openai-cloud', message: 'cloud enabled but no OpenAI API key' }
      return { ok: true, engine: 'openai-cloud', message: 'OpenAI cloud Whisper enabled' }
    }
    return { ok: false, engine: null, message: 'No engine configured. Set whisper-cli binaryPath or a cloudEndpoint.' }
  }
}

export const transcriptionService = new TranscriptionService()

// ── helpers ─────────────────────────────────────────────────────────

function guessMime(ext: string): string | null {
  switch (ext) {
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.flac': return 'audio/flac'
    case '.ogg': case '.opus': return 'audio/ogg'
    case '.aac': return 'audio/aac'
    case '.mp4': case '.m4v': return 'video/mp4'
    case '.mkv': return 'video/x-matroska'
    case '.mov': return 'video/quicktime'
    case '.avi': return 'video/x-msvideo'
    case '.webm': return 'video/webm'
    default: return null
  }
}

/** Try ffmpeg → 16kHz mono WAV for max engine compatibility.
 *  Returns the original path if ffmpeg is missing or transcode fails. */
async function maybeTranscodeToWav(filePath: string, isVideo: boolean): Promise<string> {
  // Skip transcode for already-WAV audio
  if (!isVideo && filePath.toLowerCase().endsWith('.wav')) return filePath
  const ffmpeg = await which('ffmpeg')
  if (!ffmpeg) {
    log.debug('transcription: ffmpeg not in PATH; passing original file to engine')
    return filePath
  }
  const tmpDir = app.getPath('temp')
  const out = path.join(tmpDir, `heimdall-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  try {
    await runChild(ffmpeg, ['-y', '-i', filePath, '-ac', '1', '-ar', '16000', '-vn', out])
    return out
  } catch (err) {
    log.debug(`transcription: ffmpeg transcode failed (${(err as Error).message}); using original`)
    try { await fs.unlink(out) } catch { /* */ }
    return filePath
  }
}

/** Resolve an executable name through PATH; returns absolute path or null. */
async function which(cmd: string): Promise<string | null> {
  const tool = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = await runChild(tool, [cmd])
    const first = (out || '').split(/\r?\n/)[0].trim()
    return first || null
  } catch {
    return null
  }
}

/** Promisified spawn. Captures stdout+stderr, throws on non-zero exit. */
function runChild(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString() })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`))
    })
  })
}

function buildReportContent(text: string, segments: TranscriptSegment[], r: TranscribeResult): string {
  const lines: string[] = []
  lines.push(`**Engine**: ${r.engine} (model: ${r.model})`)
  if (r.language) lines.push(`**Language**: ${r.language}`)
  if (r.durationMs) lines.push(`**Duration**: ${(r.durationMs / 1000).toFixed(1)}s`)
  lines.push(`**Segments**: ${segments.length}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  // First 50 segments with timestamps for navigability
  const head = segments.slice(0, 50)
  for (const s of head) {
    lines.push(`[${fmtTime(s.start)}–${fmtTime(s.end)}] ${s.text}`)
  }
  if (segments.length > 50) {
    lines.push('')
    lines.push(`_… ${segments.length - 50} more segment(s) elided. Full text below._`)
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(text)
  }
  return lines.join('\n')
}

function fmtTime(s: number): string {
  const mins = Math.floor(s / 60)
  const secs = (s - mins * 60).toFixed(1)
  return `${mins}:${secs.padStart(4, '0')}`
}

// ── v1.4.7 segment-level translation helpers ──────────────────────

const SEGMENT_TRANSLATE_PROMPT = `You translate a numbered list of short utterances from a transcript into English. Rules:
- Preserve the EXACT same numbering (1., 2., 3., …).
- Output ONLY the numbered list — no preamble, no commentary, no markdown fencing.
- Keep one translation per line, matching the input line count exactly.
- Preserve names, dates, numbers, and proper nouns verbatim.
- If an utterance is already in English or untranslatable, output it unchanged.

Input list (translate each line; keep numbering identical):
`

/**
 * Send all segments to the LLM as a numbered list and parse a same-length
 * list back. Returns the translated text array, or null if parsing fails
 * (caller falls back to proportional split).
 */
async function translateSegmentsViaLlm(segments: TranscriptSegment[]): Promise<string[] | null> {
  // Lazy-load LlmService to avoid pulling it at cold start
  const { llmService } = await import('../llm/LlmService')

  // Build the numbered input
  const input = segments.map((s, i) => `${i + 1}. ${(s.text || '').replace(/\s+/g, ' ').trim()}`).join('\n')
  // Generous token budget — average segment is ~50 chars, 1000 segments ≈ 60k chars ≈ 25k tokens out
  const maxTokens = Math.min(16384, Math.max(2048, segments.length * 80))

  const response = await llmService.completeForTask('planner', SEGMENT_TRANSLATE_PROMPT + input, undefined, maxTokens)
  if (!response) return null

  // Parse numbered lines; tolerant of extra whitespace and stray prose
  const lines = response.split(/\r?\n/)
  const out: string[] = new Array(segments.length).fill('')
  for (const raw of lines) {
    const m = raw.match(/^\s*(\d+)[.)]\s*(.*)$/)
    if (!m) continue
    const idx = parseInt(m[1], 10) - 1
    if (idx < 0 || idx >= segments.length) continue
    if (out[idx]) continue   // first match wins (defensive against duplicates)
    out[idx] = m[2].trim()
  }
  // Sanity check — at least 80% of slots filled in for the result to be usable
  const filled = out.filter((s) => s.length > 0).length
  if (filled < segments.length * 0.8) return null
  // Backfill any missing slots with original text so timestamps stay aligned
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) out[i] = segments[i].text
  }
  return out
}

/**
 * Distribute a single translated string across the segment timeline
 * proportional to each segment's text length. Used as a fallback when
 * the LLM segment pass fails. Result is degraded (sentences may break
 * across segment boundaries) but every timestamp still has SOMETHING
 * the analyst can read.
 */
function splitTranslationProportional(
  segments: TranscriptSegment[],
  translated: string
): TranscriptSegment[] {
  const totalLen = segments.reduce((s, seg) => s + (seg.text || '').length, 0) || 1
  const out: TranscriptSegment[] = []
  let pos = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const isLast = i === segments.length - 1
    const portion = (seg.text || '').length / totalLen
    const take = isLast ? translated.length - pos : Math.round(translated.length * portion)
    const slice = translated.slice(pos, pos + take).trim()
    out.push({ start: seg.start, end: seg.end, text: slice || seg.text })
    pos += take
  }
  return out
}
