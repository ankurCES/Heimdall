import log from 'electron-log'
import { getDatabase } from '../database'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 1.3 / 1.5 / 6.4 / 2.4 — Tradecraft completeness.
 *
 * Four tied capabilities built on existing tables:
 *
 *  (1.3) Bayesian credibility updating — when a new report corroborates
 *        or contradicts an existing claim, the existing claim's
 *        verification_score is updated via a bounded Bayesian step. Each
 *        adjustment is recorded in credibility_events so the analyst
 *        can see why a number moved.
 *
 *  (1.5) Source reliability degradation — every deception-scorer high-
 *        severity hit increments the source's deception_hits counter. At
 *        ≥3 hits we auto-downgrade its STANAG reliability grade one
 *        notch (A→B→C→D→E→F). Recorded in source_trust and chain-logged.
 *
 *  (6.4) Source contamination propagation — when a source is manually
 *        demoted (or auto-downgraded per 1.5), EVERY report sourced from
 *        it gets its verification_score multiplied by a demotion factor,
 *        with the adjustment logged per report.
 *
 *  (2.4) ACH diagnostic evidence highlighter — NOT written to DB (the
 *        UI queries via this service). Computes the diagnosticity score
 *        for each evidence row in an ACH session:
 *          diagnosticity = variance of (consistent,inconsistent,N/A)
 *        Higher variance = the evidence distinguishes hypotheses more
 *        sharply. Heuer's point: evidence consistent with ALL
 *        hypotheses is useless; high-variance evidence is gold.
 */

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'E', 'F'] as const
const DECEPTION_HIT_THRESHOLD = 3
const DEMOTION_MULTIPLIER = 0.7 // verification_score *= 0.7 on source demotion

export interface CredibilityEvent {
  id: number
  report_id: string
  prior_score: number | null
  new_score: number
  reason: string
  payload: string | null
  created_at: number
}

export interface SourceTrust {
  source_id: string
  reliability_grade: string
  deception_hits: number
  last_demoted_at: number | null
  demotion_reason: string | null
  original_grade: string | null
}

export class TradecraftService {
  // ─── Bayesian credibility (1.3) ─────────────────────────────────────
  /**
   * Update a claim's verification_score when a corroborating or
   * contradicting new report links to it. Simple bounded update:
   *
   *     delta = strength * corroboration_weight * (100 - prior) / 100    (if corroborates)
   *     delta = -strength * contradiction_weight * prior / 100           (if contradicts)
   *
   * Keeps scores in [0, 100]. Every adjustment logged.
   */
  adjustCredibility(args: {
    report_id: string
    kind: 'corroborate' | 'contradict'
    evidence_strength: number // 0..1
    source_report_id?: string | null
  }): number {
    const db = getDatabase()
    const row = db.prepare('SELECT verification_score FROM intel_reports WHERE id = ?').get(args.report_id) as { verification_score: number } | undefined
    if (!row) throw new Error(`No such report: ${args.report_id}`)
    const prior = row.verification_score
    const s = Math.max(0, Math.min(1, args.evidence_strength))
    let delta = 0
    if (args.kind === 'corroborate') {
      delta = s * 0.4 * ((100 - prior))
      // Softer: scale by how much room we have to update.
    } else {
      delta = -s * 0.5 * prior
    }
    const next = Math.max(0, Math.min(100, Math.round(prior + delta)))
    if (next === prior) return prior
    db.prepare('UPDATE intel_reports SET verification_score = ?, updated_at = ? WHERE id = ?')
      .run(next, Date.now(), args.report_id)
    db.prepare(`
      INSERT INTO credibility_events (report_id, prior_score, new_score, reason, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(args.report_id, prior, next,
      args.kind === 'corroborate' ? 'bayes.corroborate' : 'bayes.contradict',
      JSON.stringify({ strength: s, source_report_id: args.source_report_id ?? null }), Date.now())
    return next
  }

  // ─── Source degradation + contamination (1.5 + 6.4) ─────────────────
  private upsertSourceTrust(sourceId: string): SourceTrust {
    const db = getDatabase()
    const existing = db.prepare('SELECT * FROM source_trust WHERE source_id = ?').get(sourceId) as SourceTrust | undefined
    if (existing) return existing
    const now = Date.now()
    db.prepare(`
      INSERT INTO source_trust (source_id, reliability_grade, deception_hits, created_at, updated_at)
      VALUES (?, 'F', 0, ?, ?)
    `).run(sourceId, now, now)
    return db.prepare('SELECT * FROM source_trust WHERE source_id = ?').get(sourceId) as SourceTrust
  }

  /**
   * Called by the deception screener when a high-severity hit fires.
   * Increments the counter; if over threshold, downgrades the grade and
   * propagates a verification-score haircut to every report from that
   * source.
   */
  recordDeceptionHit(sourceId: string, reportId: string): { demoted: boolean; new_grade: string; haircut_reports: number } {
    const db = getDatabase()
    const trust = this.upsertSourceTrust(sourceId)
    const now = Date.now()
    const newHits = trust.deception_hits + 1

    // Decide whether to demote.
    const currentIdx = GRADE_ORDER.indexOf(trust.reliability_grade as typeof GRADE_ORDER[number])
    const shouldDemote = newHits % DECEPTION_HIT_THRESHOLD === 0 && currentIdx < GRADE_ORDER.length - 1
    const nextGrade = shouldDemote ? GRADE_ORDER[currentIdx + 1] : trust.reliability_grade

    db.prepare(`
      UPDATE source_trust SET deception_hits = ?, reliability_grade = ?,
        last_demoted_at = CASE WHEN ? THEN ? ELSE last_demoted_at END,
        demotion_reason = CASE WHEN ? THEN 'auto:deception_hits' ELSE demotion_reason END,
        original_grade = COALESCE(original_grade, ?),
        updated_at = ?
      WHERE source_id = ?
    `).run(newHits, nextGrade, shouldDemote ? 1 : 0, now,
      shouldDemote ? 1 : 0, trust.reliability_grade, now, sourceId)

    let haircutCount = 0
    if (shouldDemote) {
      haircutCount = this.propagateDemotion(sourceId, `auto:deception_${nextGrade}`)
      try {
        auditChainService.append('tradecraft.source_demoted', {
          entityType: 'source_trust', entityId: sourceId,
          payload: { from: trust.reliability_grade, to: nextGrade, trigger_report: reportId }
        })
      } catch { /* noop */ }
      log.warn(`tradecraft: source ${sourceId} demoted ${trust.reliability_grade}→${nextGrade} after ${newHits} deception hits; ${haircutCount} reports haircut`)
    }

    return { demoted: shouldDemote, new_grade: nextGrade, haircut_reports: haircutCount }
  }

  /**
   * Analyst-driven demotion. Accepts explicit new grade (overrides
   * auto-degradation tier), records reason, propagates haircut.
   */
  manualDemote(sourceId: string, toGrade: string, reason: string): { haircut_reports: number } {
    if (!GRADE_ORDER.includes(toGrade as typeof GRADE_ORDER[number])) throw new Error(`Invalid grade: ${toGrade}`)
    const db = getDatabase()
    const trust = this.upsertSourceTrust(sourceId)
    const now = Date.now()
    db.prepare(`
      UPDATE source_trust SET reliability_grade = ?, last_demoted_at = ?,
        demotion_reason = ?, original_grade = COALESCE(original_grade, ?), updated_at = ?
      WHERE source_id = ?
    `).run(toGrade, now, reason, trust.reliability_grade, now, sourceId)
    const haircut = this.propagateDemotion(sourceId, reason)
    try {
      auditChainService.append('tradecraft.source_manual_demoted', {
        entityType: 'source_trust', entityId: sourceId,
        payload: { from: trust.reliability_grade, to: toGrade, reason }
      })
    } catch { /* noop */ }
    return { haircut_reports: haircut }
  }

  private propagateDemotion(sourceId: string, reason: string): number {
    const db = getDatabase()
    const now = Date.now()
    const rows = db.prepare(
      'SELECT id, verification_score FROM intel_reports WHERE source_id = ? AND verification_score > 0'
    ).all(sourceId) as Array<{ id: string; verification_score: number }>
    const upd = db.prepare('UPDATE intel_reports SET verification_score = ? WHERE id = ?')
    const ins = db.prepare(
      'INSERT INTO credibility_events (report_id, prior_score, new_score, reason, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      for (const r of rows) {
        const next = Math.round(r.verification_score * DEMOTION_MULTIPLIER)
        if (next === r.verification_score) continue
        upd.run(next, r.id)
        ins.run(r.id, r.verification_score, next, reason,
          JSON.stringify({ source_id: sourceId, multiplier: DEMOTION_MULTIPLIER }), now)
      }
    })
    tx()
    return rows.length
  }

  listSourceTrust(): SourceTrust[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT source_id, reliability_grade, deception_hits, last_demoted_at,
             demotion_reason, original_grade
      FROM source_trust ORDER BY deception_hits DESC, source_id
    `).all() as SourceTrust[]
  }

