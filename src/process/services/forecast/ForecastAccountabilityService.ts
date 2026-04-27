// ForecastAccountabilityService — extracts WEP-anchored forecast claims
// from published reports, tracks them against actual outcomes, and
// computes Brier scores per analyst/model/topic.
//
// This is the "calibration loop" promised in the v2.0 plan: every WEP
// claim ("60-80% likely") is recorded as a numeric prediction, and when
// the future arrives we can score how well-calibrated the analyst (or
// model) is.
//
// Brier score = (predicted_probability - actual_outcome)^2
// Lower is better. Perfect = 0.0, worst = 1.0.
//
// Aggregate Brier scores by analyst/model/topic give a rolling
// "accuracy" signal — surfaced on the Forecast Accountability dashboard.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import { wepFromText, confidenceFromText, WEP_SCALE } from '../report/ProbabilityLanguage'
import log from 'electron-log'
import type { ReportProduct } from '../report/ReportLibraryService'

export interface ForecastClaim {
  id: string
  reportId: string
  claimText: string
  wepTerm: string | null
  probabilityMidpoint: number | null
  confidenceLevel: 'low' | 'moderate' | 'high' | null
  subjectEntity: string | null
  timeHorizon: string | null
  horizonEndsAt: number | null
  extractedAt: number
}

export type OutcomeKind = 'occurred' | 'not_occurred' | 'partial' | 'undetermined'

export interface ForecastOutcome {
  id: string
  claimId: string
  outcome: OutcomeKind
  actualProbability: number | null
  evidence: string | null
  sourceIntelId: string | null
  recordedBy: string | null
  recordedAt: number
  brierScore: number | null
}

const TIME_HORIZON_PATTERNS: Array<{ re: RegExp; daysFn: (m: RegExpMatchArray) => number }> = [
  { re: /\b(?:within|in|over)\s+(\d+)\s+days?\b/i,    daysFn: (m) => parseInt(m[1], 10) },
  { re: /\b(?:within|in|over)\s+(\d+)\s+weeks?\b/i,   daysFn: (m) => parseInt(m[1], 10) * 7 },
  { re: /\b(?:within|in|over)\s+(\d+)\s+months?\b/i,  daysFn: (m) => parseInt(m[1], 10) * 30 },
  { re: /\b(?:within|in|over)\s+(\d+)\s+years?\b/i,   daysFn: (m) => parseInt(m[1], 10) * 365 },
  { re: /\bby\s+(?:end of\s+)?Q([1-4])\s+(\d{4})\b/i, daysFn: (m) => quartersFromNow(parseInt(m[1], 10), parseInt(m[2], 10)) },
  { re: /\bby\s+(\d{4})\b/, daysFn: (m) => yearsFromNow(parseInt(m[1], 10)) }
]

function quartersFromNow(quarter: number, year: number): number {
  const targetMonth = (quarter - 1) * 3 + 2  // end of quarter
  const target = new Date(year, targetMonth, 30)
  return Math.max(1, Math.round((target.getTime() - Date.now()) / 86400000))
}

function yearsFromNow(year: number): number {
  const target = new Date(year, 11, 31)
  return Math.max(1, Math.round((target.getTime() - Date.now()) / 86400000))
}

/** Split a body into sentences (naive). */
function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 600)
}

