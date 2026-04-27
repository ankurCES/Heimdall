// IndicatorTrackerService — runs every 15 minutes. For every active
// report_indicators row, scan recently-arrived intel_reports for
// keyword/entity matches and record observations.
//
// When a high-priority confirming indicator triggers, fires a
// "indicator:hit" alert to the existing AlertEngine so the analyst sees
// it in the Alerts page (and via configured dispatchers).
//
// Match algorithm:
//   - All keywords must appear in intel content (AND, lowercase substring)
//   - At least one entity must appear (OR), unless entities list is empty
//   - Score = (keyword_hits / keyword_count) * (entities_match ? 1 : 0.5)
//   - Threshold: score >= 0.7 to record an observation
//
// Idempotent — UNIQUE constraint via (indicator_id, intel_report_id) is
// enforced at insert time with INSERT-OR-IGNORE semantics by checking
// for an existing observation row first.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

export interface IndicatorRow {
  id: string
  report_id: string
  hypothesis: string
  indicator_text: string
  direction: 'confirming' | 'refuting'
  priority: 'high' | 'medium' | 'low'
  match_keywords_json: string | null
  match_entities_json: string | null
}

export interface IntelRow {
  id: string
  title: string
  content: string
  created_at: number
}

export interface IndicatorHit {
  indicatorId: string
  hypothesis: string
  direction: 'confirming' | 'refuting'
  priority: 'high' | 'medium' | 'low'
  intelId: string
  intelTitle: string
  matchedText: string
  score: number
}

const SCORE_THRESHOLD = 0.7
const SCAN_LOOKBACK_MS = 24 * 60 * 60 * 1000  // scan intel from last 24h
const MAX_INTEL_PER_RUN = 500

export class IndicatorTrackerService {
  private timer: NodeJS.Timeout | null = null
  private running = false

