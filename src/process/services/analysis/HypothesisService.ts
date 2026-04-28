// HypothesisService — v1.9.1 operationalised Analysis of Competing
// Hypotheses (ACH).
//
// The analyst writes a hypothesis ("FIN7 is reorganising with new
// command-and-control infrastructure"). The system then:
//
//   1. On a 15-minute cron, walks every active hypothesis and pulls
//      intel reports created since the last evaluation that haven't
//      been scored against this hypothesis yet (UNIQUE(hypothesis_id,
//      intel_id) guards re-scoring).
//   2. For each (hypothesis, intel) pair, calls the LLM with a strict
//      structured prompt that returns
//         { verdict: supports|refutes|neutral|undetermined,
//           confidence: 0..1, reasoning: string }
//   3. Persists the result. The analyst can override any verdict;
//      the running tally + UI always honour the override.
//
// Per-tick caps prevent the cron from blowing the LLM budget when
// many new intel arrive. Hypotheses can be anchored to a canonical
// entity to limit scoring to mentions of that entity (cheaper +
// more focused).

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'
import { cronService } from '../cron/CronService'
import { llmService } from '../llm/LlmService'

export type HypothesisStatus = 'active' | 'paused' | 'closed'
export type Verdict = 'supports' | 'refutes' | 'neutral' | 'undetermined'

export interface Hypothesis {
  id: string
  name: string
  statement: string
  status: HypothesisStatus
  anchor_canonical_id: string | null
  scope_hint: string | null
  created_at: number
  updated_at: number
  last_evaluated_at: number | null
}

export interface HypothesisEvidence {
  id: string
  hypothesis_id: string
  intel_id: string
  verdict: Verdict
  confidence: number
  reasoning: string | null
  model: string | null
  evaluated_at: number
  analyst_override: Verdict | null
  analyst_override_at: number | null
}

export interface HypothesisWithStats extends Hypothesis {
  evidence_count: number
  supports_count: number
  refutes_count: number
  neutral_count: number
  undetermined_count: number
  /** Net score = supports − refutes, weighted by confidence. Positive
   *  means evidence leans toward supporting; negative leans against. */
  net_score: number
  anchor_canonical_value: string | null
}

export interface EvidenceWithReport extends HypothesisEvidence {
  report_title: string | null
  report_severity: string | null
  report_source_name: string | null
  report_created_at: number | null
}

const CRON_EXPR = '*/15 * * * *'                   // every 15 minutes
const MAX_EVALUATIONS_PER_TICK_PER_HYPOTHESIS = 8  // cap LLM calls per cron pass
const MAX_INTEL_LOOKBACK_HOURS = 72                // window for "recent intel"

const SYSTEM_PROMPT = `You evaluate a single intelligence report against an analyst-defined hypothesis.

Output STRICT JSON, no markdown, no preamble:
{
  "verdict": "supports" | "refutes" | "neutral" | "undetermined",
  "confidence": <number 0..1>,
  "reasoning": "<one or two sentences explaining the call>"
}

Rules:
  · "supports"     — the report contains evidence that, if true, makes the hypothesis MORE likely.
  · "refutes"      — the report contains evidence that, if true, makes the hypothesis LESS likely.
  · "neutral"      — the report is on-topic but doesn't shift the probability either way.
  · "undetermined" — insufficient information to score (off-topic, too short, ambiguous).
  · Confidence reflects how clearly the evidence reads, not the hypothesis's overall plausibility.
  · Use Words of Estimative Probability conservatively in reasoning.
  · Do NOT speculate beyond what's in the report.`

interface IntelLite {
  id: string
  title: string
  content: string | null
  summary: string | null
  source_name: string | null
  severity: string
  created_at: number
}

