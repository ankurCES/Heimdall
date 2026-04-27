// ComparativeAnalysisService — v1.9.0 Phase 10 opener.
//
// Two analyst-chosen subjects in, one structured side-by-side report
// out. Two flavours:
//
//   compareEntities(leftId, rightId)
//     · Pulls the most recent intel mentions for each canonical
//       (deterministic via intel_entities.canonical_id) and a
//       severity histogram per side.
//     · LLM is fed the two halves and asked to produce a
//       side-by-side report: shared themes, divergences, escalation
//       direction, intel-grounded forecast. ICD-203 WEP language
//       enforced; cite-only-real-ids rule.
//
//   compareTimeWindows(periodA, periodB)
//     · Same pattern but each side is a time slice of the whole
//       intel corpus. Useful for quarterly reviews or before/after
//       analysis around a specific event.
//
// Status flow: 'generating' → 'ready' on success, 'error' on
// failure with the error stored in error_text. The list/detail UIs
// poll the row by id while it's generating; failures are never
// silently dropped.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'
import { llmService } from '../llm/LlmService'

export interface ComparativeAnalysisRow {
  id: string
  name: string
  kind: 'entities' | 'time_windows'
  left_subject_json: string
  right_subject_json: string
  status: 'generating' | 'ready' | 'error'
  model: string | null
  body_md: string | null
  sources_json: string | null
  error_text: string | null
  generated_at: number
  updated_at: number
}

export interface EntitySubject { canonical_id: string }
export interface TimeWindowSubject { start: number; end: number; label?: string }

interface IntelLite {
  id: string
  title: string
  discipline: string
  severity: string
  source_name: string | null
  summary: string | null
  created_at: number
}

const MAX_INTEL_PER_SIDE = 25
const MIN_PROMPT_INTEL_PER_SIDE = 1   // refuse comparison when both sides are empty

const SYSTEM_PROMPT = `You are an intelligence analyst writing a structured side-by-side comparative analysis. Output strict markdown.

Sections, in order:

  # Comparative Analysis: {{left_label}} vs {{right_label}}
  **Period:** {{period}}
  **Produced:** {{produced_at}}

  ## Bottom Line Up Front (BLUF)
  3-5 sentences. The single most important divergence the reader needs to know. Use Words of Estimative Probability (almost certainly / highly likely / likely / roughly even chance / unlikely / very unlikely / almost no chance) when forecasting. Cite specific report ids inline as [intel:UUID-PREFIX].

  ## Shared Themes
  Bulleted list of patterns that appear on BOTH sides. Each item: 1-2 sentences + citations from each side.

  ## Divergences
  Bulleted list of patterns that appear on ONE side but not the other. Each item: which side, what's distinctive, citation.

  ## Trajectory
  One paragraph. Which side appears to be escalating, plateauing, or declining; what the underlying drivers are. Use WEP language.

  ## Open Questions
  3-5 collection requirements that would resolve the ambiguities.

Rules:
  · Never fabricate report ids. Only cite ids that appear in the input lists.
  · Never invent intel that wasn't in the input — silence is correct when one side is quiet.
  · Use neutral, evidence-grounded language. No editorialising.
  · Keep total length ≤ 700 words.`

export class ComparativeAnalysisService {
  list(limit = 50): ComparativeAnalysisRow[] {
    return getDatabase().prepare(`
      SELECT * FROM comparative_analyses ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as ComparativeAnalysisRow[]
  }

  get(id: string): ComparativeAnalysisRow | null {
    return getDatabase().prepare(`SELECT * FROM comparative_analyses WHERE id = ?`).get(id) as ComparativeAnalysisRow | null
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM comparative_analyses WHERE id = ?`).run(id)
  }