export class ForecastAccountabilityService {
  /**
   * Extract forecast claims from a report's body. Heuristic:
   *   - Each sentence is checked for a WEP term
   *   - The probability midpoint comes from the WEP scale
   *   - Confidence level is parsed from "(High Confidence)" markers
   *     either inline or in the same sentence
   *   - Time horizon parsed by regex; horizon_ends_at computed if possible
   *
   * Persists deduplicated rows. Returns the new count.
   */
  extractAndPersist(report: ReportProduct): number {
    const sentences = splitSentences(report.bodyMarkdown)
    const out: ForecastClaim[] = []

    for (const sentence of sentences) {
      const band = wepFromText(sentence)
      if (!band) continue

      const conf = confidenceFromText(sentence)
      const horizon = this.extractHorizon(sentence)
      const subject = this.extractSubject(sentence)

      out.push({
        id: generateId(),
        reportId: report.id,
        claimText: sentence.slice(0, 800),
        wepTerm: band.term,
        probabilityMidpoint: band.midpoint,
        confidenceLevel: conf,
        subjectEntity: subject,
        timeHorizon: horizon?.text ?? null,
        horizonEndsAt: horizon?.endsAt ?? null,
        extractedAt: Date.now()
      })
    }

    if (out.length === 0) return 0

    // Drop existing claims for this report to avoid duplicates on re-extract
    const db = getDatabase()
    db.prepare(`DELETE FROM forecast_claims WHERE report_id = ?`).run(report.id)

    const insert = db.prepare(`
      INSERT INTO forecast_claims
        (id, report_id, claim_text, wep_term, probability_midpoint,
         confidence_level, subject_entity, time_horizon, horizon_ends_at,
         extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const tx = db.transaction(() => {
      for (const c of out) {
        try {
          insert.run(c.id, c.reportId, c.claimText, c.wepTerm,
            c.probabilityMidpoint, c.confidenceLevel, c.subjectEntity,
            c.timeHorizon, c.horizonEndsAt, c.extractedAt)
        } catch (err) { log.debug(`forecast claim insert failed: ${err}`) }
      }
    })
    tx()
    log.info(`ForecastAccountability: extracted ${out.length} forecast claims from ${report.id}`)
    return out.length
  }

  private extractHorizon(text: string): { text: string; endsAt: number | null } | null {
    for (const { re, daysFn } of TIME_HORIZON_PATTERNS) {
      const m = text.match(re)
      if (m) {
        try {
          const days = daysFn(m)
          return {
            text: m[0],
            endsAt: Date.now() + days * 86400000
          }
        } catch { /* fall through */ }
      }
    }
    return null
  }

  private extractSubject(text: string): string | null {
    // Capture the first capitalized multi-word phrase as a candidate subject
    const m = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/)
    return m ? m[1].toLowerCase() : null
  }

  // ── Outcome recording ────────────────────────────────────────────────

  recordOutcome(opts: {
    claimId: string
    outcome: OutcomeKind
    actualProbability?: number
    evidence?: string
    sourceIntelId?: string
    recordedBy?: string
  }): { ok: boolean; brierScore?: number; error?: string } {
    const db = getDatabase()
    const claim = db.prepare(
      `SELECT probability_midpoint AS p FROM forecast_claims WHERE id = ?`
    ).get(opts.claimId) as { p: number | null } | undefined
    if (!claim) return { ok: false, error: 'claim not found' }

    let actual = opts.actualProbability
    if (actual === undefined) {
      actual = opts.outcome === 'occurred' ? 1.0
        : opts.outcome === 'not_occurred' ? 0.0
        : opts.outcome === 'partial' ? 0.5
        : 0.5  // undetermined treated as 0.5 (no information)
    }

    let brier: number | null = null
    if (claim.p !== null && opts.outcome !== 'undetermined') {
      brier = Math.pow(claim.p - actual, 2)
    }

    try {
      // Upsert
      db.prepare(`
        INSERT INTO forecast_outcomes
          (id, claim_id, outcome, actual_probability, evidence, source_intel_id,
           recorded_by, recorded_at, brier_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          outcome = excluded.outcome,
          actual_probability = excluded.actual_probability,
          evidence = excluded.evidence,
          source_intel_id = excluded.source_intel_id,
          recorded_by = excluded.recorded_by,
          recorded_at = excluded.recorded_at,
          brier_score = excluded.brier_score
      `).run(
        generateId(), opts.claimId, opts.outcome, actual,
        opts.evidence ?? null, opts.sourceIntelId ?? null,
        opts.recordedBy ?? 'analyst', Date.now(), brier
      )
      return { ok: true, brierScore: brier ?? undefined }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  // ── Queries / aggregates ────────────────────────────────────────────

  /** All claims for a report. */
  claimsFor(reportId: string): ForecastClaim[] {
    return getDatabase().prepare(`
      SELECT id, report_id AS reportId, claim_text AS claimText,
             wep_term AS wepTerm, probability_midpoint AS probabilityMidpoint,
             confidence_level AS confidenceLevel, subject_entity AS subjectEntity,
             time_horizon AS timeHorizon, horizon_ends_at AS horizonEndsAt,
             extracted_at AS extractedAt
      FROM forecast_claims WHERE report_id = ?
      ORDER BY extracted_at DESC
    `).all(reportId) as ForecastClaim[]
  }

  /** All claims with outcome status (left-joined) — feeds the dashboard list. */
  pendingClaims(limit: number = 100): Array<ForecastClaim & {
    reportTitle: string
    outcome: string | null
    actualProbability: number | null
    brierScore: number | null
    isOverdue: boolean
  }> {
    const db = getDatabase()
    const now = Date.now()
    const rows = db.prepare(`
      SELECT fc.id, fc.report_id AS reportId, fc.claim_text AS claimText,
             fc.wep_term AS wepTerm, fc.probability_midpoint AS probabilityMidpoint,
             fc.confidence_level AS confidenceLevel, fc.subject_entity AS subjectEntity,
             fc.time_horizon AS timeHorizon, fc.horizon_ends_at AS horizonEndsAt,
             fc.extracted_at AS extractedAt,
             COALESCE(rp.title, '[deleted]') AS reportTitle,
             fo.outcome, fo.actual_probability AS actualProbability,
             fo.brier_score AS brierScore
      FROM forecast_claims fc
      LEFT JOIN forecast_outcomes fo ON fo.claim_id = fc.id
      LEFT JOIN report_products rp ON rp.id = fc.report_id
      ORDER BY
        CASE WHEN fo.outcome IS NULL AND fc.horizon_ends_at < ? THEN 0
             WHEN fo.outcome IS NULL THEN 1
             ELSE 2 END,
        fc.extracted_at DESC
      LIMIT ?
    `).all(now, limit) as Array<ForecastClaim & {
      reportTitle: string; outcome: string | null;
      actualProbability: number | null; brierScore: number | null
    }>
    return rows.map((r) => ({
      ...r,
      isOverdue: r.horizonEndsAt !== null && r.horizonEndsAt < now && r.outcome === null
    }))
  }

  /** Aggregated Brier score statistics. */
  stats(): {
    totalClaims: number
    withOutcomes: number
    overall_brier: number | null
    by_wep: Array<{ wepTerm: string; count: number; avgBrier: number | null }>
    calibrationCurve: Array<{ predictedBucket: number; actualRate: number; n: number }>
  } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM forecast_claims`).get() as { n: number }).n
    const withOutcomes = (db.prepare(`SELECT COUNT(*) AS n FROM forecast_outcomes WHERE brier_score IS NOT NULL`).get() as { n: number }).n
    const overall = (db.prepare(`SELECT AVG(brier_score) AS avg FROM forecast_outcomes WHERE brier_score IS NOT NULL`).get() as { avg: number | null })

    const byWep = db.prepare(`
      SELECT fc.wep_term AS wepTerm, COUNT(*) AS count,
             AVG(fo.brier_score) AS avgBrier
      FROM forecast_claims fc
      LEFT JOIN forecast_outcomes fo ON fo.claim_id = fc.id
      WHERE fc.wep_term IS NOT NULL
      GROUP BY fc.wep_term
      ORDER BY MIN(fc.probability_midpoint)
    `).all() as Array<{ wepTerm: string; count: number; avgBrier: number | null }>

    // Calibration curve: bucket predictions into 7 WEP buckets, compute the
    // observed "occurrence rate" within each bucket. A perfectly calibrated
    // analyst lies on the diagonal (predicted = actual).
    const calibration: Array<{ predictedBucket: number; actualRate: number; n: number }> = []
    for (const band of WEP_SCALE) {
      const inBucket = db.prepare(`
        SELECT AVG(fo.actual_probability) AS rate, COUNT(*) AS n
        FROM forecast_claims fc
        JOIN forecast_outcomes fo ON fo.claim_id = fc.id
        WHERE fc.probability_midpoint >= ? AND fc.probability_midpoint <= ?
              AND fo.actual_probability IS NOT NULL
              AND fo.outcome IN ('occurred', 'not_occurred')
      `).get(band.min, band.max) as { rate: number | null; n: number }
      if (inBucket.n > 0 && inBucket.rate !== null) {
        calibration.push({
          predictedBucket: band.midpoint,
          actualRate: inBucket.rate,
          n: inBucket.n
        })
      }
    }

    return {
      totalClaims: total,
      withOutcomes,
      overall_brier: overall.avg,
      by_wep: byWep,
      calibrationCurve: calibration
    }
  }

