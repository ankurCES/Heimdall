import log from 'electron-log'
import { generateId, timestamp } from '@common/utils/id'
import { getDatabase } from '../database'
import { dpbService } from '../iw/DpbService'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Cross-cutting B — Autonomous overnight collection cycle.
 *
 * On a schedule (default 02:30 local time, daily), runs the following
 * pipeline without analyst intervention:
 *
 *   1. Identify the top N open intel_gaps (ordered by severity +
 *      preliminary-report recency). These are the questions the
 *      analysts left unanswered at end-of-day.
 *   2. For each gap, derive 1-2 concise search terms from the gap
 *      description (heuristic — we use a cheap rule-based term extractor
 *      so overnight runs don't depend on LLM availability). A future
 *      enhancement can swap in an LLM call here.
 *   3. Insert those terms into watch_terms with source='overnight' and
 *      a 24h expiry. Existing collectors that honour watch terms will
 *      start pulling against them on their next schedule.
 *   4. Wait a configurable dwell window (default 4h in the cron
 *      schedule — i.e. cycle fires at 02:30, collectors have until 06:30
 *      to haul in relevant content before the brief generates).
 *   5. Generate a DPB spanning the overnight window so the analyst has
 *      a brief waiting for them at login.
 *
 * Expired watch terms are pruned on every run — so a 24h expiry means
 * last night's terms fall off before tonight's round begins.
 *
 * Design note: this deliberately does NOT hit the LLM during the cycle.
 * Cost predictability and offline-SCIF deployability matter more than
 * perfect term selection. An `llm-strategy` variant can be added later.
 */

export interface OvernightRun {
  id: number
  started_at: number
  finished_at: number
  gaps_considered: number
  terms_spawned: number
  reports_collected: number
  dpb_id: string | null
  summary: string | null
  duration_ms: number
}

/** Extract up to 2 high-signal noun phrases from a gap description. */
function extractTerms(description: string): string[] {
  if (!description) return []
  const stop = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'but', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that', 'this', 'these',
    'those', 'it', 'its', 'they', 'their', 'there', 'here', 'what', 'when',
    'where', 'how', 'why', 'who', 'which', 'into', 'from', 'by', 'as', 'at',
    'not', 'no', 'nor', 'so', 'if', 'then', 'else', 'than', 'unknown', 'unclear',
    'whether', 'any', 'some', 'all', 'both', 'each', 'other', 'such', 'no',
    'gap', 'missing', 'needs', 'need', 'further', 'additional', 'more'
  ])
  // Prefer capitalised / acronym tokens; fall back to top-2 unique tokens.
  const tokens = description
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 40 && !stop.has(t.toLowerCase()))

  const capitalised = tokens.filter((t) => /^[A-Z][A-Za-z0-9]*$/.test(t))
  if (capitalised.length >= 2) {
    return dedup(capitalised.slice(0, 2).map((t) => t.toLowerCase()))
  }
  if (capitalised.length === 1) {
    const rest = tokens.find((t) => t.toLowerCase() !== capitalised[0].toLowerCase())
    return dedup([capitalised[0].toLowerCase(), ...(rest ? [rest.toLowerCase()] : [])])
  }
  return dedup(tokens.slice(0, 2).map((t) => t.toLowerCase()))
}

function dedup(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    if (x && !seen.has(x)) { seen.add(x); out.push(x) }
  }
  return out
}

export class OvernightService {
  private readonly WINDOW_MS = 24 * 60 * 60 * 1000

  /** Remove watch terms whose expiry has passed. Returns count removed. */
  pruneExpiredTerms(): number {
    const db = getDatabase()
    const now = Date.now()
    const res = db.prepare('DELETE FROM watch_terms WHERE expires_at IS NOT NULL AND expires_at < ?').run(now)
    if (res.changes > 0) log.info(`overnight: pruned ${res.changes} expired watch term(s)`)
    return res.changes
  }

  /**
   * Full cycle. Intended to be invoked by a cron job; can also be run
   * on demand via IPC for testing.
   */
  async runCycle(opts: { maxGaps?: number; periodHours?: number } = {}): Promise<OvernightRun> {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare('INSERT INTO overnight_runs (started_at) VALUES (?)').run(started).lastInsertRowid)