  /** Compare two canonical entities. Builds the per-side context
   *  from intel_entities → intel_reports + a severity histogram,
   *  then asks the LLM for a structured report. */
  async compareEntities(args: {
    leftCanonicalId: string
    rightCanonicalId: string
    name?: string
  }): Promise<ComparativeAnalysisRow> {
    if (!isDatabaseReady()) throw new Error('database not ready')
    if (args.leftCanonicalId === args.rightCanonicalId) {
      throw new Error('Cannot compare an entity with itself')
    }
    const db = getDatabase()
    const left = this.lookupCanonical(args.leftCanonicalId)
    const right = this.lookupCanonical(args.rightCanonicalId)
    if (!left) throw new Error(`Left canonical not found: ${args.leftCanonicalId}`)
    if (!right) throw new Error(`Right canonical not found: ${args.rightCanonicalId}`)

    const leftIntel = this.fetchEntityIntel(args.leftCanonicalId)
    const rightIntel = this.fetchEntityIntel(args.rightCanonicalId)
    if (leftIntel.length < MIN_PROMPT_INTEL_PER_SIDE && rightIntel.length < MIN_PROMPT_INTEL_PER_SIDE) {
      throw new Error('Neither entity has any intel mentions to compare. Try resolving entities first.')
    }

    const id = generateId()
    const now = Date.now()
    const subjectLeft: EntitySubject = { canonical_id: args.leftCanonicalId }
    const subjectRight: EntitySubject = { canonical_id: args.rightCanonicalId }
    const name = args.name ?? `${left.canonical_value} vs ${right.canonical_value}`

    db.prepare(`
      INSERT INTO comparative_analyses
        (id, name, kind, left_subject_json, right_subject_json, status, generated_at, updated_at)
      VALUES (?, ?, 'entities', ?, ?, 'generating', ?, ?)
    `).run(id, name, JSON.stringify(subjectLeft), JSON.stringify(subjectRight), now, now)

    const sources = {
      left_canonical_id: args.leftCanonicalId,
      left_canonical_value: left.canonical_value,
      right_canonical_id: args.rightCanonicalId,
      right_canonical_value: right.canonical_value,
      left_intel_ids: leftIntel.slice(0, MAX_INTEL_PER_SIDE).map((r) => r.id),
      right_intel_ids: rightIntel.slice(0, MAX_INTEL_PER_SIDE).map((r) => r.id)
    }
    db.prepare(`UPDATE comparative_analyses SET sources_json = ? WHERE id = ?`).run(JSON.stringify(sources), id)

    const prompt = buildEntityPrompt({
      left, right, leftIntel, rightIntel
    })

    log.info(`comparative-analysis: generating entities ${id} — ${left.canonical_value} (${leftIntel.length} intel) vs ${right.canonical_value} (${rightIntel.length} intel)`)

    try {
      const { response, model } = await llmService.chatForTask('analysis', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ])
      const cleanBody = (response || '').trim()
      if (!cleanBody) throw new Error('LLM returned empty body')
      db.prepare(`
        UPDATE comparative_analyses
        SET status = 'ready', body_md = ?, model = ?, updated_at = ?
        WHERE id = ?
      `).run(cleanBody, model, Date.now(), id)
      log.info(`comparative-analysis: ${id} ready (${cleanBody.length} chars, model=${model})`)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      db.prepare(`
        UPDATE comparative_analyses
        SET status = 'error', error_text = ?, updated_at = ?
        WHERE id = ?
      `).run(msg, Date.now(), id)
      log.warn(`comparative-analysis: ${id} failed — ${msg}`)
    }

