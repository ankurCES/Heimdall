import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { auditChainService } from '../audit/AuditChainService'
import log from 'electron-log'

/**
 * Indicators & Warnings (I&W) Service — Themes 5.1, 5.2 of the agency
 * roadmap.
 *
 * Models the canonical I&W methodology: define a high-impact event, tag
 * observable indicators with thresholds, evaluate continuously, alert on
 * threshold crossings.
 *
 * Indicator query types currently supported (extensible — Theme 5.3 adds
 * anomaly detection on time series, Theme 5.6 adds market metric
 * thresholds, etc.):
 *
 *   intel_count    — count of intel_reports matching keywords/discipline/
 *                    severity in a rolling time window
 *   entity_count   — count of intel_entities mentions of a specific value
 *
 * Threshold semantics: the "level" reported is RED if value >= red,
 * AMBER if value >= amber, otherwise GREEN. red_threshold > amber_threshold
 * by convention (configurable per-indicator).
 */

export type IndicatorLevel = 'red' | 'amber' | 'green'
export type IndicatorQueryType = 'intel_count' | 'entity_count'

export interface IwEvent {
  id: string
  name: string
  description: string | null
  scenario_class: string | null
  classification: string
  status: 'active' | 'closed'
  created_at: number
  updated_at: number
  indicators?: IwIndicator[]
  level?: IndicatorLevel
}

export interface IwIndicator {
  id: string
  event_id: string
  name: string
  description: string | null
  query_type: IndicatorQueryType
  query_params: Record<string, unknown>
  red_threshold: number | null
  amber_threshold: number | null
  weight: number
  current_value: number | null
  current_level: IndicatorLevel | null
  last_evaluated_at: number | null
  status: 'active' | 'paused'
  created_at: number
  updated_at: number
}

interface IwEvaluation {
  id: string
  indicator_id: string
  value: number
  level: IndicatorLevel
  source_count: number | null
  evaluated_at: number
}

class IwServiceImpl {
  // ---- Event CRUD ----

  createEvent(input: { name: string; description?: string; scenario_class?: string; classification?: string }): IwEvent {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    const cls = input.classification || 'UNCLASSIFIED'
    db.prepare(`
      INSERT INTO iw_events (id, name, description, scenario_class, classification, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.name, input.description || null, input.scenario_class || null, cls, now, now)

    auditChainService.append('iw.event.create', {
      entityType: 'iw_event', entityId: id, classification: cls,
      payload: { name: input.name }
    })

    return this.getEvent(id)!
  }

  updateEvent(id: string, patch: Partial<Pick<IwEvent, 'name' | 'description' | 'scenario_class' | 'classification' | 'status'>>): IwEvent {
    const db = getDatabase()
    const fields: string[] = []
    const vals: unknown[] = []
    if (patch.name !== undefined) { fields.push('name = ?'); vals.push(patch.name) }
    if (patch.description !== undefined) { fields.push('description = ?'); vals.push(patch.description) }
    if (patch.scenario_class !== undefined) { fields.push('scenario_class = ?'); vals.push(patch.scenario_class) }
    if (patch.classification !== undefined) { fields.push('classification = ?'); vals.push(patch.classification) }
    if (patch.status !== undefined) { fields.push('status = ?'); vals.push(patch.status) }
    fields.push('updated_at = ?'); vals.push(timestamp())
    if (fields.length > 1) {
      db.prepare(`UPDATE iw_events SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return this.getEvent(id)!
  }

  deleteEvent(id: string): void {
    const db = getDatabase()
    const ev = db.prepare('SELECT name, classification FROM iw_events WHERE id = ?').get(id) as { name: string; classification: string } | undefined
    db.prepare('DELETE FROM iw_events WHERE id = ?').run(id) // CASCADE drops indicators + evaluations
    if (ev) {
      auditChainService.append('iw.event.delete', {
        entityType: 'iw_event', entityId: id, classification: ev.classification,
        payload: { name: ev.name }
      })
    }
  }

  getEvent(id: string): IwEvent | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM iw_events WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    const event = this.mapEvent(row)
    event.indicators = this.listIndicators(id)
    event.level = this.aggregateLevel(event.indicators)
    return event
  }

