// DailyBriefingDiffer — v1.6.3 "what's new since the previous brief".
//
// The senior decision-maker's first question every morning is "what's
// changed since yesterday?". This service answers that programmatically:
//   1. Set-difference on the persisted intel/transcript id arrays —
//      cheap, deterministic, never wrong.
//   2. LLM-generated 1-paragraph delta summary that names the new
//      threads + escalations in plain prose. Cited by id so the
//      analyst can drill back into the underlying material.
//
// No new schema; everything is computed from the existing
// daily_briefings.sources_json + body_md columns.

import log from 'electron-log'
import { llmService } from '../llm/LlmService'
import { dailyBriefingService, type DailyBriefingRow } from './DailyBriefingService'
import { getDatabase } from '../database'

export interface DiffSources {
  intel_ids?: string[]
  transcript_ids?: string[]
  indicator_count?: number
}

export interface BriefingDiff {
  from: { id: string; period_end: number; intel_count: number; high_severity_count: number }
  to:   { id: string; period_end: number; intel_count: number; high_severity_count: number }
  new_intel_ids: string[]
  carried_intel_ids: string[]
  new_transcript_ids: string[]
  carried_transcript_ids: string[]
  high_severity_delta: number
  intel_count_delta: number
  /** LLM-synthesised one-paragraph plain-prose summary of what's new.
   *  Empty string when nothing changed (we never call the LLM in that
   *  case — saving the round-trip + giving the renderer a clean
   *  "no movement" state). */
  summary_md: string
  generated_at: number
}

const DIFF_SYSTEM_PROMPT = `You compare two consecutive Daily Intelligence Briefings and produce a single short paragraph (≤120 words) describing what is genuinely new in the later briefing relative to the earlier one. Rules:
- Cite specific report ids inline as [intel:UUID-PREFIX]; only cite ids that appear in the input lists.
- Use Words of Estimative Probability when forecasting.
- Mark items as **(NEW THREAD)** or **(ESCALATION)** when applicable.
- Output plain markdown, no preamble, no headers — just the paragraph.
- If almost nothing changed, say so plainly. Do not invent novelty.`

export class DailyBriefingDiffer {
  /** Diff briefing `toId` against briefing `fromId`. Both must exist
   *  and have status 'ready'. Empty result when the two share the
   *  same source ids. */
  async diff(fromId: string, toId: string): Promise<BriefingDiff> {
    const from = dailyBriefingService.get(fromId)
    const to = dailyBriefingService.get(toId)
    if (!from) throw new Error(`Briefing not found: ${fromId}`)
    if (!to) throw new Error(`Briefing not found: ${toId}`)
    if (from.id === to.id) throw new Error('Cannot diff a briefing against itself')

    const fromSources = parseSources(from)
    const toSources = parseSources(to)
    const fromIntelSet = new Set(fromSources.intel_ids ?? [])
    const fromTxSet = new Set(fromSources.transcript_ids ?? [])
    const newIntel = (toSources.intel_ids ?? []).filter((id) => !fromIntelSet.has(id))
    const carriedIntel = (toSources.intel_ids ?? []).filter((id) => fromIntelSet.has(id))
    const newTranscript = (toSources.transcript_ids ?? []).filter((id) => !fromTxSet.has(id))
    const carriedTranscript = (toSources.transcript_ids ?? []).filter((id) => fromTxSet.has(id))

    const result: BriefingDiff = {
      from: {
        id: from.id, period_end: from.period_end,
        intel_count: from.intel_count, high_severity_count: from.high_severity_count
      },
      to: {
        id: to.id, period_end: to.period_end,
        intel_count: to.intel_count, high_severity_count: to.high_severity_count
      },
      new_intel_ids: newIntel,
      carried_intel_ids: carriedIntel,
      new_transcript_ids: newTranscript,
      carried_transcript_ids: carriedTranscript,
      high_severity_delta: to.high_severity_count - from.high_severity_count,
      intel_count_delta: to.intel_count - from.intel_count,
      summary_md: '',
      generated_at: Date.now()
    }

    // Skip the LLM round-trip when nothing's new — the renderer shows a
    // "no material change" state and the analyst saves a couple seconds.
    if (newIntel.length === 0 && newTranscript.length === 0 && result.high_severity_delta === 0) {
      result.summary_md = ''
      return result
    }

    try {
      result.summary_md = await this.synthesiseDelta(from, to, newIntel, newTranscript)
    } catch (err) {
      log.warn(`daily-briefing-diff: LLM synthesis failed (${(err as Error).message}); returning structural diff only`)
      result.summary_md = ''
    }

    return result
  }