  /** Auto-record outcomes from confirming/refuting indicator hits. */
  autoRecordFromIndicatorHits(): { recorded: number } {
    const db = getDatabase()
    // Find unrecorded claims whose subject_entity appears in a recent
    // indicator observation. Conservative: only auto-record for indicators
    // tagged "high" priority on the same report.
    const candidates = db.prepare(`
      SELECT fc.id AS claimId, fc.subject_entity AS subj, fc.report_id AS reportId
      FROM forecast_claims fc
      LEFT JOIN forecast_outcomes fo ON fo.claim_id = fc.id
      WHERE fo.id IS NULL AND fc.subject_entity IS NOT NULL
      LIMIT 200
    `).all() as Array<{ claimId: string; subj: string; reportId: string }>

    let recorded = 0
    for (const cand of candidates) {
      const hit = db.prepare(`
        SELECT io.id, ri.direction
        FROM indicator_observations io
        JOIN report_indicators ri ON ri.id = io.indicator_id
        WHERE ri.report_id = ?
          AND ri.priority = 'high'
          AND lower(io.matched_text) LIKE ?
        LIMIT 1
      `).get(cand.reportId, `%${cand.subj}%`) as { id: string; direction: string } | undefined
      if (!hit) continue
      const outcome: OutcomeKind = hit.direction === 'confirming' ? 'occurred' : 'not_occurred'
      const r = this.recordOutcome({
        claimId: cand.claimId,
        outcome,
        recordedBy: 'auto',
        evidence: `Auto-recorded from high-priority I&W observation ${hit.id}`,
        sourceIntelId: undefined
      })
      if (r.ok) recorded++
    }
    if (recorded > 0) log.info(`ForecastAccountability: auto-recorded ${recorded} outcomes from indicator hits`)
    return { recorded }
  }
}

export const forecastAccountabilityService = new ForecastAccountabilityService()