  /** Start the periodic scan timer (15-minute cadence). */
  start(intervalMs: number = 15 * 60 * 1000): void {
    if (this.timer) return
    log.info(`IndicatorTracker: started (interval ${intervalMs}ms)`)
    // Run once shortly after start, then on the interval
    setTimeout(() => this.runOnce().catch((e) => log.warn(`tracker initial run: ${e}`)), 30_000)
    this.timer = setInterval(() => this.runOnce().catch((e) => log.warn(`tracker run: ${e}`)), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Run a single scan of recent intel against all active indicators. */
  async runOnce(): Promise<{ scanned: number; hits: number; alerted: number }> {
    if (this.running) {
      log.debug('IndicatorTracker: already running, skipping')
      return { scanned: 0, hits: 0, alerted: 0 }
    }
    this.running = true
    const start = Date.now()
    try {
      const db = getDatabase()

      // Pull active indicators
      const indicators = db.prepare(`
        SELECT id, report_id, hypothesis, indicator_text, direction, priority,
               match_keywords_json, match_entities_json
        FROM report_indicators
        WHERE active = 1
      `).all() as IndicatorRow[]

      if (indicators.length === 0) {
        return { scanned: 0, hits: 0, alerted: 0 }
      }

      // Pull recent intel
      const since = Date.now() - SCAN_LOOKBACK_MS
      const intel = db.prepare(`
        SELECT id, title, content, created_at FROM intel_reports
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(since, MAX_INTEL_PER_RUN) as IntelRow[]

      let hitCount = 0
      let alertCount = 0

      for (const ind of indicators) {
        const keywords = this.parseList(ind.match_keywords_json)
        const entities = this.parseList(ind.match_entities_json)
        if (keywords.length === 0) continue

        for (const item of intel) {
          // Skip if we already have an observation for this (indicator, intel) pair
          const existing = db.prepare(
            `SELECT 1 FROM indicator_observations WHERE indicator_id = ? AND intel_report_id = ?`
          ).get(ind.id, item.id)
          if (existing) continue

          const result = this.score(item.title + '\n' + item.content, keywords, entities)
          if (result.score >= SCORE_THRESHOLD) {
            this.recordObservation(ind, item, result.matchedText, result.score)
            hitCount++

            // Fire alert for high-priority hits
            if (ind.priority === 'high') {
              try {
                this.fireAlert(ind, item, result.score)
                alertCount++
              } catch (err) { log.debug(`alert dispatch failed: ${err}`) }
            }
          }
        }
      }

      const dur = Date.now() - start
      log.info(`IndicatorTracker: ${indicators.length} indicators × ${intel.length} intel → ${hitCount} hits (${alertCount} alerted) in ${dur}ms`)
      return { scanned: indicators.length, hits: hitCount, alerted: alertCount }
    } finally {
      this.running = false
    }
  }

  /**
   * Score the content against a keyword set + entity set.
   * Returns the matched-keyword excerpt for display.
   */
  private score(text: string, keywords: string[], entities: string[]): { score: number; matchedText: string } {
    const lower = text.toLowerCase()
    const matchedKeywords: string[] = []
    for (const kw of keywords) {
      if (lower.includes(kw)) matchedKeywords.push(kw)
    }
    const kwRatio = matchedKeywords.length / keywords.length

    let entityMultiplier = 1.0
    if (entities.length > 0) {
      const anyEntity = entities.some((e) => lower.includes(e))
      entityMultiplier = anyEntity ? 1.0 : 0.5
    }

    const score = kwRatio * entityMultiplier

    // Build a short excerpt around the first matched keyword for display
    let matchedText = ''
    if (matchedKeywords.length > 0) {
      const first = matchedKeywords[0]
      const idx = lower.indexOf(first)
      const start = Math.max(0, idx - 60)
      const end = Math.min(text.length, idx + first.length + 60)
      matchedText = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
    }

    return { score, matchedText }
  }

  private recordObservation(
    ind: IndicatorRow,
    intel: IntelRow,
    matchedText: string,
    score: number
  ): void {
    const db = getDatabase()
    const id = generateId()
    const now = Date.now()
    try {
      db.prepare(`
        INSERT INTO indicator_observations
          (id, indicator_id, intel_report_id, matched_text, match_score, observed_at, reviewed)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(id, ind.id, intel.id, matchedText.slice(0, 500), score, now)

      // Update parent indicator's observation count + last_observed timestamp
      db.prepare(`
        UPDATE report_indicators
        SET observation_count = observation_count + 1, last_observed_at = ?
        WHERE id = ?
      `).run(now, ind.id)
    } catch (err) {
      log.debug(`recordObservation failed: ${err}`)
    }
  }

  private fireAlert(ind: IndicatorRow, intel: IntelRow, score: number): void {
    const db = getDatabase()
    const now = Date.now()
    const directionLabel = ind.direction === 'confirming' ? 'CONFIRMING' : 'REFUTING'
    const summary = `[I&W ${directionLabel}] ${ind.hypothesis.slice(0, 80)}`
    const detail = `Indicator triggered (score ${score.toFixed(2)}): ${ind.indicator_text.slice(0, 200)}\n\nFrom intel: ${intel.title.slice(0, 150)}`
    try {
      db.prepare(`
        INSERT INTO alerts (id, severity, source, title, body, payload, created_at, status)
        VALUES (?, 'high', 'indicator-tracker', ?, ?, ?, ?, 'pending')
      `).run(
        generateId(), summary, detail,
        JSON.stringify({ indicatorId: ind.id, reportId: ind.report_id, intelId: intel.id }),
        now
      )
    } catch (err) {
      log.debug(`alert insert failed (alerts table may not exist on older installs): ${err}`)
    }
  }

  private parseList(raw: string | null): string[] {
    if (!raw) return []
    try { return JSON.parse(raw) as string[] }
    catch { return [] }
  }

  // ── UI/bridge queries ────────────────────────────────────────────────

  /** All active indicators with their observation counts. */
  listActiveIndicators(): Array<IndicatorRow & { reportTitle: string; observationCount: number; lastObservedAt: number | null }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT ri.*, COALESCE(rp.title, '[deleted]') AS reportTitle,
             ri.observation_count AS observationCount,
             ri.last_observed_at AS lastObservedAt
      FROM report_indicators ri
      LEFT JOIN report_products rp ON rp.id = ri.report_id
      WHERE ri.active = 1
      ORDER BY ri.priority = 'high' DESC, ri.observation_count DESC, ri.created_at DESC
    `).all() as Array<IndicatorRow & { reportTitle: string; observationCount: number; lastObservedAt: number | null }>
  }

  /** Observations for one indicator. */
  observationsFor(indicatorId: string, limit: number = 50): Array<{
    id: string; intelId: string | null; intelTitle: string; matchedText: string;
    score: number; observedAt: number; reviewed: boolean
  }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT io.id, io.intel_report_id AS intelId,
             COALESCE(ir.title, '[deleted intel]') AS intelTitle,
             io.matched_text AS matchedText, io.match_score AS score,
             io.observed_at AS observedAt,
             CASE WHEN io.reviewed = 1 THEN 1 ELSE 0 END AS reviewed
      FROM indicator_observations io
      LEFT JOIN intel_reports ir ON ir.id = io.intel_report_id
      WHERE io.indicator_id = ?
      ORDER BY io.observed_at DESC
      LIMIT ?
    `).all(indicatorId, limit) as Array<{
      id: string; intelId: string | null; intelTitle: string; matchedText: string;
      score: number; observedAt: number; reviewed: 0 | 1
    }>
  }

  /** All recent hits across all indicators (for the watchlist page). */
  recentHits(limit: number = 50): IndicatorHit[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT io.id AS observationId, io.indicator_id AS indicatorId,
             ri.hypothesis, ri.direction, ri.priority,
             io.intel_report_id AS intelId,
             COALESCE(ir.title, '[deleted intel]') AS intelTitle,
             io.matched_text AS matchedText, io.match_score AS score,
             io.observed_at AS observedAt
      FROM indicator_observations io
      JOIN report_indicators ri ON ri.id = io.indicator_id
      LEFT JOIN intel_reports ir ON ir.id = io.intel_report_id
      ORDER BY io.observed_at DESC
      LIMIT ?
    `).all(limit) as Array<IndicatorHit & { observationId: string; observedAt: number }>
    return rows
  }

  stats(): { activeIndicators: number; totalObservations: number; highPriorityHits24h: number } {
    const db = getDatabase()
    const ai = (db.prepare(`SELECT COUNT(*) AS n FROM report_indicators WHERE active = 1`).get() as { n: number }).n
    const obs = (db.prepare(`SELECT COUNT(*) AS n FROM indicator_observations`).get() as { n: number }).n
    const since = Date.now() - 24 * 60 * 60 * 1000
    const hph = (db.prepare(`
      SELECT COUNT(*) AS n FROM indicator_observations io
      JOIN report_indicators ri ON ri.id = io.indicator_id
      WHERE io.observed_at >= ? AND ri.priority = 'high'
    `).get(since) as { n: number }).n
    return { activeIndicators: ai, totalObservations: obs, highPriorityHits24h: hph }
  }
}

export const indicatorTrackerService = new IndicatorTrackerService()