    try {
      // Drop yesterday's expired terms before spawning new ones.
      this.pruneExpiredTerms()

      // Top open gaps — critical/high first, then newest.
      const maxGaps = opts.maxGaps ?? 20
      const gaps = db.prepare(`
        SELECT id, description, severity
        FROM intel_gaps
        WHERE status = 'open'
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 4 WHEN 'high' THEN 3
            WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
          END DESC,
          created_at DESC
        LIMIT ?
      `).all(maxGaps) as Array<{ id: string; description: string; severity: string }>

      // Spawn terms with 24h expiry. INSERT OR IGNORE so repeat runs don't
      // duplicate terms the analyst manually added.
      const now = Date.now()
      const expiresAt = now + this.WINDOW_MS
      const ins = db.prepare(`
        INSERT OR IGNORE INTO watch_terms
          (id, term, source, source_id, category, priority, enabled, hits, created_at, updated_at, expires_at)
        VALUES (?, ?, 'overnight', ?, ?, ?, 1, 0, ?, ?, ?)
      `)
      let spawned = 0
      const tx = db.transaction(() => {
        for (const g of gaps) {
          const terms = extractTerms(g.description)
          for (const term of terms) {
            const id = generateId()
            const priority = g.severity === 'critical' || g.severity === 'high' ? 'high' : 'medium'
            const res = ins.run(id, term, g.id, 'overnight', priority, now, now, expiresAt)
            if (res.changes > 0) spawned++
          }
        }
      })
      tx()

      // Count reports collected during the overnight window
      // (i.e. since the last cycle started, capped at WINDOW_MS).
      const windowStart = now - this.WINDOW_MS
      const collected = (db.prepare(
        'SELECT COUNT(*) AS n FROM intel_reports WHERE created_at >= ?'
      ).get(windowStart) as { n: number }).n

      // Generate a DPB spanning the same window. If this fails the cycle
      // still succeeds — the DPB is a nicety, not a correctness gate.
      let dpbId: string | null = null
      let summary: string | null = null
      try {
        const hours = opts.periodHours ?? 24
        const result = dpbService.generate({ periodHours: hours })
        dpbId = result.id
        summary = `Overnight brief ${hours}h — ${collected} reports collected, ${gaps.length} gaps tracked, ${spawned} new terms.`
      } catch (err) {
        log.warn(`overnight: DPB generation failed: ${(err as Error).message}`)
        summary = `Overnight cycle completed without DPB: ${(err as Error).message}`
      }

      const finished = Date.now()
      db.prepare(`
        UPDATE overnight_runs
        SET finished_at=?, gaps_considered=?, terms_spawned=?, reports_collected=?,
            dpb_id=?, summary=?, duration_ms=? WHERE id=?
      `).run(finished, gaps.length, spawned, collected, dpbId, summary, finished - started, runId)

      try {
        auditChainService.append('overnight.cycle', {
          entityType: 'overnight',
          entityId: String(runId),
          payload: { gaps: gaps.length, terms: spawned, reports: collected, dpb_id: dpbId }
        })
      } catch { /* noop */ }

      log.info(`overnight: cycle ${runId} — ${gaps.length} gaps → ${spawned} terms, ${collected} reports in window, dpb=${dpbId ?? 'none'}, ${finished - started}ms`)

      return {
        id: runId, started_at: started, finished_at: finished,
        gaps_considered: gaps.length, terms_spawned: spawned,
        reports_collected: collected, dpb_id: dpbId, summary,
        duration_ms: finished - started
      }
    } catch (err) {
      db.prepare('UPDATE overnight_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      log.error(`overnight: cycle failed: ${(err as Error).message}`)
      throw err
    }
  }

  latestRun(): OvernightRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, gaps_considered, terms_spawned,
             reports_collected, dpb_id, summary, duration_ms
      FROM overnight_runs
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as OvernightRun) || null
  }

  recentRuns(limit = 20): OvernightRun[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, started_at, finished_at, gaps_considered, terms_spawned,
             reports_collected, dpb_id, summary, duration_ms
      FROM overnight_runs
      WHERE finished_at IS NOT NULL
      ORDER BY id DESC LIMIT ?
    `).all(limit) as OvernightRun[]
  }
}

export const overnightService = new OvernightService()
