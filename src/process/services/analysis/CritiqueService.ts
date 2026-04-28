// CritiqueService — v1.9.3 red-team / devil's-advocate critique
// surface. Operationalises the IC tradecraft step of deliberately
// arguing against your own conclusion to surface weak assumptions,
// missing alternatives, and cognitive biases.
//
// Workflow:
//   1. Analyst picks a parent artifact (hypothesis, comparison,
//      chronology, briefing) — or supplies a free-form topic.
//   2. createForParent() / createFreeform() inserts the row in
//      'generating' state, kicks off an LLM call asynchronously,
//      and returns the row immediately so the UI can poll.
//   3. The LLM produces structured Markdown (## Weak Assumptions
//      etc.). On completion, status flips to 'ready' or 'error'.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'
import { llmService } from '../llm/LlmService'

export type CritiqueParentKind = 'hypothesis' | 'comparison' | 'chronology' | 'briefing' | 'free'
export type CritiqueStatus = 'generating' | 'ready' | 'error'

export interface CritiqueRow {
  id: string
  parent_kind: CritiqueParentKind
  parent_id: string | null
  parent_label: string | null
  topic_md: string | null
  critique_md: string | null
  status: CritiqueStatus
  error_text: string | null
  model: string | null
  created_at: number
  updated_at: number
}

const SYSTEM_PROMPT = `You are a red-team intelligence analyst. Your job is to deliberately argue against the analytic conclusion you are about to read — not to politely disagree, but to actively expose where the analyst could be wrong.

Output well-structured Markdown with these sections, in order. Skip any section that genuinely does not apply, but do not pad.

## BLUF
One sentence: the strongest single objection.

## Weak Assumptions
Bullet list. For each assumption the analysis depends on, name it explicitly and explain why it is fragile, untested, or culturally biased.

## Alternative Explanations
Bullet list of plausible competing hypotheses the analysis under-weights or ignores.

## Cognitive Biases at Play
Name the bias (anchoring, confirmation, availability, mirror imaging, recency, groupthink, …) and point to the specific judgment it likely contaminated.

## Missing Evidence
What evidence — if it existed — would change the conclusion? What evidence is conspicuously absent?

## Sharpest Counter-Question
One specific, falsifiable question the analyst should answer before publishing.

Tone: rigorous, dispassionate, never sycophantic. Use ICD-203 estimative-probability phrases ("likely", "almost certainly") only where warranted. Do not soften criticisms with hedges.`

const MAX_CONTEXT_CHARS = 12000

function truncate(s: string, max = MAX_CONTEXT_CHARS): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max) + '\n\n[…truncated…]'
}

function renderHypothesisContext(hypothesisId: string): { topic: string; label: string } | null {
  const db = getDatabase()
  const h = db.prepare(`SELECT * FROM hypotheses WHERE id = ?`).get(hypothesisId) as
    | { id: string; name: string; statement: string; status: string; scope_hint: string | null }
    | undefined
  if (!h) return null
  const evidence = db.prepare(`
    SELECT verdict, confidence, reasoning,
           COALESCE(analyst_override, verdict) AS effective_verdict,
           r.title AS report_title, r.source_name AS source_name
    FROM hypothesis_evidence e
    LEFT JOIN intel_reports r ON r.id = e.intel_id
    WHERE e.hypothesis_id = ?
    ORDER BY e.evaluated_at DESC
    LIMIT 30
  `).all(hypothesisId) as Array<{
    verdict: string; confidence: number; reasoning: string | null;
    effective_verdict: string; report_title: string | null; source_name: string | null
  }>

  const lines: string[] = []
  lines.push(`# Hypothesis: ${h.name}`)
  lines.push('')
  lines.push(`**Statement.** ${h.statement}`)
  if (h.scope_hint) lines.push(`\n**Scope.** ${h.scope_hint}`)
  lines.push(`\n**Status.** ${h.status}`)
  lines.push('')
  lines.push(`## Evidence to date (${evidence.length} rows)`)
  for (const e of evidence) {
    lines.push(`- **${e.effective_verdict}** (conf ${(e.confidence * 100).toFixed(0)}%) — ${e.report_title || '[untitled]'} (${e.source_name || 'unknown source'})`)
    if (e.reasoning) lines.push(`  - reasoning: ${e.reasoning.slice(0, 240)}`)
  }
  return { topic: truncate(lines.join('\n')), label: h.name }
}

function renderComparisonContext(comparisonId: string): { topic: string; label: string } | null {
  const db = getDatabase()
  const c = db.prepare(`SELECT * FROM comparative_analyses WHERE id = ?`).get(comparisonId) as
    | { id: string; name: string; kind: string; body_md: string | null; status: string }
    | undefined
  if (!c) return null
  const lines: string[] = []
  lines.push(`# Comparative Analysis: ${c.name}`)
  lines.push(`*kind: ${c.kind}, status: ${c.status}*`)
  lines.push('')
  if (c.body_md) lines.push(c.body_md)
  else lines.push('*(body not yet generated)*')
  return { topic: truncate(lines.join('\n')), label: c.name }
}

function renderChronologyContext(chronologyId: string): { topic: string; label: string } | null {
  const db = getDatabase()
  const c = db.prepare(`SELECT * FROM chronologies WHERE id = ?`).get(chronologyId) as
    | { id: string; name: string; description: string | null; events_json: string }
    | undefined
  if (!c) return null
  let events: Array<{ ts: number; title: string; description?: string | null }> = []
  try {
    const parsed = JSON.parse(c.events_json || '[]')
    if (Array.isArray(parsed)) events = parsed.sort((a, b) => a.ts - b.ts)
  } catch { /* ignore */ }
  const lines: string[] = []
  lines.push(`# Chronology: ${c.name}`)
  if (c.description) lines.push(`\n${c.description}`)
  lines.push(`\n## Events (${events.length})`)
  for (const e of events) {
    const date = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ')
    lines.push(`- **${date}** — ${e.title}`)
    if (e.description) lines.push(`  - ${e.description}`)
  }
  return { topic: truncate(lines.join('\n')), label: c.name }
}