  recentEvents(reportId: string, limit = 20): CredibilityEvent[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, report_id, prior_score, new_score, reason, payload, created_at
      FROM credibility_events WHERE report_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(reportId, limit) as CredibilityEvent[]
  }

  // ─── ACH diagnosticity (2.4) ────────────────────────────────────────
  /**
   * For each evidence row in an ACH session, compute a diagnosticity
   * score. Uses the variance of the ratings across hypotheses — evidence
   * rated identically across all hypotheses has zero variance and is
   * useless; evidence rating "consistent with H1, inconsistent with H2"
   * has high variance and is diagnostic.
   *
   * rating → numeric: consistent=+1, inconsistent=-1, N/A=0. We compute
   * population variance of the non-null ratings, then scale to 0..100
   * for the UI.
   */
  achDiagnosticity(sessionId: string): Array<{
    evidence_id: string; diagnosticity: number; ratings_count: number
  }> {
    const db = getDatabase()
    // Every evidence-score row for this session. ach_scores schema from
    // migration 017: session_id, evidence_id, hypothesis_id, rating.
    const rows = db.prepare(`
      SELECT s.evidence_id, s.rating
      FROM ach_scores s
      WHERE s.session_id = ?
    `).all(sessionId) as Array<{ evidence_id: string; rating: string | null }>

    const byEvidence = new Map<string, number[]>()
    for (const r of rows) {
      const n = r.rating === 'consistent' ? 1 : r.rating === 'inconsistent' ? -1 : 0
      const arr = byEvidence.get(r.evidence_id) ?? []
      arr.push(n)
      byEvidence.set(r.evidence_id, arr)
    }

    const out: Array<{ evidence_id: string; diagnosticity: number; ratings_count: number }> = []
    for (const [evId, vals] of byEvidence) {
      if (vals.length < 2) { out.push({ evidence_id: evId, diagnosticity: 0, ratings_count: vals.length }); continue }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
      // variance max is 1 (when half +1, half -1). Scale to 0..100.
      out.push({ evidence_id: evId, diagnosticity: Math.round(variance * 100), ratings_count: vals.length })
    }
    out.sort((a, b) => b.diagnosticity - a.diagnosticity)
    return out
  }
}

export const tradecraftService = new TradecraftService()
