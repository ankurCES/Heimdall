// SourceReliabilityService — tracks every source's track record over
// time and converts it into a live Admiralty rating (A-F).
//
// Data flow:
//   1. Every new intel_report bumps total_claims for that source
//   2. ClaimEvaluator (separate file) marks claims confirmed/contradicted
//      by checking later evidence
//   3. Nightly cron recomputes the Admiralty rating from the running tally
//
// Admiralty letter assignment from confirmation rate:
//   A — confirm rate >= 0.90 (completely reliable)
//   B — confirm rate >= 0.75 AND >= 5 evaluated claims (usually reliable)
//   C — confirm rate >= 0.55 (fairly reliable)
//   D — confirm rate >= 0.35 (not usually reliable)
//   E — confirm rate <  0.35 with >= 5 evaluated claims (unreliable)
//   F — fewer than 5 evaluated claims (cannot be judged)

import { getDatabase } from '../database'
import log from 'electron-log'

export interface SourceReliability {
  sourceKey: string
  displayName: string | null
  currentRating: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  currentScore: number
  totalClaims: number
  confirmedClaims: number
  contradictedClaims: number
  unverifiedClaims: number
  lastEvaluatedAt: number | null
}

export class SourceReliabilityService {
  /**
   * Register a new claim made by a source. Called from the
   * IntelStorageService whenever a new intel_report is inserted.
   */
  registerClaim(sourceKey: string, displayName: string | null, claimText: string, reportId?: string): void {
    if (!sourceKey || !claimText) return
    const db = getDatabase()
    const now = Date.now()
    try {
      // Ensure the source row exists
      db.prepare(`
        INSERT OR IGNORE INTO source_reliability
          (source_key, display_name, current_rating, current_score, total_claims, confirmed_claims, contradicted_claims)
        VALUES (?, ?, 'F', 0.5, 0, 0, 0)
      `).run(sourceKey, displayName ?? sourceKey)

      // Insert the claim
      const id = crypto.randomUUID ? crypto.randomUUID() : `claim_${now}_${Math.random().toString(36).slice(2)}`
      db.prepare(`
        INSERT INTO source_claims
          (id, source_key, report_id, claim_text, status, asserted_at)
        VALUES (?, ?, ?, ?, 'unverified', ?)
      `).run(id, sourceKey, reportId ?? null, claimText.slice(0, 1000), now)

      // Bump counter
      db.prepare(`
        UPDATE source_reliability SET total_claims = total_claims + 1 WHERE source_key = ?
      `).run(sourceKey)
    } catch (err) {
      log.debug(`registerClaim failed for ${sourceKey}: ${err}`)
    }
  }

  /** Mark a claim as confirmed by later evidence. */
  markConfirmed(claimId: string, evidence?: string): void {
    this.markStatus(claimId, 'confirmed', evidence)
  }

  /** Mark a claim as contradicted by later evidence. */
  markContradicted(claimId: string, evidence?: string): void {
    this.markStatus(claimId, 'contradicted', evidence)
  }

  private markStatus(claimId: string, status: 'confirmed' | 'contradicted' | 'partial', evidence?: string): void {
    const db = getDatabase()
    const now = Date.now()
    const claim = db.prepare(`SELECT source_key, status FROM source_claims WHERE id = ?`)
      .get(claimId) as { source_key: string; status: string } | undefined
    if (!claim) return
    if (claim.status === status) return

    db.prepare(`
      UPDATE source_claims
      SET status = ?, evidence_json = ?, evaluated_at = ?
      WHERE id = ?
    `).run(status, evidence ? JSON.stringify({ note: evidence }) : null, now, claimId)

    // Bump source counter
    if (status === 'confirmed') {
      db.prepare(`UPDATE source_reliability SET confirmed_claims = confirmed_claims + 1 WHERE source_key = ?`)
        .run(claim.source_key)
    } else if (status === 'contradicted') {
      db.prepare(`UPDATE source_reliability SET contradicted_claims = contradicted_claims + 1 WHERE source_key = ?`)
        .run(claim.source_key)
    }
  }

