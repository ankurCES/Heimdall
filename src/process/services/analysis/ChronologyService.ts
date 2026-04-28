// ChronologyService — v1.9.2 analyst-curated chronology builder.
//
// The auto entity-timeline shows every mention an entity has appeared
// in. A chronology, by contrast, is *curated*: the analyst hand-picks
// the events that matter, annotates them, and weaves them into a
// story.
//
// Storage model: events live as a JSON blob on the chronology row.
// Events have no independent identity — they are essentially value
// objects bound to a parent chronology — and the JSON representation
// keeps reorder/edit operations atomic without an O(N) row dance.
//
// Each event in events_json:
//   {
//     id: string,                   // local uuid (key for React)
//     ts: number,                   // event timestamp (epoch ms)
//     title: string,                // analyst-authored headline
//     description?: string,         // free-form annotation
//     source_kind?: 'intel'|'transcript'|'note',
//     source_id?: string|null,      // FK-ish into source table
//     tags?: string[]
//   }

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'

export type ChronologySourceKind = 'intel' | 'transcript' | 'note'

export interface ChronologyEvent {
  id: string
  ts: number
  title: string
  description?: string | null
  source_kind?: ChronologySourceKind | null
  source_id?: string | null
  tags?: string[]
}

export interface Chronology {
  id: string
  name: string
  description: string | null
  events_json: string
  created_at: number
  updated_at: number
}

export interface ChronologyWithEvents extends Omit<Chronology, 'events_json'> {
  events: ChronologyEvent[]
  event_count: number
  span_start: number | null
  span_end: number | null
}

function parseEvents(raw: string | null | undefined): ChronologyEvent[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
  } catch {
    return []
  }
}

function hydrate(row: Chronology): ChronologyWithEvents {
  const events = parseEvents(row.events_json).sort((a, b) => a.ts - b.ts)
  const ts = events.map((e) => e.ts).filter((n) => Number.isFinite(n))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    events,
    event_count: events.length,
    span_start: ts.length ? Math.min(...ts) : null,
    span_end: ts.length ? Math.max(...ts) : null
  }
}

export class ChronologyService {
  // ── CRUD ──────────────────────────────────────────────────────────

  list(): ChronologyWithEvents[] {
    const rows = getDatabase()
      .prepare(`SELECT * FROM chronologies ORDER BY updated_at DESC`)
      .all() as Chronology[]
    return rows.map(hydrate)
  }

  get(id: string): ChronologyWithEvents | null {
    const row = getDatabase()
      .prepare(`SELECT * FROM chronologies WHERE id = ?`)
      .get(id) as Chronology | undefined
    return row ? hydrate(row) : null
  }

  create(args: { name: string; description?: string | null }): ChronologyWithEvents {
    const db = getDatabase()
    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO chronologies (id, name, description, events_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', ?, ?)
    `).run(id, args.name.trim(), (args.description ?? '').trim() || null, now, now)
    log.info(`chronology: created ${id} "${args.name}"`)
    return this.get(id)!
  }

  update(id: string, patch: { name?: string; description?: string | null }): ChronologyWithEvents | null {
    const db = getDatabase()
    const cur = db.prepare(`SELECT * FROM chronologies WHERE id = ?`).get(id) as Chronology | undefined
    if (!cur) return null
    const name = patch.name !== undefined ? patch.name.trim() : cur.name
    const description = patch.description !== undefined
      ? (patch.description?.trim() || null)
      : cur.description
    db.prepare(`
      UPDATE chronologies SET name = ?, description = ?, updated_at = ? WHERE id = ?
    `).run(name, description, Date.now(), id)
    return this.get(id)
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM chronologies WHERE id = ?`).run(id)
    log.info(`chronology: removed ${id}`)
  }

  // ── Event operations (always-atomic JSON rewrite) ────────────────

  addEvent(
    chronologyId: string,
    event: Omit<ChronologyEvent, 'id'> & { id?: string }
  ): ChronologyWithEvents | null {
    return this.mutateEvents(chronologyId, (events) => {
      const id = event.id || generateId()
      // Dedupe: if the same source row was already pulled in, skip.
      if (event.source_kind && event.source_id) {
        const dup = events.find(
          (e) => e.source_kind === event.source_kind && e.source_id === event.source_id
        )
        if (dup) return events
      }
      const next: ChronologyEvent = {
        id,
        ts: Number.isFinite(event.ts) ? event.ts : Date.now(),
        title: (event.title || '').trim() || 'Untitled event',
        description: event.description?.toString().trim() || null,
        source_kind: event.source_kind ?? null,
        source_id: event.source_id ?? null,
        tags: Array.isArray(event.tags) ? event.tags : []
      }
      return [...events, next]
    })
  }

  updateEvent(
    chronologyId: string,
    eventId: string,
    patch: Partial<Omit<ChronologyEvent, 'id'>>
  ): ChronologyWithEvents | null {
    return this.mutateEvents(chronologyId, (events) =>
      events.map((e) => (e.id === eventId ? { ...e, ...patch, id: e.id } : e))
    )
  }

  removeEvent(chronologyId: string, eventId: string): ChronologyWithEvents | null {
    return this.mutateEvents(chronologyId, (events) => events.filter((e) => e.id !== eventId))
  }

  /** Replace the entire event list (used for drag-reorder + bulk edit). */
  replaceEvents(chronologyId: string, events: ChronologyEvent[]): ChronologyWithEvents | null {
    return this.mutateEvents(chronologyId, () =>
      events.map((e) => ({
        id: e.id || generateId(),
        ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
        title: (e.title || '').trim() || 'Untitled event',
        description: e.description ?? null,
        source_kind: e.source_kind ?? null,
        source_id: e.source_id ?? null,
        tags: Array.isArray(e.tags) ? e.tags : []
      }))
    )
  }

  private mutateEvents(
    chronologyId: string,
    mutator: (events: ChronologyEvent[]) => ChronologyEvent[]
  ): ChronologyWithEvents | null {
    const db = getDatabase()
    const cur = db.prepare(`SELECT * FROM chronologies WHERE id = ?`).get(chronologyId) as
      | Chronology
      | undefined
    if (!cur) return null
    const events = mutator(parseEvents(cur.events_json))
    db.prepare(`UPDATE chronologies SET events_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(events),
      Date.now(),
      chronologyId
    )
    return this.get(chronologyId)
  }

  // ── Export ───────────────────────────────────────────────────────

  exportMarkdown(id: string): string | null {
    const c = this.get(id)
    if (!c) return null
    const lines: string[] = []
    lines.push(`# ${c.name}`)
    if (c.description) {
      lines.push('')
      lines.push(c.description)
    }
    lines.push('')
    lines.push(`*${c.event_count} event${c.event_count === 1 ? '' : 's'}*`)
    lines.push('')
    for (const e of c.events) {
      const date = new Date(e.ts).toISOString()
      lines.push(`## ${date} — ${e.title}`)
      if (e.description) {
        lines.push('')
        lines.push(e.description)
      }
      if (e.source_kind && e.source_id) {
        lines.push('')
        lines.push(`*Source: ${e.source_kind}/${e.source_id}*`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }
}

export const chronologyService = new ChronologyService()