  /** Quick helper for the UI: find the most recent earlier briefing
   *  (by period_end) that's ready. Returns null on first ever briefing. */
  findPrevious(toId: string): DailyBriefingRow | null {
    const to = dailyBriefingService.get(toId)
    if (!to) return null
    const db = getDatabase()
    return db.prepare(`
      SELECT * FROM daily_briefings
      WHERE period_end < ? AND status = 'ready' AND id != ?
      ORDER BY period_end DESC
      LIMIT 1
    `).get(to.period_end, toId) as DailyBriefingRow | null
  }

  private async synthesiseDelta(
    from: DailyBriefingRow,
    to: DailyBriefingRow,
    newIntel: string[],
    newTranscripts: string[]
  ): Promise<string> {
    // Pull the actual report rows for the LLM to anchor against.
    const db = getDatabase()
    const newIntelRows = newIntel.length > 0
      ? db.prepare(`
          SELECT id, title, severity, discipline FROM intel_reports
          WHERE id IN (${newIntel.map(() => '?').join(',')})
        `).all(...newIntel) as Array<{ id: string; title: string; severity: string; discipline: string }>
      : []
    const newTranscriptRows = newTranscripts.length > 0
      ? db.prepare(`
          SELECT id, file_name, language FROM transcripts
          WHERE id IN (${newTranscripts.map(() => '?').join(',')})
        `).all(...newTranscripts) as Array<{ id: string; file_name: string | null; language: string | null }>
      : []

    const lines: string[] = []
    lines.push(`Earlier briefing: ${new Date(from.period_end).toISOString()} (${from.intel_count} intel, ${from.high_severity_count} high-severity)`)
    lines.push(`Later briefing:   ${new Date(to.period_end).toISOString()} (${to.intel_count} intel, ${to.high_severity_count} high-severity)`)
    lines.push('')
    lines.push(`NEW intel reports (${newIntelRows.length}):`)
    for (const r of newIntelRows.slice(0, 25)) {
      lines.push(`- [intel:${r.id.slice(0, 8)}] (${r.severity}, ${r.discipline}) ${r.title}`)
    }
    if (newTranscriptRows.length > 0) {
      lines.push('')
      lines.push(`NEW transcripts (${newTranscriptRows.length}):`)
      for (const t of newTranscriptRows.slice(0, 10)) {
        lines.push(`- [transcript:${t.id.slice(0, 8)}] (${t.language ?? 'auto'}) ${t.file_name ?? '(unnamed)'}`)
      }
    }
    lines.push('')
    lines.push(`Earlier briefing body (for context):`)
    lines.push(from.body_md ?? '(empty)')
    lines.push('')
    lines.push(`Later briefing body (for context):`)
    lines.push(to.body_md ?? '(empty)')
    lines.push('')
    lines.push('Now write the one-paragraph delta summary.')

    const { response } = await llmService.chatForTask('briefing', [
      { role: 'system', content: DIFF_SYSTEM_PROMPT },
      { role: 'user', content: lines.join('\n') }
    ])
    return (response || '').trim()
  }
}

function parseSources(row: DailyBriefingRow): DiffSources {
  if (!row.sources_json) return {}
  try { return JSON.parse(row.sources_json) as DiffSources } catch { return {} }
}

export const dailyBriefingDiffer = new DailyBriefingDiffer()
