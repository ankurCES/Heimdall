// KacService — v1.9.4 Key Assumptions Check workspace.
//
// IC structured analytic technique: list every assumption an
// analysis depends on, then mark each as well-supported, supported
// with caveats, unsupported, or vulnerable to inversion.
//
// In addition to manual entry, the service can call the LLM to
// extract candidate assumptions from an existing artifact (parent
// hypothesis/comparison/chronology/briefing) which the analyst then
// reviews and tests one by one.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'
import { llmService } from '../llm/LlmService'

export type KacParentKind = 'hypothesis' | 'comparison' | 'chronology' | 'briefing' | null
export type KacItemStatus = 'well_supported' | 'supported_caveats' | 'unsupported' | 'vulnerable'

export interface AssumptionCheck {
  id: string
  name: string
  context: string | null
  parent_kind: KacParentKind
  parent_id: string | null
  parent_label: string | null
  created_at: number
  updated_at: number
}

export interface AssumptionItem {
  id: string
  check_id: string
  assumption_text: string
  status: KacItemStatus
  rationale: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

export interface AssumptionCheckWithItems extends AssumptionCheck {
  items: AssumptionItem[]
  /** Aggregate counts by status for badge rendering. */
  counts: Record<KacItemStatus, number>
}

const EXTRACT_SYSTEM_PROMPT = `You are an intelligence tradecraft assistant. Read the analytic artifact below and extract every load-bearing assumption it depends on — the things that, if false, would invalidate the conclusion.

Return a JSON array, one object per assumption:
[
  { "assumption": "<single sentence, atomic, falsifiable phrasing>", "rationale": "<one sentence on why this is an assumption rather than a fact>" }
]

Rules:
- Atomic: one assumption per object. Don't bundle.
- Surface unstated assumptions, not just stated ones.
- 5–10 items is typical. Don't pad with weak ones.
- Output ONLY the JSON array, nothing else.`

function parseAssumptionsJson(raw: string): Array<{ assumption: string; rationale: string }> {
  if (!raw) return []
  // Strip markdown fences if any.
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  // Try to extract the first balanced array.
  const start = cleaned.indexOf('[')
  if (start === -1) return []
  let depth = 0, end = -1
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '[') depth++
    else if (cleaned[i] === ']') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end === -1) return []
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr
      .filter((o) => o && typeof o.assumption === 'string')
      .map((o) => ({ assumption: o.assumption.trim(), rationale: (o.rationale || '').trim() }))
      .filter((o) => o.assumption.length >= 8)
  } catch {
    return []
  }
}

function renderParentContext(kind: KacParentKind, id: string | null): { context: string; label: string } | null {
  if (!kind || !id) return null
  const db = getDatabase()
  if (kind === 'hypothesis') {
    const h = db.prepare(`SELECT name, statement, scope_hint FROM hypotheses WHERE id = ?`).get(id) as
      | { name: string; statement: string; scope_hint: string | null } | undefined
    if (!h) return null
    return {
      context: `Hypothesis: ${h.name}\n\nStatement: ${h.statement}${h.scope_hint ? `\n\nScope: ${h.scope_hint}` : ''}`,
      label: h.name
    }
  }
  if (kind === 'comparison') {
    const c = db.prepare(`SELECT name, body_md FROM comparative_analyses WHERE id = ?`).get(id) as
      | { name: string; body_md: string | null } | undefined
    if (!c) return null
    return {
      context: `Comparative Analysis: ${c.name}\n\n${c.body_md || '(body not yet generated)'}`.slice(0, 12000),
      label: c.name
    }
  }
  if (kind === 'chronology') {
    const c = db.prepare(`SELECT name, description, events_json FROM chronologies WHERE id = ?`).get(id) as
      | { name: string; description: string | null; events_json: string } | undefined
    if (!c) return null
    let events: Array<{ ts: number; title: string; description?: string | null }> = []
    try {
      const parsed = JSON.parse(c.events_json || '[]')
      if (Array.isArray(parsed)) events = parsed.sort((a, b) => a.ts - b.ts)
    } catch { /* ignore */ }
    const eventLines = events
      .map((e) => `- ${new Date(e.ts).toISOString().slice(0, 16)} — ${e.title}${e.description ? `: ${e.description}` : ''}`)
      .join('\n')
    return {
      context: `Chronology: ${c.name}\n${c.description ? `\n${c.description}\n` : ''}\nEvents:\n${eventLines}`.slice(0, 12000),
      label: c.name
    }
  }
  if (kind === 'briefing') {
    const b = db.prepare(`SELECT id, period_start, period_end, body_md FROM daily_briefings WHERE id = ?`).get(id) as
      | { id: string; period_start: number; period_end: number; body_md: string | null } | undefined
    if (b) {
      const label = `Briefing ${new Date(b.period_start).toISOString().slice(0, 10)}`
      return { context: `${label}\n\n${b.body_md || ''}`.slice(0, 12000), label }
    }
    const r = db.prepare(`SELECT title, body_markdown FROM report_products WHERE id = ?`).get(id) as
      | { title: string; body_markdown: string | null } | undefined
    if (r) return { context: `Report: ${r.title}\n\n${r.body_markdown || ''}`.slice(0, 12000), label: r.title }
  }
  return null
}

