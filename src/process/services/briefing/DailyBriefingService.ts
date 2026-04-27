// DailyBriefingService — v1.6.0 automated end-of-day intel synthesis.
//
// Once a day at the configured time, gathers the last N hours of
// activity across the corpus (intel reports, transcripts, indicator
// hits), prompts the LLM with a structured ICD-203-aligned briefing
// template, and persists the resulting markdown into daily_briefings.
//
// The cron is a thin wrapper over generate() so the same code path
// is exercised by both the scheduled tick and the manual "Generate
// now" button. Failures are caught and recorded in error_text on the
// row — the briefing itself is never thrown away, just marked
// 'error' so the analyst can see what happened.
//
// Data sources gathered per briefing:
//   1. intel_reports created in [period_start, period_end), ranked
//      by severity → recency. Top N (default 30) summarised in the
//      LLM prompt.
//   2. transcripts ingested in window. Top N (default 10) — each
//      contributes a short hint with file_name + duration + segment
//      count. Full text is too long for the prompt.
//   3. indicator_hits in window (when the table exists), grouped by
//      indicator. Helps the LLM call out actively-firing watchlist
//      items.
//   4. severity histogram + top-N entities via existing
//      BriefingService.snapshot().

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'
import { settingsService } from '../settings/SettingsService'
import { cronService } from '../cron/CronService'
import { llmService } from '../llm/LlmService'

export interface DailyBriefingRow {
  id: string
  period_start: number
  period_end: number
  generated_at: number
  status: 'generating' | 'ready' | 'error'
  classification: string
  model: string | null
  intel_count: number
  transcript_count: number
  high_severity_count: number
  body_md: string | null
  sources_json: string | null
  error_text: string | null
}

interface IntelLite {
  id: string
  title: string
  discipline: string
  severity: string
  source_name: string | null
  summary: string | null
  created_at: number
}

interface TranscriptLite {
  id: string
  file_name: string | null
  duration_ms: number | null
  language: string | null
  full_text: string | null
  ingested_at: number
}

const SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 }
const DEFAULT_LOOKBACK_HOURS = 24
const MAX_INTEL_IN_PROMPT = 30
const MAX_TRANSCRIPTS_IN_PROMPT = 10
const MAX_TRANSCRIPT_TEXT = 600    // chars per transcript hint
const DEFAULT_CRON = '0 17 * * *'  // 17:00 daily

const SYSTEM_PROMPT = `You are an intelligence analyst writing a structured Daily Intelligence Briefing in ICD-203 style for a senior decision-maker.

Output strict markdown. Sections, in order:

  # Daily Intelligence Briefing — {{period}}
  **CLASSIFICATION:** {{classification}}
  **PERIOD:** {{period}}
  **PRODUCED:** {{produced_at}}

  ## Bottom Line Up Front (BLUF)
  3-5 sentences. The single most important thing the reader needs to know. Use Words of Estimative Probability (almost certainly / highly likely / likely / roughly even chance / unlikely / very unlikely / almost no chance) when forecasting. Cite specific report ids inline as [intel:UUID-PREFIX].

  ## Key Developments (last {{lookback}}h)
  Bulleted list of 4-8 items. Each item: 1-2 sentences + a citation. Group thematically — kinetic events, cyber, financial, geopolitical. Mark items as **(NEW)** or **(ESCALATING)** when applicable.

  ## Indicators & Warning
  Watch-listed indicators that fired in window. If none, write "Nothing fired in window" — do NOT make any up.

  ## Source Reliability Caveats
  Note any items resting on single-source / unverified / low-credibility reporting. Be explicit; do not soften.

  ## Open Gaps & Pending Collection
  What we still don't know. Collection requirements the analyst should prioritize tomorrow.

Rules:
  · Never fabricate report ids. Only cite ids that appear in the input.
  · Never hallucinate intel that wasn't in the input — silence is correct when the period was quiet.
  · Use neutral, evidence-grounded language. No editorialising.
  · Keep total length ≤ 800 words.`

