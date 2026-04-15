import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { auditChainService } from '../audit/AuditChainService'
import { llmService, type ChatMessage } from '../llm/LlmService'
import log from 'electron-log'

/**
 * Analysis of Competing Hypotheses (ACH) — Themes 2.1–2.4, 2.6 of the
 * agency roadmap. Implements Heuer's gold-standard methodology:
 *
 *   1. Define 3–5 mutually exclusive hypotheses
 *   2. List every relevant piece of evidence
 *   3. Score each piece against each hypothesis (CC / C / N / I / II)
 *   4. Pick the hypothesis with the LEAST disconfirming evidence
 *      (NOT the most confirming) — the Heuer principle
 *   5. Identify "diagnostic" evidence — pieces that would distinguish
 *      between hypotheses if found
 *
 * Score scale (matches Heuer's notation in Psychology of Intelligence
 * Analysis):
 *   CC = strongly consistent       (+2)
 *   C  = consistent                (+1)
 *   N  = neutral / not applicable  ( 0)
 *   I  = inconsistent              (-1)
 *   II = strongly inconsistent     (-2)
 *
 * The Heuer principle is implemented in `analyzeSession` — the leading
 * hypothesis is the one with the smallest sum of NEGATIVE scores
 * (weighted by evidence credibility + weight), NOT the largest sum of
 * positive scores.
 */

export type Score = 'CC' | 'C' | 'N' | 'I' | 'II'

export const SCORE_VALUES: Record<Score, number> = {
  CC: 2,
  C: 1,
  N: 0,
  I: -1,
  II: -2
}

export const SCORE_LABELS: Record<Score, string> = {
  CC: 'Strongly consistent',
  C: 'Consistent',
  N: 'Neutral / N/A',
  I: 'Inconsistent',
  II: 'Strongly inconsistent'
}

export interface AchSession {
  id: string
  title: string
  question: string | null
  chat_session_id: string | null
  preliminary_report_id: string | null
  classification: string
  status: 'open' | 'closed'
  conclusion: string | null
  conclusion_hypothesis_id: string | null
  conclusion_confidence: string | null
  created_at: number
  updated_at: number
  hypotheses?: AchHypothesis[]
  evidence?: AchEvidence[]
  scores?: AchScore[]
  analysis?: AchAnalysis
}

export interface AchHypothesis {
  id: string
  session_id: string
  ordinal: number
  label: string
  description: string | null
  source: 'analyst' | 'agent'
  created_at: number
}

export interface AchEvidence {
  id: string
  session_id: string
  ordinal: number
  claim: string
  source_intel_id: string | null
  source_humint_id: string | null
  source_label: string | null
  weight: number
  credibility: number | null
  notes: string | null
  created_at: number
}

export interface AchScore {
  session_id: string
  hypothesis_id: string
  evidence_id: string
  score: Score
  rationale: string | null
  updated_at: number
}

/** Per-hypothesis scorecard — used to identify the leading hypothesis. */
export interface HypothesisScorecard {
  hypothesis_id: string
  /** Sum of positive scores (CC + C) weighted by evidence weight. Higher = more supporting evidence. */
  consistent_weight: number
  /** Sum of NEGATIVE scores (I + II) weighted by evidence weight. SMALLER absolute value = better per Heuer. */
  inconsistent_weight: number
  /** Total scored evidence count. */
  scored_count: number
  /** True if this hypothesis is the leading candidate (least disconfirming). */
  is_leading: boolean
}

/** Per-evidence diagnostic value — high = would distinguish hypotheses. */
export interface EvidenceDiagnostic {
  evidence_id: string
  /** 0..1 — how strongly this evidence varies across hypotheses. 1 = some hypotheses score it CC and others II. */
  diagnostic_value: number
  /** True if score variance is high enough to flag this as a "diagnostic" piece. */
  is_diagnostic: boolean
}

export interface AchAnalysis {
  scorecard: HypothesisScorecard[]
  diagnostics: EvidenceDiagnostic[]
  leading_hypothesis_id: string | null
  unscored_count: number
  total_evidence: number
  total_hypotheses: number
}

class AchServiceImpl {
  // ---- Session CRUD ----