function loadCheckRow(id: string): AssumptionCheck | null {
  const row = getDatabase().prepare(`SELECT * FROM assumption_checks WHERE id = ?`).get(id) as
    | AssumptionCheck | undefined
  return row ?? null
}

function loadItems(checkId: string): AssumptionItem[] {
  return getDatabase()
    .prepare(`SELECT * FROM assumption_check_items WHERE check_id = ? ORDER BY sort_order, created_at`)
    .all(checkId) as AssumptionItem[]
}

function aggregateCounts(items: AssumptionItem[]): Record<KacItemStatus, number> {
  const out: Record<KacItemStatus, number> = {
    well_supported: 0, supported_caveats: 0, unsupported: 0, vulnerable: 0
  }
  for (const it of items) {
    if (out[it.status] != null) out[it.status]++
  }
  return out
}

function hydrate(row: AssumptionCheck): AssumptionCheckWithItems {
  const items = loadItems(row.id)
  return { ...row, items, counts: aggregateCounts(items) }
}

export class KacService {
  list(): AssumptionCheckWithItems[] {
    const rows = getDatabase()
      .prepare(`SELECT * FROM assumption_checks ORDER BY updated_at DESC`)
      .all() as AssumptionCheck[]
    return rows.map(hydrate)
  }

  listForParent(parent_kind: NonNullable<KacParentKind>, parent_id: string): AssumptionCheckWithItems[] {
    const rows = getDatabase()
      .prepare(`SELECT * FROM assumption_checks WHERE parent_kind = ? AND parent_id = ? ORDER BY updated_at DESC`)
      .all(parent_kind, parent_id) as AssumptionCheck[]
    return rows.map(hydrate)
  }

  get(id: string): AssumptionCheckWithItems | null {
    const row = loadCheckRow(id)
    return row ? hydrate(row) : null
  }