export class HypothesisService {
  private cronId = 'hypothesis-evaluator'
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    cronService.schedule(this.cronId, CRON_EXPR, 'Hypothesis auto-evaluator', async () => {
      await this.runOnce().catch((err) =>
        log.warn(`hypothesis: cron tick failed: ${(err as Error).message}`)
      )
    })
  }

  stop(): void {
    if (!this.started) return
    cronService.unschedule(this.cronId)
    this.started = false
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  list(): HypothesisWithStats[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT
        h.*,
        c.canonical_value AS anchor_canonical_value,
        COUNT(e.id) AS evidence_count,
        SUM(CASE WHEN COALESCE(e.analyst_override, e.verdict) = 'supports' THEN 1 ELSE 0 END) AS supports_count,
        SUM(CASE WHEN COALESCE(e.analyst_override, e.verdict) = 'refutes' THEN 1 ELSE 0 END) AS refutes_count,
        SUM(CASE WHEN COALESCE(e.analyst_override, e.verdict) = 'neutral' THEN 1 ELSE 0 END) AS neutral_count,
        SUM(CASE WHEN COALESCE(e.analyst_override, e.verdict) = 'undetermined' THEN 1 ELSE 0 END) AS undetermined_count,
        COALESCE(SUM(
          CASE COALESCE(e.analyst_override, e.verdict)
            WHEN 'supports' THEN e.confidence
            WHEN 'refutes' THEN -e.confidence
            ELSE 0
          END
        ), 0) AS net_score
      FROM hypotheses h
      LEFT JOIN hypothesis_evidence e ON e.hypothesis_id = h.id
      LEFT JOIN canonical_entities c ON c.id = h.anchor_canonical_id
      GROUP BY h.id
      ORDER BY h.updated_at DESC
    `).all() as HypothesisWithStats[]
  }

  get(id: string): HypothesisWithStats | null {
    const rows = this.list()
    return rows.find((r) => r.id === id) ?? null
  }

  create(args: { name: string; statement: string; anchorCanonicalId?: string | null; scopeHint?: string | null }): Hypothesis {
    const db = getDatabase()
    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO hypotheses
        (id, name, statement, status, anchor_canonical_id, scope_hint, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(id, args.name.trim(), args.statement.trim(),
           args.anchorCanonicalId?.trim() || null,
           args.scopeHint?.trim() || null,
           now, now)
    log.info(`hypothesis: created ${id} "${args.name}"`)
    return db.prepare(`SELECT * FROM hypotheses WHERE id = ?`).get(id) as Hypothesis
  }

  update(id: string, patch: Partial<Pick<Hypothesis, 'name' | 'statement' | 'status' | 'anchor_canonical_id' | 'scope_hint'>>): Hypothesis | null {
    const db = getDatabase()
    const cur = db.prepare(`SELECT * FROM hypotheses WHERE id = ?`).get(id) as Hypothesis | undefined
    if (!cur) return null
    const merged = { ...cur, ...patch, updated_at: Date.now() }
    db.prepare(`
      UPDATE hypotheses
      SET name = ?, statement = ?, status = ?, anchor_canonical_id = ?, scope_hint = ?, updated_at = ?
      WHERE id = ?
    `).run(merged.name, merged.statement, merged.status,
           merged.anchor_canonical_id, merged.scope_hint, merged.updated_at, id)
    return db.prepare(`SELECT * FROM hypotheses WHERE id = ?`).get(id) as Hypothesis
  }

  remove(id: string): void {
    const db = getDatabase()
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM hypothesis_evidence WHERE hypothesis_id = ?`).run(id)
      db.prepare(`DELETE FROM hypotheses WHERE id = ?`).run(id)
    })
    tx()
  }

  evidenceFor(hypothesisId: string, limit = 100): EvidenceWithReport[] {
    return getDatabase().prepare(`
      SELECT
        e.*,
        r.title AS report_title,
        r.severity AS report_severity,
        r.source_name AS report_source_name,
        r.created_at AS report_created_at
      FROM hypothesis_evidence e
      LEFT JOIN intel_reports r ON r.id = e.intel_id
      WHERE e.hypothesis_id = ?
      ORDER BY e.evaluated_at DESC
      LIMIT ?
    `).all(hypothesisId, limit) as EvidenceWithReport[]
  }

  /** Manually flip a verdict. Re-scoring still happens during cron
   *  ticks but the running tally always honours the override. */
  setAnalystOverride(evidenceId: string, verdict: Verdict | null): void {
    const db = getDatabase()
    db.prepare(`
      UPDATE hypothesis_evidence
      SET analyst_override = ?, analyst_override_at = ?
      WHERE id = ?
    `).run(verdict, verdict ? Date.now() : null, evidenceId)
  }

  // ── Evaluator ────────────────────────────────────────────────────

  /** Score one intel report against one hypothesis. Idempotent —
   *  refuses to re-evaluate an existing pair (unless `force` is true,
   *  reserved for a future "Re-grade with newer model" button). */
  async evaluatePair(args: { hypothesisId: string; intelId: string; force?: boolean }): Promise<HypothesisEvidence | null> {
    const db = getDatabase()
    const h = db.prepare(`SELECT * FROM hypotheses WHERE id = ?`).get(args.hypothesisId) as Hypothesis | undefined
    if (!h) throw new Error(`Hypothesis not found: ${args.hypothesisId}`)
    const intel = db.prepare(`
      SELECT id, title, content, summary, source_name, severity, created_at
      FROM intel_reports WHERE id = ? AND COALESCE(quarantined, 0) = 0
    `).get(args.intelId) as IntelLite | undefined
    if (!intel) throw new Error(`Intel not found: ${args.intelId}`)

    if (!args.force) {
      const existing = db.prepare(`
        SELECT * FROM hypothesis_evidence WHERE hypothesis_id = ? AND intel_id = ?
      `).get(args.hypothesisId, args.intelId) as HypothesisEvidence | undefined
      if (existing) return existing
    }

    let parsed: { verdict: Verdict; confidence: number; reasoning: string } | null = null
    let model: string | null = null
    try {
      const userPrompt = buildEvaluationPrompt(h, intel)
      const result = await llmService.chatForTask('analysis', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ])
      model = result.model
      parsed = parseEvaluation(result.response)
    } catch (err) {
      log.warn(`hypothesis: LLM evaluation failed for (${args.hypothesisId}, ${args.intelId}): ${(err as Error).message}`)
    }

    if (!parsed) {
      // Fall back to 'undetermined' so the row is recorded and we
      // don't keep re-asking on the next cron tick. Reasoning carries
      // the failure note for the analyst.
      parsed = {
        verdict: 'undetermined',
        confidence: 0,
        reasoning: 'LLM evaluation failed or returned unparseable JSON; recorded as undetermined to avoid re-scoring loop.'
      }
    }

    const now = Date.now()
    const id = generateId()
    db.prepare(`
      INSERT OR REPLACE INTO hypothesis_evidence
        (id, hypothesis_id, intel_id, verdict, confidence, reasoning, model, evaluated_at,
         analyst_override, analyst_override_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(id, args.hypothesisId, args.intelId, parsed.verdict,
           Math.max(0, Math.min(1, parsed.confidence)),
           parsed.reasoning ?? '', model, now)
    db.prepare(`UPDATE hypotheses SET last_evaluated_at = ? WHERE id = ?`).run(now, args.hypothesisId)
    return db.prepare(`SELECT * FROM hypothesis_evidence WHERE id = ?`).get(id) as HypothesisEvidence
  }

  /** Cron tick: walk every active hypothesis, pull recent intel
   *  it hasn't seen yet (capped per tick), evaluate each pair. */
  async runOnce(): Promise<{ scanned: number; evaluated: number }> {
    if (!isDatabaseReady()) return { scanned: 0, evaluated: 0 }
    const db = getDatabase()
    const active = db.prepare(`
      SELECT * FROM hypotheses WHERE status = 'active'
    `).all() as Hypothesis[]
    if (active.length === 0) return { scanned: 0, evaluated: 0 }

    const since = Date.now() - MAX_INTEL_LOOKBACK_HOURS * 60 * 60 * 1000
    let totalEvaluated = 0
    for (const h of active) {
      // Pull candidate intel ids for this hypothesis. Anchor-aware:
      // when anchor_canonical_id is set, we only look at reports
      // mentioning that entity.
      let candidates: Array<{ id: string }>
      if (h.anchor_canonical_id) {
        candidates = db.prepare(`
          SELECT DISTINCT r.id
          FROM intel_entities e
          JOIN intel_reports r ON r.id = e.report_id
          WHERE e.canonical_id = ?
            AND r.created_at >= ?
            AND COALESCE(r.quarantined, 0) = 0
            AND r.id NOT IN (
              SELECT intel_id FROM hypothesis_evidence WHERE hypothesis_id = ?
            )
          ORDER BY r.created_at DESC
          LIMIT ?
        `).all(h.anchor_canonical_id, since, h.id, MAX_EVALUATIONS_PER_TICK_PER_HYPOTHESIS) as Array<{ id: string }>
      } else {
        candidates = db.prepare(`
          SELECT id FROM intel_reports
          WHERE created_at >= ? AND COALESCE(quarantined, 0) = 0
            AND id NOT IN (
              SELECT intel_id FROM hypothesis_evidence WHERE hypothesis_id = ?
            )
          ORDER BY
            CASE severity
              WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3
              WHEN 'low' THEN 2 ELSE 1
            END DESC,
            created_at DESC
          LIMIT ?
        `).all(since, h.id, MAX_EVALUATIONS_PER_TICK_PER_HYPOTHESIS) as Array<{ id: string }>
      }

      for (const c of candidates) {
        try {
          await this.evaluatePair({ hypothesisId: h.id, intelId: c.id })
          totalEvaluated++
        } catch (err) {
          log.debug(`hypothesis: pair eval failed (${h.id}, ${c.id}): ${(err as Error).message}`)
        }
      }
      if (candidates.length > 0) {
        log.info(`hypothesis: '${h.name}' evaluated ${candidates.length} new intel report(s)`)
      }
    }
    return { scanned: active.length, evaluated: totalEvaluated }
  }
}

function buildEvaluationPrompt(h: Hypothesis, intel: IntelLite): string {
  const lines: string[] = []
  lines.push(`HYPOTHESIS: "${h.statement}"`)
  if (h.scope_hint) lines.push(`SCOPE: ${h.scope_hint}`)
  lines.push('')
  lines.push(`INTEL REPORT [intel:${intel.id.slice(0, 8)}] (severity=${intel.severity}, source=${intel.source_name ?? 'unknown'}, ts=${new Date(intel.created_at).toISOString()})`)
  lines.push(`Title: ${intel.title}`)
  if (intel.summary) lines.push(`Summary: ${intel.summary.slice(0, 600)}`)
  if (intel.content) {
    const content = intel.content.replace(/\s+/g, ' ').trim().slice(0, 3000)
    lines.push(`Content: ${content}${intel.content.length > 3000 ? '…' : ''}`)
  }
  lines.push('')
  lines.push('Now output the JSON object.')
  return lines.join('\n')
}

/** Tolerant JSON extractor — the LLM sometimes wraps the response
 *  in ```json fences or adds a trailing sentence. Strips both, then
 *  validates the shape. */
function parseEvaluation(raw: string): { verdict: Verdict; confidence: number; reasoning: string } | null {
  if (!raw) return null
  // Strip leading/trailing markdown fences if present.
  let body = raw.trim()
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  // Find the first balanced { … } block.
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = body.slice(start, end + 1)
  let obj: { verdict?: string; confidence?: number; reasoning?: string }
  try { obj = JSON.parse(slice) } catch { return null }
  const verdict = String(obj.verdict ?? '').toLowerCase() as Verdict
  if (!['supports', 'refutes', 'neutral', 'undetermined'].includes(verdict)) return null
  const confidence = Number(obj.confidence)
  if (!Number.isFinite(confidence)) return null
  return {
    verdict,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : ''
  }
}

export const hypothesisService = new HypothesisService()