    return this.get(id)!
  }

  /** Compare two time windows of the whole intel corpus. */
  async compareTimeWindows(args: {
    leftWindow: TimeWindowSubject
    rightWindow: TimeWindowSubject
    name?: string
  }): Promise<ComparativeAnalysisRow> {
    if (!isDatabaseReady()) throw new Error('database not ready')
    if (args.leftWindow.end <= args.leftWindow.start) throw new Error('Left window has zero or negative span')
    if (args.rightWindow.end <= args.rightWindow.start) throw new Error('Right window has zero or negative span')

    const db = getDatabase()
    const leftIntel = this.fetchWindowIntel(args.leftWindow.start, args.leftWindow.end)
    const rightIntel = this.fetchWindowIntel(args.rightWindow.start, args.rightWindow.end)
    if (leftIntel.length === 0 && rightIntel.length === 0) {
      throw new Error('Both time windows are empty.')
    }

    const id = generateId()
    const now = Date.now()
    const leftLabel = args.leftWindow.label ?? `${new Date(args.leftWindow.start).toLocaleDateString()} → ${new Date(args.leftWindow.end).toLocaleDateString()}`
    const rightLabel = args.rightWindow.label ?? `${new Date(args.rightWindow.start).toLocaleDateString()} → ${new Date(args.rightWindow.end).toLocaleDateString()}`
    const name = args.name ?? `${leftLabel} vs ${rightLabel}`

    db.prepare(`
      INSERT INTO comparative_analyses
        (id, name, kind, left_subject_json, right_subject_json, status, generated_at, updated_at)
      VALUES (?, ?, 'time_windows', ?, ?, 'generating', ?, ?)
    `).run(id,
      name,
      JSON.stringify({ ...args.leftWindow, label: leftLabel }),
      JSON.stringify({ ...args.rightWindow, label: rightLabel }),
      now, now
    )

    const sources = {
      left_window: { ...args.leftWindow, label: leftLabel },
      right_window: { ...args.rightWindow, label: rightLabel },
      left_intel_ids: leftIntel.slice(0, MAX_INTEL_PER_SIDE).map((r) => r.id),
      right_intel_ids: rightIntel.slice(0, MAX_INTEL_PER_SIDE).map((r) => r.id)
    }
    db.prepare(`UPDATE comparative_analyses SET sources_json = ? WHERE id = ?`).run(JSON.stringify(sources), id)

    const prompt = buildTimeWindowPrompt({
      leftLabel, rightLabel, leftIntel, rightIntel
    })

    log.info(`comparative-analysis: generating time_windows ${id} — ${leftLabel} (${leftIntel.length}) vs ${rightLabel} (${rightIntel.length})`)

    try {
      const { response, model } = await llmService.chatForTask('analysis', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ])
      const cleanBody = (response || '').trim()
      if (!cleanBody) throw new Error('LLM returned empty body')
      db.prepare(`
        UPDATE comparative_analyses
        SET status = 'ready', body_md = ?, model = ?, updated_at = ?
        WHERE id = ?
      `).run(cleanBody, model, Date.now(), id)
      log.info(`comparative-analysis: ${id} ready (${cleanBody.length} chars, model=${model})`)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      db.prepare(`
        UPDATE comparative_analyses
        SET status = 'error', error_text = ?, updated_at = ?
        WHERE id = ?
      `).run(msg, Date.now(), id)
      log.warn(`comparative-analysis: ${id} failed — ${msg}`)
    }

    return this.get(id)!
  }

  // ── helpers ───────────────────────────────────────────────────────

  private lookupCanonical(canonicalId: string): { id: string; entity_type: string; canonical_value: string } | null {
    return getDatabase().prepare(`
      SELECT id, entity_type, canonical_value FROM canonical_entities WHERE id = ?
    `).get(canonicalId) as { id: string; entity_type: string; canonical_value: string } | null
  }

  private fetchEntityIntel(canonicalId: string): IntelLite[] {
    return getDatabase().prepare(`
      SELECT DISTINCT
        r.id, r.title, r.discipline, r.severity, r.source_name, r.summary, r.created_at
      FROM intel_entities e
      JOIN intel_reports r ON r.id = e.report_id
      WHERE e.canonical_id = ? AND COALESCE(r.quarantined, 0) = 0
      ORDER BY
        CASE r.severity
          WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3
          WHEN 'low' THEN 2 ELSE 1
        END DESC,
        r.created_at DESC
      LIMIT 100
    `).all(canonicalId) as IntelLite[]
  }

  private fetchWindowIntel(start: number, end: number): IntelLite[] {
    return getDatabase().prepare(`
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
}

// ── prompt builders ──────────────────────────────────────────────────

function intelHistogram(rows: IntelLite[]): string {
  const sev: Record<string, number> = {}
  for (const r of rows) sev[r.severity] = (sev[r.severity] ?? 0) + 1
  return Object.entries(sev).map(([k, v]) => `${k}=${v}`).join(', ') || 'empty'
}

function dumpIntel(rows: IntelLite[], cap: number): string[] {
  const out: string[] = []
  for (const r of rows.slice(0, cap)) {
    const idShort = r.id.slice(0, 8)
    const summary = (r.summary ?? '').slice(0, 200).replace(/\s+/g, ' ').trim()
    out.push(`- [intel:${idShort}] (${r.severity}, ${r.discipline}, ${r.source_name ?? 'unknown'}) ${r.title}`)
    if (summary) out.push(`  ${summary}`)
  }
  return out
}

function buildEntityPrompt(args: {
  left: { canonical_value: string; entity_type: string }
  right: { canonical_value: string; entity_type: string }
  leftIntel: IntelLite[]
  rightIntel: IntelLite[]
}): string {
  const lines: string[] = []
  lines.push(`Comparison: entities`)
  lines.push(`Left:  "${args.left.canonical_value}" (${args.left.entity_type}) — ${args.leftIntel.length} intel mention(s)`)
  lines.push(`Right: "${args.right.canonical_value}" (${args.right.entity_type}) — ${args.rightIntel.length} intel mention(s)`)
  lines.push('')
  lines.push(`Left severity histogram: ${intelHistogram(args.leftIntel)}`)
  lines.push(`Right severity histogram: ${intelHistogram(args.rightIntel)}`)
  lines.push('')
  lines.push(`## LEFT_INTEL (top ${Math.min(args.leftIntel.length, MAX_INTEL_PER_SIDE)})`)
  lines.push(...dumpIntel(args.leftIntel, MAX_INTEL_PER_SIDE))
  lines.push('')
  lines.push(`## RIGHT_INTEL (top ${Math.min(args.rightIntel.length, MAX_INTEL_PER_SIDE)})`)
  lines.push(...dumpIntel(args.rightIntel, MAX_INTEL_PER_SIDE))
  lines.push('')
  lines.push(`Now write the comparative report.`)
  lines.push(`Left label: "${args.left.canonical_value}". Right label: "${args.right.canonical_value}".`)
  lines.push(`Period: based on the timestamps in the intel above.`)
  return lines.join('\n')
}

function buildTimeWindowPrompt(args: {
  leftLabel: string
  rightLabel: string
  leftIntel: IntelLite[]
  rightIntel: IntelLite[]
}): string {
  const lines: string[] = []
  lines.push(`Comparison: time windows`)
  lines.push(`Left window:  "${args.leftLabel}" — ${args.leftIntel.length} intel report(s)`)
  lines.push(`Right window: "${args.rightLabel}" — ${args.rightIntel.length} intel report(s)`)
  lines.push('')
  lines.push(`Left severity histogram: ${intelHistogram(args.leftIntel)}`)
  lines.push(`Right severity histogram: ${intelHistogram(args.rightIntel)}`)
  lines.push('')
  lines.push(`## LEFT_INTEL (top ${Math.min(args.leftIntel.length, MAX_INTEL_PER_SIDE)})`)
  lines.push(...dumpIntel(args.leftIntel, MAX_INTEL_PER_SIDE))
  lines.push('')
  lines.push(`## RIGHT_INTEL (top ${Math.min(args.rightIntel.length, MAX_INTEL_PER_SIDE)})`)
  lines.push(...dumpIntel(args.rightIntel, MAX_INTEL_PER_SIDE))
  lines.push('')
  lines.push(`Now write the comparative report.`)
  lines.push(`Left label: "${args.leftLabel}". Right label: "${args.rightLabel}".`)
  return lines.join('\n')
}

export const comparativeAnalysisService = new ComparativeAnalysisService()