  create(args: {
    name: string
    context?: string | null
    parent_kind?: KacParentKind
    parent_id?: string | null
  }): AssumptionCheckWithItems {
    if (!isDatabaseReady()) throw new Error('database not ready')
    const id = generateId()
    const now = Date.now()
    let parent_label: string | null = null
    if (args.parent_kind && args.parent_id) {
      const ctx = renderParentContext(args.parent_kind, args.parent_id)
      if (ctx) parent_label = ctx.label
    }
    getDatabase().prepare(`
      INSERT INTO assumption_checks (id, name, context, parent_kind, parent_id, parent_label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, args.name.trim(), (args.context ?? '').trim() || null,
      args.parent_kind ?? null, args.parent_id ?? null, parent_label,
      now, now
    )
    log.info(`kac: created ${id} "${args.name}"`)
    return this.get(id)!
  }

  update(id: string, patch: { name?: string; context?: string | null }): AssumptionCheckWithItems | null {
    const cur = loadCheckRow(id)
    if (!cur) return null
    const name = patch.name !== undefined ? patch.name.trim() : cur.name
    const context = patch.context !== undefined ? (patch.context?.trim() || null) : cur.context
    getDatabase().prepare(`
      UPDATE assumption_checks SET name = ?, context = ?, updated_at = ? WHERE id = ?
    `).run(name, context, Date.now(), id)
    return this.get(id)
  }

  remove(id: string): void {
    const db = getDatabase()
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM assumption_check_items WHERE check_id = ?`).run(id)
      db.prepare(`DELETE FROM assumption_checks WHERE id = ?`).run(id)
    })
    tx()
  }

  // ── Items ────────────────────────────────────────────────────────

  addItem(checkId: string, args: {
    assumption_text: string
    status?: KacItemStatus
    rationale?: string | null
  }): AssumptionItem {
    const id = generateId()
    const now = Date.now()
    const db = getDatabase()
    const maxSort = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM assumption_check_items WHERE check_id = ?`).get(checkId) as { m: number }).m
    db.prepare(`
      INSERT INTO assumption_check_items
        (id, check_id, assumption_text, status, rationale, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, checkId, args.assumption_text.trim(),
      args.status ?? 'unsupported',
      (args.rationale ?? '').trim() || null,
      maxSort + 1, now, now
    )
    db.prepare(`UPDATE assumption_checks SET updated_at = ? WHERE id = ?`).run(now, checkId)
    return db.prepare(`SELECT * FROM assumption_check_items WHERE id = ?`).get(id) as AssumptionItem
  }

  updateItem(itemId: string, patch: { assumption_text?: string; status?: KacItemStatus; rationale?: string | null }): AssumptionItem | null {
    const db = getDatabase()
    const cur = db.prepare(`SELECT * FROM assumption_check_items WHERE id = ?`).get(itemId) as AssumptionItem | undefined
    if (!cur) return null
    const next = {
      assumption_text: patch.assumption_text !== undefined ? patch.assumption_text.trim() : cur.assumption_text,
      status: patch.status ?? cur.status,
      rationale: patch.rationale !== undefined ? (patch.rationale?.trim() || null) : cur.rationale
    }
    const now = Date.now()
    db.prepare(`
      UPDATE assumption_check_items
      SET assumption_text = ?, status = ?, rationale = ?, updated_at = ?
      WHERE id = ?
    `).run(next.assumption_text, next.status, next.rationale, now, itemId)
    db.prepare(`UPDATE assumption_checks SET updated_at = ? WHERE id = ?`).run(now, cur.check_id)
    return db.prepare(`SELECT * FROM assumption_check_items WHERE id = ?`).get(itemId) as AssumptionItem
  }

  removeItem(itemId: string): void {
    const db = getDatabase()
    const cur = db.prepare(`SELECT check_id FROM assumption_check_items WHERE id = ?`).get(itemId) as { check_id: string } | undefined
    db.prepare(`DELETE FROM assumption_check_items WHERE id = ?`).run(itemId)
    if (cur) db.prepare(`UPDATE assumption_checks SET updated_at = ? WHERE id = ?`).run(Date.now(), cur.check_id)
  }

  reorderItems(checkId: string, orderedIds: string[]): void {
    const db = getDatabase()
    const tx = db.transaction((ids: string[]) => {
      ids.forEach((id, idx) => {
        db.prepare(`UPDATE assumption_check_items SET sort_order = ?, updated_at = ? WHERE id = ? AND check_id = ?`)
          .run(idx + 1, Date.now(), id, checkId)
      })
      db.prepare(`UPDATE assumption_checks SET updated_at = ? WHERE id = ?`).run(Date.now(), checkId)
    })
    tx(orderedIds)
  }

  // ── LLM-assisted extraction ──────────────────────────────────────

  /** Extract candidate assumptions from a parent artifact via LLM and
   *  insert them into the existing check. Returns the number added. */
  async extractFromParent(checkId: string): Promise<{ added: number }> {
    if (!isDatabaseReady()) throw new Error('database not ready')
    const check = loadCheckRow(checkId)
    if (!check) throw new Error('Assumption check not found')
    if (!check.parent_kind || !check.parent_id) {
      throw new Error('This check is not bound to a parent artifact — extract is unavailable. Add assumptions manually.')
    }
    const ctx = renderParentContext(check.parent_kind, check.parent_id)
    if (!ctx) throw new Error('Could not render parent context for LLM')
    log.info(`kac: extracting assumptions for ${checkId} from ${check.parent_kind}/${check.parent_id}`)
    const { response } = await llmService.chatForTask('analysis', [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: ctx.context }
    ])
    const parsed = parseAssumptionsJson(response || '')
    if (parsed.length === 0) {
      throw new Error('LLM returned no parseable assumptions. Try again or add manually.')
    }
    let added = 0
    for (const a of parsed) {
      this.addItem(checkId, {
        assumption_text: a.assumption,
        status: 'unsupported',
        rationale: a.rationale || null
      })
      added++
    }
    log.info(`kac: extracted ${added} assumptions for ${checkId}`)
    return { added }
  }
}

export const kacService = new KacService()
