// SavedSearchAlertCron — v1.5.3 cron-driven alerts on saved searches.
//
// Every N minutes, walks every saved_search where alert_enabled = 1,
// re-runs the FTS query, compares the hit IDs against the
// last_alerted_* cursor on the row, and emits a 'search:alert_hit'
// event for each genuinely-new match. The renderer's
// NotificationListener turns those into toasts; the cursor is
// advanced so the same hit never alerts twice.
//
// Safety:
//   - First-ever run on a search records the cursor without alerting
//     (otherwise enabling alerts on a popular query would dump
//     hundreds of toasts on the analyst).
//   - Per-tick cap of 5 new alerts per search (older overflow is
//     dropped silently) so a sudden spike doesn't lock up the UI.
//   - Cron skipped entirely when no saved searches have alerts on,
//     so the service is a true no-op until opted in.

import log from 'electron-log'
import { savedSearch } from './SavedSearchService'
import { cronService } from '../cron/CronService'
import { emitToAll } from '../resource/WindowCache'

const DEFAULT_CRON = '*/5 * * * *'    // every 5 minutes
const MAX_ALERTS_PER_TICK = 5

export interface SearchAlertHit {
  saved_search_id: string
  saved_search_name: string
  hit_kind: 'intel' | 'transcript'
  hit_id: string
  hit_title: string
  hit_snippet: string
  alerted_at: number
}

export class SavedSearchAlertCron {
  private cronId = 'saved-search-alerts'
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    cronService.schedule(this.cronId, DEFAULT_CRON, 'Saved-search alerts', async () => {
      await this.runOnce().catch((err) =>
        log.warn(`saved-search-alerts: tick failed: ${(err as Error).message}`)
      )
    })
  }

  stop(): void {
    if (!this.started) return
    cronService.unschedule(this.cronId)
    this.started = false
  }

  /** One tick: iterate every alert-enabled saved search, run it, emit
   *  alerts for new hits, advance the cursor. Idempotent — the same
   *  tick run twice produces zero duplicate alerts. */
  async runOnce(): Promise<{ scanned: number; alerted: number }> {
    const all = savedSearch.list().filter((s) => s.alert_enabled === 1)
    if (all.length === 0) return { scanned: 0, alerted: 0 }
    let totalAlerted = 0

    for (const s of all) {
      const result = savedSearch.run(s.id, 30)
      if (!result) continue
      const newHits: SearchAlertHit[] = []

      // First-time run: just record cursor, don't fire alerts.
      const firstTime = s.last_alerted_at == null
      const lastIntelId = s.last_alerted_intel_id
      const lastTranscriptId = s.last_alerted_transcript_id

      // Walk hits in score order; stop emitting once we hit the cursor.
      for (const hit of result.hits) {
        if (newHits.length >= MAX_ALERTS_PER_TICK) break
        if (hit.kind === 'intel' && hit.id === lastIntelId) break
        if (hit.kind === 'transcript' && hit.id === lastTranscriptId) break
        newHits.push({
          saved_search_id: s.id,
          saved_search_name: s.name,
          hit_kind: hit.kind,
          hit_id: hit.id,
          hit_title: hit.title,
          hit_snippet: hit.snippet,
          alerted_at: Date.now()
        })
      }

      // Advance the cursor to the freshest IDs we saw, regardless of
      // whether we alerted (firstTime path).
      const topIntel = result.hits.find((h) => h.kind === 'intel')?.id ?? lastIntelId
      const topTranscript = result.hits.find((h) => h.kind === 'transcript')?.id ?? lastTranscriptId
      savedSearch.recordAlertCursor(s.id, topIntel ?? null, topTranscript ?? null)

      if (firstTime) {
        log.info(`saved-search-alerts: '${s.name}' first-run; cursor recorded, ${result.hits.length} existing hit(s) skipped`)
        continue
      }

      // Emit new hits.
      for (const h of newHits) {
        emitToAll('search:alert_hit', h)
      }
      if (newHits.length > 0) {
        log.info(`saved-search-alerts: '${s.name}' fired ${newHits.length} new alert(s)`)
        totalAlerted += newHits.length
      }
    }

    return { scanned: all.length, alerted: totalAlerted }
  }
}

export const savedSearchAlertCron = new SavedSearchAlertCron()