export class DailyBriefingService {
  private cronId = 'daily-briefing'
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    const cronExpr = settingsService.get<string>('briefing.dailyCron') || DEFAULT_CRON
    cronService.schedule(this.cronId, cronExpr, 'Daily intelligence briefing', async () => {
      const enabled = settingsService.get<boolean>('briefing.dailyEnabled') === true
      if (!enabled) return
      await this.generate({}).catch((err) =>
        log.warn(`daily-briefing: cron tick failed: ${(err as Error).message}`)
      )
    })
  }

  stop(): void {
    if (!this.started) return
    cronService.unschedule(this.cronId)
    this.started = false
  }

  /** Generate one briefing covering [now-lookbackHours, now). The
   *  inserted row is returned with status='generating' immediately,
   *  then updated when the LLM call completes. The renderer can
   *  poll get(id) to watch the state transition. */
  async generate(opts: { lookbackHours?: number; classification?: string }): Promise<DailyBriefingRow> {
    if (!isDatabaseReady()) throw new Error('database not ready')
    const lookbackHours = opts.lookbackHours
      ?? settingsService.get<number>('briefing.lookbackHours')
      ?? DEFAULT_LOOKBACK_HOURS
    const classification = opts.classification
      ?? settingsService.get<string>('briefing.classification')
      ?? 'UNCLASSIFIED'

    const now = Date.now()
    const periodStart = now - lookbackHours * 60 * 60 * 1000
    const id = generateId()
    const db = getDatabase()

    db.prepare(`
      INSERT INTO daily_briefings
        (id, period_start, period_end, generated_at, status, classification,
         intel_count, transcript_count, high_severity_count)
      VALUES (?, ?, ?, ?, 'generating', ?, 0, 0, 0)
    `).run(id, periodStart, now, now, classification)

    // Gather context — these are tiny, safe to do synchronously.
    const intel = this.fetchIntelInWindow(periodStart, now)
    const transcripts = this.fetchTranscriptsInWindow(periodStart, now)
    const indicators = this.fetchIndicatorHitsInWindow(periodStart, now)
    const highSev = intel.filter((r) => r.severity === 'critical' || r.severity === 'high').length

    log.info(`daily-briefing: generating ${id} — ${intel.length} intel, ${transcripts.length} transcripts, ${highSev} high-severity`)

    db.prepare(`
      UPDATE daily_briefings
      SET intel_count = ?, transcript_count = ?, high_severity_count = ?
      WHERE id = ?
    `).run(intel.length, transcripts.length, highSev, id)

    // Build the LLM prompt
    const prompt = buildPrompt({ periodStart, now, lookbackHours, classification, intel, transcripts, indicators })
    const sources = {
      intel_ids: intel.slice(0, MAX_INTEL_IN_PROMPT).map((r) => r.id),
      transcript_ids: transcripts.slice(0, MAX_TRANSCRIPTS_IN_PROMPT).map((r) => r.id),
      indicator_count: indicators.length
    }
    db.prepare(`UPDATE daily_briefings SET sources_json = ? WHERE id = ?`).run(JSON.stringify(sources), id)

    try {
      // chatForTask takes system+user messages so the structured ICD-203
      // template lives in the system role where the model treats it as
      // formatting rules rather than payload to summarise.
      const { response, model } = await llmService.chatForTask('briefing', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ])
      const cleanBody = (response || '').trim()
      if (!cleanBody) throw new Error('LLM returned empty body')
      db.prepare(`
        UPDATE daily_briefings
        SET status = 'ready', body_md = ?, model = ?
        WHERE id = ?
      `).run(cleanBody, model, id)
      log.info(`daily-briefing: ${id} ready (${cleanBody.length} chars, model=${model})`)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      db.prepare(`
        UPDATE daily_briefings
        SET status = 'error', error_text = ?
        WHERE id = ?
      `).run(msg, id)
      log.warn(`daily-briefing: ${id} failed — ${msg}`)
    }

    return this.get(id)!
  }

  get(id: string): DailyBriefingRow | null {
    return getDatabase().prepare(`
      SELECT * FROM daily_briefings WHERE id = ?
    `).get(id) as DailyBriefingRow | null
  }

  list(limit = 50): DailyBriefingRow[] {
    return getDatabase().prepare(`
      SELECT * FROM daily_briefings ORDER BY period_end DESC LIMIT ?
    `).all(limit) as DailyBriefingRow[]
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM daily_briefings WHERE id = ?`).run(id)
  }

  // ── data gatherers ────────────────────────────────────────────────

  private fetchIntelInWindow(start: number, end: number): IntelLite[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, title, discipline, severity, source_name, summary, created_at
      FROM intel_reports
      WHERE created_at >= ? AND created_at < ?
        AND COALESCE(quarantined, 0) = 0
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3
          WHEN 'low' THEN 2 ELSE 1
        END DESC,
        created_at DESC
      LIMIT 200
    `).all(start, end) as IntelLite[]
  }

  private fetchTranscriptsInWindow(start: number, end: number): TranscriptLite[] {
    const db = getDatabase()
    try {
      return db.prepare(`
        SELECT id, file_name, duration_ms, language, full_text, ingested_at
        FROM transcripts
        WHERE ingested_at >= ? AND ingested_at < ?
        ORDER BY ingested_at DESC
        LIMIT 50
      `).all(start, end) as TranscriptLite[]
    } catch { return [] }
  }

  private fetchIndicatorHitsInWindow(start: number, end: number): Array<{ indicator: string; count: number }> {
    const db = getDatabase()
    try {
      return db.prepare(`
        SELECT matched_text AS indicator, COUNT(*) AS count
        FROM indicator_hits
        WHERE observed_at >= ? AND observed_at < ?
        GROUP BY matched_text
        ORDER BY count DESC
        LIMIT 25
      `).all(start, end) as Array<{ indicator: string; count: number }>
    } catch { return [] }
  }
}

