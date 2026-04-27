// EntityWatchlistService — v1.7.4 entity-anchored alerts.
//
// CRUD + a cron-driven check that emits a search:alert_hit event
// (reused from v1.5.3) for every genuinely-new intel mention of a
// watched entity. We piggyback on the existing event channel so the
// renderer's toast handler doesn't need a parallel implementation —
// only the source label changes.
//
// First-tick behaviour mirrors saved-search alerts: when a watch is
// enabled for the first time, we record the latest mention id as
// the cursor without firing any alerts. This prevents enabling a
// watch on a high-traffic entity from dumping 50+ toasts on the
// analyst.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'
import { cronService } from '../cron/CronService'
import { emitToAll } from '../resource/WindowCache'

export interface EntityWatch {
  id: string
  canonical_id: string
  alert_enabled: 0 | 1
  last_alerted_intel_id: string | null
  last_alerted_at: number | null
  created_at: number
  updated_at: number
}

export interface EntityWatchWithMeta extends EntityWatch {
  canonical_value: string | null
  entity_type: string | null
  mention_count: number
}

const CRON_EXPR = '*/5 * * * *'   // every 5 minutes
const MAX_ALERTS_PER_TICK_PER_ENTITY = 5

export class EntityWatchlistService {
  private cronId = 'entity-watchlist-alerts'
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    cronService.schedule(this.cronId, CRON_EXPR, 'Entity watchlist alerts', async () => {
      await this.runOnce().catch((err) =>
        log.warn(`entity-watchlist: tick failed: ${(err as Error).message}`)
      )
    })
  }

  stop(): void {
    if (!this.started) return
    cronService.unschedule(this.cronId)
    this.started = false
  }

  /** Add a canonical to the watchlist (or no-op if already there). */
  add(canonicalId: string): EntityWatchWithMeta {
    const db = getDatabase()
    const existing = db.prepare(`SELECT * FROM entity_watchlist WHERE canonical_id = ?`).get(canonicalId) as EntityWatch | undefined
    if (existing) {
      // Re-enable on add so toggling on/off is intuitive.
      if (existing.alert_enabled !== 1) {
        db.prepare(`UPDATE entity_watchlist SET alert_enabled = 1, updated_at = ? WHERE id = ?`)
          .run(Date.now(), existing.id)
      }
      return this.getWithMeta(existing.id)!
    }
    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO entity_watchlist
        (id, canonical_id, alert_enabled, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `).run(id, canonicalId, now, now)
    log.info(`entity-watchlist: added ${canonicalId}`)
    return this.getWithMeta(id)!
  }

  /** Remove a canonical from the watchlist. Idempotent. */
  remove(canonicalId: string): void {
    getDatabase().prepare(`DELETE FROM entity_watchlist WHERE canonical_id = ?`).run(canonicalId)
  }

  /** Toggle alert_enabled without removing the row. */
  setEnabled(canonicalId: string, enabled: boolean): void {
    getDatabase().prepare(`
      UPDATE entity_watchlist SET alert_enabled = ?, updated_at = ? WHERE canonical_id = ?
    `).run(enabled ? 1 : 0, Date.now(), canonicalId)
  }

  /** Lookup the row for a canonical (used by the UI to show the
   *  current toggle state in the header). */
  getByCanonicalId(canonicalId: string): EntityWatchWithMeta | null {
    const db = getDatabase()
    const row = db.prepare(`SELECT * FROM entity_watchlist WHERE canonical_id = ?`)
      .get(canonicalId) as EntityWatch | undefined
    if (!row) return null
    return this.getWithMeta(row.id)
  }

  list(): EntityWatchWithMeta[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT w.*, c.canonical_value, c.entity_type, c.mention_count
      FROM entity_watchlist w
      LEFT JOIN canonical_entities c ON c.id = w.canonical_id
      ORDER BY w.updated_at DESC
    `).all() as EntityWatchWithMeta[]
  }

  private getWithMeta(id: string): EntityWatchWithMeta | null {
    return getDatabase().prepare(`
      SELECT w.*, c.canonical_value, c.entity_type, c.mention_count
      FROM entity_watchlist w
      LEFT JOIN canonical_entities c ON c.id = w.canonical_id
      WHERE w.id = ?
    `).get(id) as EntityWatchWithMeta | null
  }

  /** One cron tick: walk every alert-enabled watch, emit a toast for
   *  every intel mention newer than the cursor. */
  async runOnce(): Promise<{ scanned: number; alerted: number }> {
    if (!isDatabaseReady()) return { scanned: 0, alerted: 0 }
    const db = getDatabase()
    const watches = db.prepare(`
      SELECT w.*, c.canonical_value, c.entity_type
      FROM entity_watchlist w
      LEFT JOIN canonical_entities c ON c.id = w.canonical_id
      WHERE w.alert_enabled = 1
    `).all() as Array<EntityWatch & { canonical_value: string | null; entity_type: string | null }>
    if (watches.length === 0) return { scanned: 0, alerted: 0 }

    let totalAlerted = 0
    for (const w of watches) {
      // Pull recent intel mentions of this canonical, newest first.
      const recent = db.prepare(`
        SELECT DISTINCT
          r.id            AS id,
          r.title         AS title,
          r.severity      AS severity,
          r.discipline    AS discipline,
          r.created_at    AS created_at,
          r.summary       AS summary
        FROM intel_entities e
        JOIN intel_reports r ON r.id = e.report_id
        WHERE e.canonical_id = ? AND COALESCE(r.quarantined, 0) = 0
        ORDER BY r.created_at DESC
        LIMIT 25
      `).all(w.canonical_id) as Array<{
        id: string; title: string; severity: string
        discipline: string; created_at: number; summary: string | null
      }>
      if (recent.length === 0) continue

      const firstTime = w.last_alerted_intel_id == null
      const newHits: typeof recent = []
      for (const r of recent) {
        if (newHits.length >= MAX_ALERTS_PER_TICK_PER_ENTITY) break
        if (r.id === w.last_alerted_intel_id) break
        newHits.push(r)
      }

      // Always advance the cursor to the freshest id, regardless of
      // whether we alerted (firstTime path).
      db.prepare(`
        UPDATE entity_watchlist
        SET last_alerted_intel_id = ?, last_alerted_at = ?
        WHERE id = ?
      `).run(recent[0].id, Date.now(), w.id)

      if (firstTime) {
        log.info(`entity-watchlist: '${w.canonical_value ?? w.canonical_id}' first-run; cursor recorded, ${recent.length} existing mention(s) skipped`)
        continue
      }

      // Reuse the v1.5.3 search:alert_hit channel — the renderer toast
      // handler already knows how to render it. Source-label vars
      // distinguish entity-watch alerts from saved-search alerts.
      for (const hit of newHits) {
        emitToAll('search:alert_hit', {
          saved_search_id: `entity:${w.canonical_id}`,
          saved_search_name: `Watch: ${w.canonical_value ?? w.canonical_id.slice(0, 8)}`,
          hit_kind: 'intel',
          hit_id: hit.id,
          hit_title: hit.title,
          hit_snippet: (hit.summary ?? '').slice(0, 280),
          alerted_at: Date.now()
        })
        totalAlerted++
      }
      if (newHits.length > 0) {
        log.info(`entity-watchlist: '${w.canonical_value ?? w.canonical_id}' fired ${newHits.length} new alert(s)`)
      }
    }

    return { scanned: watches.length, alerted: totalAlerted }
  }
}

export const entityWatchlist = new EntityWatchlistService()
