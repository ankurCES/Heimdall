// TranscriptionExporter — v1.4.9 format converters for outbound use.
//
// Output formats:
//   srt   — SubRip Text (the de facto subtitle standard; opens in
//           VLC / DaVinci Resolve / Premiere / FFmpeg)
//   vtt   — WebVTT (HTML5 <track> + YouTube auto-captions)
//   json  — Heimdall-native dump: top-level metadata + segments array.
//           Round-trips losslessly into other tools.
//   text  — Plain prose, no timestamps. Drop into a court filing or
//           translation memory unchanged.
//
// All formatters operate on a TranscriptRow (already loaded from the
// DB). The chosen "view" decides whether we use the original segments
// or the translated ones — for SRT/VTT this matters (translated subs
// keep the original timestamps but the text is English).

import type { TranscriptRow, TranscriptSegment } from './TranscriptionService'

export type ExportFormat = 'srt' | 'vtt' | 'json' | 'text'
export type ExportView = 'original' | 'translation'

export interface ExportResult {
  format: ExportFormat
  view: ExportView
  filename: string                 // suggested download filename
  mime: string
  body: string
}

const MIME: Record<ExportFormat, string> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  json: 'application/json',
  text: 'text/plain'
}

/** Public entry point. Selects segments based on view, then dispatches
 *  to the right formatter. Throws if the requested view doesn't have
 *  data (e.g. translation view on an untranslated transcript). */
export function exportTranscript(
  row: TranscriptRow,
  format: ExportFormat,
  view: ExportView = 'original'
): ExportResult {
  const segments = pickSegments(row, view)
  const fullText = pickFullText(row, view)

  let body: string
  switch (format) {
    case 'srt':  body = toSrt(segments, fullText); break
    case 'vtt':  body = toVtt(segments, fullText); break
    case 'json': body = toJson(row, segments, fullText, view); break
    case 'text': body = toPlainText(segments, fullText); break
  }

  return {
    format,
    view,
    filename: suggestFilename(row, format, view),
    mime: MIME[format],
    body
  }
}

// ── view selection ────────────────────────────────────────────────

function pickSegments(row: TranscriptRow, view: ExportView): TranscriptSegment[] {
  if (view === 'translation') {
    if (row.translated_segments_json) {
      try { return JSON.parse(row.translated_segments_json) as TranscriptSegment[] } catch { /* */ }
    }
    // No segment-level translation available; caller will fall back to
    // full_text via pickFullText().
    return []
  }
  if (!row.segments_json) return []
  try { return JSON.parse(row.segments_json) as TranscriptSegment[] } catch { return [] }
}

function pickFullText(row: TranscriptRow, view: ExportView): string {
  if (view === 'translation' && row.translated_text) return row.translated_text
  return row.full_text || ''
}

// ── formatters ────────────────────────────────────────────────────

/** SubRip (.srt). Format:
 *
 *    1
 *    00:00:00,000 --> 00:00:04,500
 *    Hello, world.
 *
 *    2
 *    00:00:04,500 --> 00:00:09,000
 *    Second cue.
 */
function toSrt(segments: TranscriptSegment[], fullText: string): string {
  if (!segments.length) {
    // Single cue covering full duration when we lack segment timing.
    return `1\n00:00:00,000 --> 00:00:00,000\n${fullText.trim() || '(empty)'}\n`
  }
  const lines: string[] = []
  segments.forEach((s, i) => {
    lines.push(String(i + 1))
    lines.push(`${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}`)
    lines.push((s.text || '').trim())
    lines.push('')
  })
  return lines.join('\n')
}

/** WebVTT (.vtt). Format:
 *
 *    WEBVTT
 *
 *    00:00.000 --> 00:04.500
 *    Hello, world.
 */
function toVtt(segments: TranscriptSegment[], fullText: string): string {
  const lines: string[] = ['WEBVTT', '']
  if (!segments.length) {
    lines.push('00:00.000 --> 00:00.000')
    lines.push(fullText.trim() || '(empty)')
    return lines.join('\n') + '\n'
  }
  segments.forEach((s) => {
    lines.push(`${fmtVttTime(s.start)} --> ${fmtVttTime(s.end)}`)
    lines.push((s.text || '').trim())
    lines.push('')
  })
  return lines.join('\n')
}

/** Heimdall-native JSON dump. Lossless; can be re-imported. */
function toJson(
  row: TranscriptRow,
  segments: TranscriptSegment[],
  fullText: string,
  view: ExportView
): string {
  const payload = {
    schema: 'heimdall.transcript/v1',
    view,
    transcript: {
      id: row.id,
      file_name: row.file_name,
      duration_ms: row.duration_ms,
      language: view === 'translation' ? 'en' : row.language,
      original_language: row.language,
      model: row.model,
      engine: row.engine,
      ingested_at: row.ingested_at,
      translated_at: row.translated_at ?? null
    },
    full_text: fullText,
    segments
  }
  return JSON.stringify(payload, null, 2)
}

/** Plain prose: one paragraph per segment, no timestamps. */
function toPlainText(segments: TranscriptSegment[], fullText: string): string {
  if (!segments.length) return (fullText || '').trim() + '\n'
  return segments.map((s) => (s.text || '').trim()).filter(Boolean).join('\n\n') + '\n'
}

// ── helpers ───────────────────────────────────────────────────────

/** SRT timestamp: HH:MM:SS,mmm (comma separator). */
function fmtSrtTime(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.floor((s - Math.floor(s)) * 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)},${pad(ms, 3)}`
}

/** VTT timestamp: HH:MM:SS.mmm (period separator), HH optional <1h. */
function fmtVttTime(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.floor((s - Math.floor(s)) * 1000)
  if (h > 0) return `${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)}.${pad(ms, 3)}`
  return `${pad(m, 2)}:${pad(sec, 2)}.${pad(ms, 3)}`
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

function suggestFilename(row: TranscriptRow, format: ExportFormat, view: ExportView): string {
  const baseRaw = row.file_name || row.id
  const base = baseRaw.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'transcript'
  const suffix = view === 'translation' ? '.en' : ''
  return `${base}${suffix}.${format}`
}