  createSession(input: {
    title: string
    question?: string
    chat_session_id?: string
    preliminary_report_id?: string
    classification?: string
  }): AchSession {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    const cls = input.classification || 'UNCLASSIFIED'
    db.prepare(`
      INSERT INTO ach_sessions
        (id, title, question, chat_session_id, preliminary_report_id, classification, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id, input.title, input.question || null,
      input.chat_session_id || null, input.preliminary_report_id || null,
      cls, now, now
    )
    auditChainService.append('ach.session.create', {
      entityType: 'ach_session', entityId: id, classification: cls,
      payload: { title: input.title }
    })
    return this.getSession(id)!
  }

  updateSession(id: string, patch: Partial<Pick<AchSession,
    'title' | 'question' | 'classification' | 'status' | 'conclusion' | 'conclusion_hypothesis_id' | 'conclusion_confidence'
  >>): AchSession {
    const db = getDatabase()
    const fields: string[] = []
    const vals: unknown[] = []
    for (const k of ['title', 'question', 'classification', 'status', 'conclusion', 'conclusion_hypothesis_id', 'conclusion_confidence'] as const) {
      if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(patch[k]) }
    }
    fields.push('updated_at = ?'); vals.push(timestamp())
    if (fields.length > 1) {
      db.prepare(`UPDATE ach_sessions SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return this.getSession(id)!
  }

  deleteSession(id: string): void {
    const db = getDatabase()
    const sess = db.prepare('SELECT title, classification FROM ach_sessions WHERE id = ?').get(id) as { title: string; classification: string } | undefined
    db.prepare('DELETE FROM ach_sessions WHERE id = ?').run(id)
    if (sess) {
      auditChainService.append('ach.session.delete', {
        entityType: 'ach_session', entityId: id, classification: sess.classification,
        payload: { title: sess.title }
      })
    }
  }

  getSession(id: string): AchSession | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM ach_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    const session = this.mapSession(row)
    session.hypotheses = this.listHypotheses(id)
    session.evidence = this.listEvidence(id)
    session.scores = this.listScores(id)
    session.analysis = this.analyzeSession(session)
    return session
  }