  listEvents(opts: { status?: 'active' | 'closed' } = {}): IwEvent[] {
    const db = getDatabase()
    let q = 'SELECT * FROM iw_events'
    const vals: unknown[] = []
    if (opts.status) { q += ' WHERE status = ?'; vals.push(opts.status) }
    q += ' ORDER BY created_at DESC'
    const rows = db.prepare(q).all(...vals) as Array<Record<string, unknown>>
    return rows.map((row) => {
      const ev = this.mapEvent(row)
      ev.indicators = this.listIndicators(ev.id)
      ev.level = this.aggregateLevel(ev.indicators)
      return ev
    })
  }

  // ---- Indicator CRUD ----

  addIndicator(input: {
    event_id: string
    name: string
    description?: string
    query_type: IndicatorQueryType
    query_params: Record<string, unknown>
    red_threshold?: number
    amber_threshold?: number
    weight?: number
  }): IwIndicator {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    db.prepare(`
      INSERT INTO iw_indicators
        (id, event_id, name, description, query_type, query_params, red_threshold, amber_threshold, weight, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      id, input.event_id, input.name, input.description || null,
      input.query_type, JSON.stringify(input.query_params),
      input.red_threshold ?? null, input.amber_threshold ?? null,
      input.weight ?? 1.0, now, now
    )
    return this.getIndicator(id)!
  }

  updateIndicator(id: string, patch: Partial<Omit<IwIndicator, 'id' | 'event_id' | 'created_at' | 'current_value' | 'current_level' | 'last_evaluated_at'>>): IwIndicator {
    const db = getDatabase()
    const fields: string[] = []
    const vals: unknown[] = []
    if (patch.name !== undefined) { fields.push('name = ?'); vals.push(patch.name) }
    if (patch.description !== undefined) { fields.push('description = ?'); vals.push(patch.description) }
    if (patch.query_type !== undefined) { fields.push('query_type = ?'); vals.push(patch.query_type) }
    if (patch.query_params !== undefined) { fields.push('query_params = ?'); vals.push(JSON.stringify(patch.query_params)) }
    if (patch.red_threshold !== undefined) { fields.push('red_threshold = ?'); vals.push(patch.red_threshold) }
    if (patch.amber_threshold !== undefined) { fields.push('amber_threshold = ?'); vals.push(patch.amber_threshold) }
    if (patch.weight !== undefined) { fields.push('weight = ?'); vals.push(patch.weight) }
    if (patch.status !== undefined) { fields.push('status = ?'); vals.push(patch.status) }
    fields.push('updated_at = ?'); vals.push(timestamp())
    if (fields.length > 1) {
      db.prepare(`UPDATE iw_indicators SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return this.getIndicator(id)!
  }

  deleteIndicator(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM iw_indicators WHERE id = ?').run(id)
  }

  getIndicator(id: string): IwIndicator | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM iw_indicators WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapIndicator(row) : null
  }

  listIndicators(eventId: string): IwIndicator[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM iw_indicators WHERE event_id = ? ORDER BY weight DESC, created_at ASC').all(eventId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapIndicator(r))
  }

  // ---- Evaluation ----