  /** Recompute the Admiralty rating for one source. */
  recomputeRating(sourceKey: string): void {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT total_claims AS t, confirmed_claims AS c, contradicted_claims AS x
      FROM source_reliability WHERE source_key = ?
    `).get(sourceKey) as { t: number; c: number; x: number } | undefined
    if (!row) return

    const evaluated = row.c + row.x
    let rating: SourceReliability['currentRating'] = 'F'
    let score = 0.5

    if (evaluated >= 5) {
      const confirmRate = row.c / evaluated
      score = confirmRate
      if (confirmRate >= 0.90) rating = 'A'
      else if (confirmRate >= 0.75) rating = 'B'
      else if (confirmRate >= 0.55) rating = 'C'
      else if (confirmRate >= 0.35) rating = 'D'
      else rating = 'E'
    } else if (evaluated >= 1) {
      // Partial signal — favor C with low confidence
      score = (row.c / Math.max(1, evaluated)) * 0.7 + 0.15
      rating = 'C'
    }

    db.prepare(`
      UPDATE source_reliability
      SET current_rating = ?, current_score = ?, last_evaluated_at = ?
      WHERE source_key = ?
    `).run(rating, score, Date.now(), sourceKey)
  }

  /** Recompute every source. Called by the nightly cron. */
  recomputeAll(): { updated: number } {
    const db = getDatabase()
    const sources = db.prepare(`SELECT source_key FROM source_reliability`).all() as Array<{ source_key: string }>
    let n = 0
    for (const s of sources) {
      this.recomputeRating(s.source_key)
      n++
    }
    log.info(`SourceReliability: recomputed ratings for ${n} sources`)
    return { updated: n }
  }

  // ── Queries ──────────────────────────────────────────────────────────

  list(filter: { minClaims?: number; ratings?: string[] } = {}): SourceReliability[] {
    const db = getDatabase()
    const where: string[] = []
    const params: unknown[] = []
    if (filter.minClaims) {
      where.push(`total_claims >= ?`)
      params.push(filter.minClaims)
    }
    if (filter.ratings && filter.ratings.length > 0) {
      where.push(`current_rating IN (${filter.ratings.map(() => '?').join(',')})`)
      params.push(...filter.ratings)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = db.prepare(`
      SELECT source_key AS sourceKey, display_name AS displayName,
             current_rating AS currentRating, current_score AS currentScore,
             total_claims AS totalClaims, confirmed_claims AS confirmedClaims,
             contradicted_claims AS contradictedClaims,
             (total_claims - confirmed_claims - contradicted_claims) AS unverifiedClaims,
             last_evaluated_at AS lastEvaluatedAt
      FROM source_reliability
      ${whereSql}
      ORDER BY current_score DESC, total_claims DESC
    `).all(...params) as SourceReliability[]
    return rows
  }

  get(sourceKey: string): SourceReliability | null {
    const r = this.list().find((s) => s.sourceKey === sourceKey)
    return r || null
  }

  /** Recent claim history for one source — feeds the drill-down panel. */
  claimsFor(sourceKey: string, limit: number = 100): Array<{
    id: string; claimText: string; status: string; assertedAt: number; evaluatedAt: number | null
  }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, claim_text AS claimText, status,
             asserted_at AS assertedAt, evaluated_at AS evaluatedAt
      FROM source_claims
      WHERE source_key = ?
      ORDER BY asserted_at DESC
      LIMIT ?
    `).all(sourceKey, limit) as Array<{
      id: string; claimText: string; status: string; assertedAt: number; evaluatedAt: number | null
    }>
  }

  stats(): { totalSources: number; byRating: Record<string, number> } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM source_reliability`).get() as { n: number }).n
    const byRating: Record<string, number> = {}
    for (const r of db.prepare(`SELECT current_rating AS r, COUNT(*) AS n FROM source_reliability GROUP BY current_rating`).all() as Array<{ r: string; n: number }>) {
      byRating[r.r] = r.n
    }
    return { totalSources: total, byRating }
  }
}

export const sourceReliabilityService = new SourceReliabilityService()