function renderBriefingContext(briefingId: string): { topic: string; label: string } | null {
  const db = getDatabase()
  // Briefings live in two places — daily_briefings (cron-generated)
  // or report_products (analyst-curated reports library). Try daily
  // first, then fall back.
  const b = db.prepare(`SELECT id, period_start, period_end, body_md FROM daily_briefings WHERE id = ?`).get(briefingId) as
    | { id: string; period_start: number; period_end: number; body_md: string | null }
    | undefined
  if (b) {
    const label = `Daily Briefing ${new Date(b.period_start).toISOString().slice(0, 10)} → ${new Date(b.period_end).toISOString().slice(0, 10)}`
    return { topic: truncate(`# ${label}\n\n${b.body_md || ''}`), label }
  }
  const r = db.prepare(`SELECT id, title, body_markdown FROM report_products WHERE id = ?`).get(briefingId) as
    | { id: string; title: string; body_markdown: string | null }
    | undefined
  if (r) {
    return { topic: truncate(`# Report: ${r.title}\n\n${r.body_markdown || ''}`), label: r.title }
  }
  return null
}

function renderParentContext(
  kind: CritiqueParentKind,
  id: string | null
): { topic: string; label: string } | null {
  if (!id) return null
  switch (kind) {
    case 'hypothesis': return renderHypothesisContext(id)
    case 'comparison': return renderComparisonContext(id)
    case 'chronology': return renderChronologyContext(id)
    case 'briefing':   return renderBriefingContext(id)
    default:           return null
  }
}

export class CritiqueService {
  list(limit = 100): CritiqueRow[] {
    return getDatabase().prepare(`
      SELECT * FROM critiques ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as CritiqueRow[]
  }

  listForParent(parent_kind: CritiqueParentKind, parent_id: string): CritiqueRow[] {
    return getDatabase().prepare(`
      SELECT * FROM critiques WHERE parent_kind = ? AND parent_id = ?
      ORDER BY updated_at DESC
    `).all(parent_kind, parent_id) as CritiqueRow[]
  }

  get(id: string): CritiqueRow | null {
    const row = getDatabase().prepare(`SELECT * FROM critiques WHERE id = ?`).get(id) as
      | CritiqueRow
      | undefined
    return row ?? null
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM critiques WHERE id = ?`).run(id)
  }

  /** Kick off a critique against an existing artifact. Returns the
   *  inserted row immediately; the LLM result lands later. */
  async createForParent(args: {
    parent_kind: Exclude<CritiqueParentKind, 'free'>
    parent_id: string
  }): Promise<CritiqueRow> {
    if (!isDatabaseReady()) throw new Error('database not ready')
    const ctx = renderParentContext(args.parent_kind, args.parent_id)
    if (!ctx) throw new Error(`Could not render context for ${args.parent_kind}/${args.parent_id}`)
    return this.runLLM({
      parent_kind: args.parent_kind,
      parent_id: args.parent_id,
      parent_label: ctx.label,
      topic_md: ctx.topic
    })
  }

  /** Kick off a critique against a free-form analyst topic. */
  async createFreeform(args: { topic: string; label?: string }): Promise<CritiqueRow> {
    if (!isDatabaseReady()) throw new Error('database not ready')
    const topic = (args.topic || '').trim()
    if (topic.length < 20) throw new Error('Topic too short — give the red team something to chew on (≥ 20 chars).')
    return this.runLLM({
      parent_kind: 'free',
      parent_id: null,
      parent_label: args.label?.trim() || topic.slice(0, 60),
      topic_md: topic
    })
  }

  private async runLLM(args: {
    parent_kind: CritiqueParentKind
    parent_id: string | null
    parent_label: string
    topic_md: string
  }): Promise<CritiqueRow> {
    const db = getDatabase()
    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO critiques
        (id, parent_kind, parent_id, parent_label, topic_md, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'generating', ?, ?)
    `).run(id, args.parent_kind, args.parent_id, args.parent_label, args.topic_md, now, now)

    // Fire-and-forget — UI polls for completion. Awaiting is fine
    // here because callers either await the inserted row or, more
    // commonly, fire this from a bridge handler that returns the
    // row immediately. The actual await happens inside the bridge
    // callsite which can use either pattern.
    void this.executeCritique(id, args.topic_md)

    return this.get(id)!
  }

  private async executeCritique(id: string, topic_md: string): Promise<void> {
    const db = getDatabase()
    log.info(`critique: generating ${id} (${topic_md.length} chars context)`)
    try {
      const { response, model } = await llmService.chatForTask('analysis', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Critique the following analysis. Be uncomfortable.\n\n${topic_md}` }
      ])
      const body = (response || '').trim()
      if (!body) throw new Error('LLM returned empty critique')
      db.prepare(`
        UPDATE critiques SET status = 'ready', critique_md = ?, model = ?, updated_at = ?
        WHERE id = ?
      `).run(body, model, Date.now(), id)
      log.info(`critique: ${id} ready (${body.length} chars, model=${model})`)
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      db.prepare(`
        UPDATE critiques SET status = 'error', error_text = ?, updated_at = ?
        WHERE id = ?
      `).run(msg, Date.now(), id)
      log.warn(`critique: ${id} failed — ${msg}`)
    }
  }
}

export const critiqueService = new CritiqueService()