// ── prompt builder ──────────────────────────────────────────────────

function buildPrompt(args: {
  periodStart: number
  now: number
  lookbackHours: number
  classification: string
  intel: IntelLite[]
  transcripts: TranscriptLite[]
  indicators: Array<{ indicator: string; count: number }>
}): string {
  const lines: string[] = []
  const startStr = new Date(args.periodStart).toISOString()
  const endStr = new Date(args.now).toISOString()
  lines.push(`Period: ${startStr} → ${endStr} (${args.lookbackHours}h window)`)
  lines.push(`Classification: ${args.classification}`)
  lines.push(`Generated: ${endStr}`)
  lines.push('')

  // Severity histogram for the LLM to ground its tone
  const sev: Record<string, number> = {}
  for (const r of args.intel) sev[r.severity] = (sev[r.severity] ?? 0) + 1
  lines.push(`Severity histogram (n=${args.intel.length}): ${
    Object.entries(sev).map(([k, v]) => `${k}=${v}`).join(', ') || 'empty'
  }`)
  lines.push('')

  // Intel reports
  lines.push(`## INTEL_REPORTS (top ${Math.min(args.intel.length, MAX_INTEL_IN_PROMPT)} by severity → recency)`)
  for (const r of args.intel.slice(0, MAX_INTEL_IN_PROMPT)) {
    const idShort = r.id.slice(0, 8)
    const summary = (r.summary ?? '').slice(0, 240).replace(/\s+/g, ' ').trim()
    lines.push(`- [intel:${idShort}] (${r.severity}, ${r.discipline}, ${r.source_name ?? 'unknown'}) ${r.title}`)
    if (summary) lines.push(`  ${summary}`)
  }
  lines.push('')

  // Transcripts
  if (args.transcripts.length > 0) {
    lines.push(`## TRANSCRIPTS (${args.transcripts.length} ingested in window, top ${Math.min(args.transcripts.length, MAX_TRANSCRIPTS_IN_PROMPT)})`)
    for (const t of args.transcripts.slice(0, MAX_TRANSCRIPTS_IN_PROMPT)) {
      const idShort = t.id.slice(0, 8)
      const dur = t.duration_ms ? `${Math.round(t.duration_ms / 1000)}s` : '—'
      const text = (t.full_text ?? '').slice(0, MAX_TRANSCRIPT_TEXT).replace(/\s+/g, ' ').trim()
      lines.push(`- [transcript:${idShort}] (${dur}, ${t.language ?? 'auto'}) ${t.file_name ?? '(unnamed)'}`)
      if (text) lines.push(`  "${text}${(t.full_text ?? '').length > MAX_TRANSCRIPT_TEXT ? '…' : ''}"`)
    }
    lines.push('')
  }

  // Indicator hits
  if (args.indicators.length > 0) {
    lines.push(`## INDICATOR_HITS (${args.indicators.length} indicators fired in window)`)
    for (const i of args.indicators) {
      lines.push(`- "${i.indicator.slice(0, 80)}" — ${i.count} hit${i.count > 1 ? 's' : ''}`)
    }
    lines.push('')
  }

  lines.push(`Now write the briefing. Lookback: ${args.lookbackHours}h. Classification line: ${args.classification}. Period label: "${new Date(args.periodStart).toLocaleDateString()} → ${new Date(args.now).toLocaleDateString()}".`)
  return lines.join('\n')
}

export const dailyBriefingService = new DailyBriefingService()
