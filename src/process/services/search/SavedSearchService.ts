// SavedSearchService — v1.5.2 persisted, re-runnable search queries.
//
// CRUD over the saved_searches table + a thin "run now" wrapper that
// calls UniversalSearchService.search() with the saved query and
// updates last_run_at + last_hit_count. The v1.5.3 alert cron uses
// these same rows, gated by alert_enabled.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { universalSearch, type SearchHit, type SearchKind } from './UniversalSearchService'

export interface SavedSearch {
  id: string
  name: string
  query: string
  kinds_filter: string | null
  created_at: number
  updated_at: number
  last_run_at: number | null
  last_hit_count: number
  alert_enabled: 0 | 1
  alert_cron: string | null
  last_alerted_at: number | null
  last_alerted_intel_id: string | null
  last_alerted_transcript_id: string | null
}

export interface SavedSearchInput {
  name: string
  query: string
  kinds: SearchKind[] | null    // null = all corpora
}

export class SavedSearchService {
  list(): SavedSearch[] {
    return getDatabase().prepare(`
      SELECT * FROM saved_searches ORDER BY updated_at DESC
    `).all() as SavedSearch[]
  }

  get(id: string): SavedSearch | null {
    return getDatabase().prepare(`SELECT * FROM saved_searches WHERE id = ?`).get(id) as SavedSearch | null
  }

  create(input: SavedSearchInput): SavedSearch {
    const id = generateId()
    const now = Date.now()
    const kindsFilter = input.kinds && input.kinds.length > 0 ? input.kinds.join(',') : null
    getDatabase().prepare(`
      INSERT INTO saved_searches
        (id, name, query, kinds_filter, created_at, updated_at, last_hit_count, alert_enabled)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    `).run(id, input.name.trim(), input.query.trim(), kindsFilter, now, now)
    log.info(`saved-search: created '${input.name}' (${id})`)
    return this.get(id)!
  }

  update(id: string, patch: Partial<Pick<SavedSearch, 'name' | 'query' | 'kinds_filter' | 'alert_enabled' | 'alert_cron'>>): SavedSearch | null {
    const cur = this.get(id)
    if (!cur) return null
    const merged = { ...cur, ...patch, updated_at: Date.now() }
    getDatabase().prepare(`
      UPDATE saved_searches
      SET name = ?, query = ?, kinds_filter = ?, alert_enabled = ?, alert_cron = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.name, merged.query, merged.kinds_filter,
      merged.alert_enabled, merged.alert_cron, merged.updated_at, id
    )
    return this.get(id)
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM saved_searches WHERE id = ?`).run(id)
  }

  /** Run a saved search now and return the hits. Updates last_run_at +
   *  last_hit_count as a side effect. Used by both the manual "Run"
   *  button and the v1.5.3 alert cron. */
  run(id: string, limit = 50): { search: SavedSearch; hits: SearchHit[] } | null {
    const search = this.get(id)
    if (!search) return null
    const kinds = search.kinds_filter ? search.kinds_filter.split(',') as SearchKind[] : undefined
    const hits = universalSearch.search({ query: search.query, kinds, limit })
    const now = Date.now()
    getDatabase().prepare(`
      UPDATE saved_searches SET last_run_at = ?, last_hit_count = ? WHERE id = ?
    `).run(now, hits.length, id)
    return { search: { ...search, last_run_at: now, last_hit_count: hits.length }, hits }
  }

  /** Mark the most recent intel + transcript ids that have been
   *  surfaced as alerts so the next cron tick only emits truly new
   *  hits. Called by the alert cron after each run. */
  recordAlertCursor(id: string, latestIntelId: string | null, latestTranscriptId: string | null): void {
    getDatabase().prepare(`
      UPDATE saved_searches
      SET last_alerted_at = ?, last_alerted_intel_id = ?, last_alerted_transcript_id = ?
      WHERE id = ?
    `).run(Date.now(), latestIntelId, latestTranscriptId, id)
  }
}

export const savedSearch = new SavedSearchService()