  listSessions(opts: { status?: 'open' | 'closed' } = {}): AchSession[] {
    const db = getDatabase()
    let q = 'SELECT * FROM ach_sessions'
    const vals: unknown[] = []
    if (opts.status) { q += ' WHERE status = ?'; vals.push(opts.status) }
    q += ' ORDER BY updated_at DESC'
    const rows = db.prepare(q).all(...vals) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapSession(r))
  }

  // ---- Hypothesis CRUD ----

  addHypothesis(input: { session_id: string; label: string; description?: string; source?: 'analyst' | 'agent' }): AchHypothesis {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    const ordinal = ((db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS m FROM ach_hypotheses WHERE session_id = ?').get(input.session_id) as { m: number }).m) + 1
    db.prepare(`
      INSERT INTO ach_hypotheses (id, session_id, ordinal, label, description, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.session_id, ordinal, input.label, input.description || null, input.source || 'analyst', now)
    this.touchSession(input.session_id)
    return this.getHypothesis(id)!
  }

  updateHypothesis(id: string, patch: { label?: string; description?: string }): AchHypothesis {
    const db = getDatabase()
    const fields: string[] = []
    const vals: unknown[] = []
    if (patch.label !== undefined) { fields.push('label = ?'); vals.push(patch.label) }
    if (patch.description !== undefined) { fields.push('description = ?'); vals.push(patch.description) }
    if (fields.length > 0) {
      db.prepare(`UPDATE ach_hypotheses SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id)
      const sess = db.prepare('SELECT session_id FROM ach_hypotheses WHERE id = ?').get(id) as { session_id: string } | undefined
      if (sess) this.touchSession(sess.session_id)
    }
    return this.getHypothesis(id)!
  }

  deleteHypothesis(id: string): void {
    const db = getDatabase()
    const row = db.prepare('SELECT session_id FROM ach_hypotheses WHERE id = ?').get(id) as { session_id: string } | undefined
    db.prepare('DELETE FROM ach_hypotheses WHERE id = ?').run(id)
    if (row) this.touchSession(row.session_id)
  }

  getHypothesis(id: string): AchHypothesis | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM ach_hypotheses WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapHypothesis(row) : null
  }

  listHypotheses(sessionId: string): AchHypothesis[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM ach_hypotheses WHERE session_id = ? ORDER BY ordinal ASC').all(sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapHypothesis(r))
  }

  // ---- Evidence CRUD ----

  addEvidence(input: {
    session_id: string
    claim: string
    source_intel_id?: string
    source_humint_id?: string
    source_label?: string
    weight?: number
    credibility?: number
    notes?: string
  }): AchEvidence {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    const ordinal = ((db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS m FROM ach_evidence WHERE session_id = ?').get(input.session_id) as { m: number }).m) + 1

    // Auto-link credibility from intel_reports if a source_intel_id was supplied
    let credibility = input.credibility ?? null
    if (input.source_intel_id && credibility == null) {
      const r = db.prepare('SELECT credibility FROM intel_reports WHERE id = ?').get(input.source_intel_id) as { credibility: number | null } | undefined
      if (r?.credibility != null) credibility = r.credibility
    }

    db.prepare(`
      INSERT INTO ach_evidence (id, session_id, ordinal, claim, source_intel_id, source_humint_id, source_label, weight, credibility, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.session_id, ordinal, input.claim,
      input.source_intel_id || null, input.source_humint_id || null,
      input.source_label || null, input.weight ?? 1.0, credibility,
      input.notes || null, now
    )
    this.touchSession(input.session_id)
    return this.getEvidence(id)!
  }

  updateEvidence(id: string, patch: Partial<Pick<AchEvidence, 'claim' | 'source_label' | 'weight' | 'credibility' | 'notes'>>): AchEvidence {
    const db = getDatabase()
    const fields: string[] = []
    const vals: unknown[] = []
    for (const k of ['claim', 'source_label', 'weight', 'credibility', 'notes'] as const) {
      if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(patch[k]) }
    }
    if (fields.length > 0) {
      db.prepare(`UPDATE ach_evidence SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id)
      const row = db.prepare('SELECT session_id FROM ach_evidence WHERE id = ?').get(id) as { session_id: string } | undefined
      if (row) this.touchSession(row.session_id)
    }
    return this.getEvidence(id)!
  }

  deleteEvidence(id: string): void {
    const db = getDatabase()
    const row = db.prepare('SELECT session_id FROM ach_evidence WHERE id = ?').get(id) as { session_id: string } | undefined
    db.prepare('DELETE FROM ach_evidence WHERE id = ?').run(id)
    if (row) this.touchSession(row.session_id)
  }

  getEvidence(id: string): AchEvidence | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM ach_evidence WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapEvidence(row) : null
  }

  listEvidence(sessionId: string): AchEvidence[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM ach_evidence WHERE session_id = ? ORDER BY ordinal ASC').all(sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapEvidence(r))
  }

  // ---- Scoring ----

  setScore(input: {
    session_id: string
    hypothesis_id: string
    evidence_id: string
    score: Score
    rationale?: string
  }): AchScore {
    const db = getDatabase()
    const now = timestamp()
    db.prepare(`
      INSERT INTO ach_scores (session_id, hypothesis_id, evidence_id, score, rationale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hypothesis_id, evidence_id) DO UPDATE SET
        score = excluded.score, rationale = excluded.rationale, updated_at = excluded.updated_at
    `).run(input.session_id, input.hypothesis_id, input.evidence_id, input.score, input.rationale || null, now)
    this.touchSession(input.session_id)
    return {
      session_id: input.session_id, hypothesis_id: input.hypothesis_id,
      evidence_id: input.evidence_id, score: input.score,
      rationale: input.rationale || null, updated_at: now
    }
  }

  clearScore(hypothesis_id: string, evidence_id: string): void {
    const db = getDatabase()
    const row = db.prepare('SELECT session_id FROM ach_scores WHERE hypothesis_id = ? AND evidence_id = ?').get(hypothesis_id, evidence_id) as { session_id: string } | undefined
    db.prepare('DELETE FROM ach_scores WHERE hypothesis_id = ? AND evidence_id = ?').run(hypothesis_id, evidence_id)
    if (row) this.touchSession(row.session_id)
  }

  listScores(sessionId: string): AchScore[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM ach_scores WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      session_id: r.session_id as string,
      hypothesis_id: r.hypothesis_id as string,
      evidence_id: r.evidence_id as string,
      score: r.score as Score,
      rationale: (r.rationale as string) || null,
      updated_at: r.updated_at as number
    }))
  }

  // ---- Analysis (Heuer principle + diagnostic value) ----

  analyzeSession(session: AchSession): AchAnalysis {
    const hypotheses = session.hypotheses || []
    const evidence = session.evidence || []
    const scores = session.scores || []

    const scoreMap = new Map<string, Score>()
    for (const s of scores) scoreMap.set(`${s.hypothesis_id}:${s.evidence_id}`, s.score)

    // Per-hypothesis weighted sums
    const cards: HypothesisScorecard[] = hypotheses.map((h) => {
      let consistent = 0
      let inconsistent = 0
      let scoredCount = 0
      for (const ev of evidence) {
        const score = scoreMap.get(`${h.id}:${ev.id}`)
        if (!score || score === 'N') continue
        scoredCount++
        const numeric = SCORE_VALUES[score]
        // weight by evidence weight + credibility (1=most credible → weight=1, 6=cannot judge → 0.2)
        const credFactor = ev.credibility != null ? Math.max(0.2, (7 - ev.credibility) / 6) : 0.6
        const w = ev.weight * credFactor
        if (numeric > 0) consistent += numeric * w
        else inconsistent += Math.abs(numeric) * w
      }
      return {
        hypothesis_id: h.id,
        consistent_weight: Math.round(consistent * 100) / 100,
        inconsistent_weight: Math.round(inconsistent * 100) / 100,
        scored_count: scoredCount,
        is_leading: false
      }
    })

    // Heuer principle: leading hypothesis is the one with the SMALLEST
    // inconsistent_weight (not the largest consistent_weight). Ties broken
    // by larger consistent_weight, then by hypothesis ordinal.
    if (cards.length > 0) {
      let bestIdx = -1
      let bestInc = Infinity
      let bestCons = -Infinity
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i]
        if (c.scored_count === 0) continue
        if (c.inconsistent_weight < bestInc ||
            (c.inconsistent_weight === bestInc && c.consistent_weight > bestCons)) {
          bestInc = c.inconsistent_weight
          bestCons = c.consistent_weight
          bestIdx = i
        }
      }
      if (bestIdx >= 0) cards[bestIdx].is_leading = true
    }

    // Diagnostic value per evidence — variance of scores across hypotheses.
    // High variance = some hypotheses score it CC and others II → highly
    // diagnostic. Low variance = all hypotheses score it the same → not
    // useful for distinguishing.
    const diagnostics: EvidenceDiagnostic[] = evidence.map((ev) => {
      const vals: number[] = []
      for (const h of hypotheses) {
        const s = scoreMap.get(`${h.id}:${ev.id}`)
        if (s) vals.push(SCORE_VALUES[s])
      }
      if (vals.length < 2) {
        return { evidence_id: ev.id, diagnostic_value: 0, is_diagnostic: false }
      }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
      // Max variance for the {-2..2} scale is 4. Normalize.
      const normalized = Math.min(1, variance / 4)
      return {
        evidence_id: ev.id,
        diagnostic_value: Math.round(normalized * 100) / 100,
        is_diagnostic: normalized >= 0.5
      }
    })

    return {
      scorecard: cards,
      diagnostics,
      leading_hypothesis_id: cards.find((c) => c.is_leading)?.hypothesis_id || null,
      unscored_count: hypotheses.length * evidence.length - scores.length,
      total_evidence: evidence.length,
      total_hypotheses: hypotheses.length
    }
  }

  // ---- AI hypothesis generator ----

  /**
   * Use the LLM to draft 3 alternative hypotheses for the analyst's
   * question. Hypotheses are added to the session with `source: 'agent'`.
   *
   * Adversarial framing: prompt explicitly asks for hypotheses that
   * COMPETE — not variations of the analyst's prevailing view.
   */
  async generateHypotheses(sessionId: string, opts: { connectionId?: string; count?: number } = {}): Promise<AchHypothesis[]> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`ACH session not found: ${sessionId}`)
    const count = Math.min(Math.max(opts.count ?? 3, 2), 5)

    const evidenceSummary = (session.evidence || []).slice(0, 20).map((e, i) => `${i + 1}. ${e.claim}`).join('\n') || '(no evidence cards yet)'
    const existingHypotheses = (session.hypotheses || []).map((h) => `- ${h.label}`).join('\n') || '(none yet)'

    const systemPrompt = `You are an analytic-tradecraft assistant trained on the ACH (Analysis of Competing Hypotheses) methodology of Richards Heuer. Your job is to generate ${count} MUTUALLY EXCLUSIVE hypotheses that the analyst should consider for the given question.

Critical rules:
- Hypotheses MUST compete — they cannot all be true simultaneously
- One hypothesis must be the prevailing/conventional view; the others must be genuine alternatives
- DO NOT generate variations of the same idea
- Prefer hypotheses that would lead to OBSERVABLY DIFFERENT evidence patterns
- Avoid hypotheses already on the analyst's list

Output strict JSON only:
{
  "hypotheses": [
    {"label": "<concise hypothesis title under 80 chars>", "description": "<2-3 sentence elaboration>"},
    ...
  ]
}`

    const userPrompt = `QUESTION: ${session.title}${session.question ? `\n\nQUESTION DETAIL: ${session.question}` : ''}

EXISTING HYPOTHESES (do not duplicate):
${existingHypotheses}

KNOWN EVIDENCE:
${evidenceSummary}

Generate ${count} new competing hypotheses.`

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    const raw = await llmService.chat(messages, opts.connectionId)
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim()
    let parsed: { hypotheses: Array<{ label: string; description?: string }> }
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // Fallback: treat each line as a hypothesis label
      const labels = raw.split('\n').filter((l) => l.trim().length > 5).slice(0, count)
      parsed = { hypotheses: labels.map((l) => ({ label: l.replace(/^[-•\d.]\s*/, '').slice(0, 200) })) }
    }

    const created: AchHypothesis[] = []
    for (const h of parsed.hypotheses || []) {
      if (!h.label) continue
      created.push(this.addHypothesis({
        session_id: sessionId,
        label: h.label.slice(0, 200),
        description: h.description?.slice(0, 600),
        source: 'agent'
      }))
    }

    log.info(`ACH: generated ${created.length} alternative hypotheses for session ${sessionId}`)
    return created
  }

  // ---- Internal helpers ----

  private touchSession(sessionId: string): void {
    const db = getDatabase()
    db.prepare('UPDATE ach_sessions SET updated_at = ? WHERE id = ?').run(timestamp(), sessionId)
  }

  private mapSession(row: Record<string, unknown>): AchSession {
    return {
      id: row.id as string,
      title: row.title as string,
      question: (row.question as string) || null,
      chat_session_id: (row.chat_session_id as string) || null,
      preliminary_report_id: (row.preliminary_report_id as string) || null,
      classification: row.classification as string,
      status: row.status as 'open' | 'closed',
      conclusion: (row.conclusion as string) || null,
      conclusion_hypothesis_id: (row.conclusion_hypothesis_id as string) || null,
      conclusion_confidence: (row.conclusion_confidence as string) || null,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number
    }
  }

  private mapHypothesis(row: Record<string, unknown>): AchHypothesis {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      ordinal: row.ordinal as number,
      label: row.label as string,
      description: (row.description as string) || null,
      source: row.source as 'analyst' | 'agent',
      created_at: row.created_at as number
    }
  }

  private mapEvidence(row: Record<string, unknown>): AchEvidence {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      ordinal: row.ordinal as number,
      claim: row.claim as string,
      source_intel_id: (row.source_intel_id as string) || null,
      source_humint_id: (row.source_humint_id as string) || null,
      source_label: (row.source_label as string) || null,
      weight: row.weight as number,
      credibility: row.credibility as number | null,
      notes: (row.notes as string) || null,
      created_at: row.created_at as number
    }
  }
}

export const achService = new AchServiceImpl()