  /**
   * Evaluate a single indicator against current data and persist the result.
   * Updates the indicator's denormalized current_value / current_level so
   * the dashboard doesn't need to walk the evaluation history.
   */
  evaluateIndicator(id: string): IwEvaluation {
    const db = getDatabase()
    const ind = this.getIndicator(id)
    if (!ind) throw new Error(`Indicator not found: ${id}`)

    const result = this.runQuery(ind)
    const level = this.computeLevel(result.value, ind.red_threshold, ind.amber_threshold)
    const now = timestamp()

    const evalId = generateId()
    db.prepare(`
      INSERT INTO iw_evaluations (id, indicator_id, value, level, source_count, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(evalId, id, result.value, level, result.sourceCount, now)

    db.prepare(`
      UPDATE iw_indicators
      SET current_value = ?, current_level = ?, last_evaluated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(result.value, level, now, now, id)

    return {
      id: evalId, indicator_id: id, value: result.value, level,
      source_count: result.sourceCount, evaluated_at: now
    }
  }

  /** Evaluate every active indicator of an event. */
  evaluateEvent(eventId: string): { eventId: string; evaluated: number; level: IndicatorLevel } {
    const indicators = this.listIndicators(eventId).filter((i) => i.status === 'active')
    for (const ind of indicators) {
      try {
        this.evaluateIndicator(ind.id)
      } catch (err) {
        log.warn(`I&W: failed to evaluate ${ind.name}: ${err}`)
      }
    }
    const ev = this.getEvent(eventId)
    return { eventId, evaluated: indicators.length, level: ev?.level || 'green' }
  }

  /** Evaluate every active indicator across every active event. */
  evaluateAll(): { events: number; indicators: number } {
    const events = this.listEvents({ status: 'active' })
    let totalIndicators = 0
    for (const ev of events) {
      const r = this.evaluateEvent(ev.id)
      totalIndicators += r.evaluated
    }
    return { events: events.length, indicators: totalIndicators }
  }

  /** Recent evaluations for an indicator — for trend chart in the UI. */
  history(indicatorId: string, limit = 100): IwEvaluation[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT id, indicator_id, value, level, source_count, evaluated_at
      FROM iw_evaluations WHERE indicator_id = ? ORDER BY evaluated_at DESC LIMIT ?
    `).all(indicatorId, limit) as IwEvaluation[]
    return rows
  }

  // ---- Internal ----

  private runQuery(ind: IwIndicator): { value: number; sourceCount: number | null } {
    const db = getDatabase()
    const params = ind.query_params

    if (ind.query_type === 'intel_count') {
      const keywords = (params.keywords as string[]) || []
      const discipline = params.discipline as string | undefined
      const severity = params.severity as string | undefined
      const windowHours = (params.window_hours as number) || 24
      const cutoff = Date.now() - windowHours * 3600_000

      const conds: string[] = ['created_at >= ?']
      const vals: unknown[] = [cutoff]
      if (keywords.length > 0) {
        const kwClauses = keywords.map(() => '(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)').join(' OR ')
        conds.push(`(${kwClauses})`)
        for (const k of keywords) vals.push(`%${k.toLowerCase()}%`, `%${k.toLowerCase()}%`)
      }
      if (discipline) { conds.push('discipline = ?'); vals.push(discipline) }
      if (severity) { conds.push('severity = ?'); vals.push(severity) }

      const count = (db.prepare(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT source_name) AS s FROM intel_reports WHERE ${conds.join(' AND ')}`
      ).get(...vals) as { c: number; s: number })
      return { value: count.c, sourceCount: count.s }
    }

    if (ind.query_type === 'entity_count') {
      const entityType = params.entity_type as string | undefined
      const entityValue = params.entity_value as string | undefined
      const windowHours = (params.window_hours as number) || 24
      const cutoff = Date.now() - windowHours * 3600_000

      const conds: string[] = ['e.created_at >= ?']
      const vals: unknown[] = [cutoff]
      if (entityType) { conds.push('e.entity_type = ?'); vals.push(entityType) }
      if (entityValue) { conds.push('LOWER(e.entity_value) LIKE ?'); vals.push(`%${entityValue.toLowerCase()}%`) }

      const count = (db.prepare(
        `SELECT COUNT(DISTINCT e.report_id) AS c FROM intel_entities e WHERE ${conds.join(' AND ')}`
      ).get(...vals) as { c: number })
      return { value: count.c, sourceCount: null }
    }

    return { value: 0, sourceCount: null }
  }

  private computeLevel(value: number, red: number | null, amber: number | null): IndicatorLevel {
    if (red != null && value >= red) return 'red'
    if (amber != null && value >= amber) return 'amber'
    return 'green'
  }

  /** Aggregate event-level R/A/G — RED if any indicator is RED, AMBER if any AMBER, else GREEN. */
  private aggregateLevel(indicators: IwIndicator[]): IndicatorLevel {
    if (indicators.some((i) => i.current_level === 'red')) return 'red'
    if (indicators.some((i) => i.current_level === 'amber')) return 'amber'
    return 'green'
  }

  private mapEvent(row: Record<string, unknown>): IwEvent {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) || null,
      scenario_class: (row.scenario_class as string) || null,
      classification: row.classification as string,
      status: row.status as 'active' | 'closed',
      created_at: row.created_at as number,
      updated_at: row.updated_at as number
    }
  }

  private mapIndicator(row: Record<string, unknown>): IwIndicator {
    return {
      id: row.id as string,
      event_id: row.event_id as string,
      name: row.name as string,
      description: (row.description as string) || null,
      query_type: row.query_type as IndicatorQueryType,
      query_params: JSON.parse((row.query_params as string) || '{}'),
      red_threshold: row.red_threshold as number | null,
      amber_threshold: row.amber_threshold as number | null,
      weight: row.weight as number,
      current_value: row.current_value as number | null,
      current_level: (row.current_level as IndicatorLevel) || null,
      last_evaluated_at: row.last_evaluated_at as number | null,
      status: row.status as 'active' | 'paused',
      created_at: row.created_at as number,
      updated_at: row.updated_at as number
    }
  }
}

export const iwService = new IwServiceImpl()
