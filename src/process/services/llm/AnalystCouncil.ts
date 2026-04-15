import { llmService, type ChatMessage } from './LlmService'
import { getDatabase } from '../database'
import { auditChainService } from '../audit/AuditChainService'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

/**
 * Multi-Agent Analyst Council (Cross-cutting A in the agency roadmap).
 *
 * Five specialized agents independently reason over the same input then a
 * Synthesis agent reconciles. Each role's output is stored as its own row
 * in `analyst_council_outputs`; the run as a whole appears in
 * `analyst_council_runs`. The full transcript becomes an analytical
 * product itself — defensible in cross-examination.
 *
 * The council is triggered manually today (Phase 1C). A future cross-
 * cutting B (Autonomous Overnight Cycle) will trigger councils
 * automatically against fresh preliminary reports overnight.
 */

export const COUNCIL_ROLES = ['skeptic', 'red_team', 'counter_intel', 'citation_audit', 'synthesis'] as const
export type CouncilRole = typeof COUNCIL_ROLES[number]

export const ROLE_LABELS: Record<CouncilRole, string> = {
  skeptic: 'Skeptic',
  red_team: 'Red Team',
  counter_intel: 'Counter-Intelligence',
  citation_audit: 'Citation Auditor',
  synthesis: 'Synthesis'
}

const ROLE_DESCRIPTIONS: Record<CouncilRole, string> = {
  skeptic: 'Identifies weaknesses in the prevailing narrative',
  red_team: 'Adopts adversary perspective and argues against the analyst hypothesis',
  counter_intel: 'Flags coordinated narratives, deception heuristics, suspicious source overlap',
  citation_audit: 'Verifies every claim back to a primary source; flags hallucinations',
  synthesis: 'Reconciles the four critiques into the analyst-ready final assessment'
}

const ROLE_PROMPTS: Record<CouncilRole, string> = {
  skeptic: `You are the SKEPTIC AGENT in an intelligence analyst council. Your sole job is to find weaknesses in the prevailing narrative.

For each claim in the input intel:
- Flag any single-source claims (no corroborating evidence)
- Identify hedge words and unsupported assumptions
- Note where the evidence chain breaks
- Highlight where temporal or causal reasoning is weak
- Call out where the analyst is reasoning from absence of evidence

Output JSON only, no prose:
{
  "conclusion": "<one sentence summarizing the strongest weakness found>",
  "key_findings": ["finding 1", "finding 2", ...],
  "concerns": ["concern 1", "concern 2", ...],
  "confidence": "high|moderate|low",
  "citations": ["intel id or claim quote", ...]
}`,

  red_team: `You are the RED TEAM AGENT in an intelligence analyst council. Your sole job is to argue AGAINST the analyst's prevailing hypothesis as if you were the adversary trying to mislead Heimdall.

For the input intel:
- What would the adversary WANT us to conclude from these reports? Articulate that.
- What ALTERNATIVE explanation fits all the evidence equally well or better?
- What information would the adversary have suppressed if they wanted us to believe the prevailing hypothesis?
- Is there a deception campaign that would produce exactly this evidence pattern?

Output JSON only, no prose:
{
  "conclusion": "<one sentence stating the strongest alternative hypothesis>",
  "key_findings": ["alternative explanation 1", "alternative explanation 2", ...],
  "concerns": ["evidence pattern that would fit a deception", ...],
  "confidence": "high|moderate|low",
  "citations": ["intel id or claim quote", ...]
}`,

  counter_intel: `You are the COUNTER-INTELLIGENCE AGENT in an intelligence analyst council. Your sole job is deception detection.

For the input intel:
- Are sources coordinated? Same templates, identical phrasing, suspicious posting cadence?
- Are state-media outlets the only sources? Which way are they biased?
- Are entities/locations being repeatedly named in suspicious patterns?
- Is the source pattern itself a known deception signature (sock puppets, content laundering, narrative seeding)?
- Are claims contradicted by recent reliable intel?

Output JSON only, no prose:
{
  "conclusion": "<one sentence stating any detected deception or 'no deception indicators detected'>",
  "key_findings": ["deception indicator 1", ...],
  "concerns": ["coordination signal", "bias signal", ...],
  "confidence": "high|moderate|low",
  "citations": ["intel id or claim quote", ...]
}`,

  citation_audit: `You are the CITATION AUDITOR AGENT in an intelligence analyst council. Your sole job is to verify every claim back to a primary source.

For each substantive claim made in the input narrative:
- Is the claim explicitly supported by a cited intel report?
- Is the claim a hallucination — appearing in the narrative but NOT in any cited source?
- Is the claim a misattribution — cited to source X but actually originating in source Y?
- Are quotes verbatim or paraphrased?

Output JSON only, no prose:
{
  "conclusion": "<one sentence stating overall citation health>",
  "key_findings": ["claim X is well-cited to intel id Y", ...],
  "concerns": ["claim Z appears unsupported by any cited source", ...],
  "confidence": "high|moderate|low",
  "citations": ["intel id or claim quote", ...]
}`,

  synthesis: `You are the SYNTHESIS AGENT in an intelligence analyst council. The Skeptic, Red Team, Counter-Intel, and Citation Auditor agents have already given their critiques. Your job is to reconcile their input into the final analyst-ready product.

Use ICD 203 estimative-probability language:
  almost no chance, very unlikely, unlikely, roughly even chance, likely, very likely, almost certainly

Use STANAG 2511 ratings (A1–F6) when discussing source quality.

Output JSON only, no prose:
{
  "conclusion": "<one sentence final assessment in ICD 203 language>",
  "key_findings": ["finding incorporating skeptic + red team + ci + audit input", ...],
  "concerns": ["unresolved concerns warranting further collection", ...],
  "confidence": "high|moderate|low",
  "citations": ["intel id supporting the assessment", ...]
}`
}

interface RoleResult {
  conclusion: string
  key_findings: string[]
  concerns: string[]
  confidence: 'high' | 'moderate' | 'low'
  citations: string[]
}

interface CouncilRunInput {
  topic: string
  inputContent: string
  sessionId?: string
  preliminaryReportId?: string
  classification?: string
  connectionId?: string
}

interface CouncilOutput {
  id: string
  role: CouncilRole
  conclusion: string | null
  key_findings: string[]
  concerns: string[]
  confidence: string | null
  citations: string[]
  duration_ms: number | null
  status: 'pending' | 'success' | 'error'
  error: string | null
  created_at: number
}

export interface CouncilRun {
  id: string
  session_id: string | null
  preliminary_report_id: string | null
  topic: string
  input_summary: string | null
  status: 'pending' | 'running' | 'completed' | 'error'
  classification: string
  started_at: number
  completed_at: number | null
  error: string | null
  outputs: CouncilOutput[]
}

/** Try to parse the model's response as the {conclusion, key_findings, ...} shape. */
function parseRoleOutput(raw: string): RoleResult | null {
  try {
    // Strip code fences if the model wrapped the JSON
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    const json = JSON.parse(cleaned)
    return {
      conclusion: String(json.conclusion || ''),
      key_findings: Array.isArray(json.key_findings) ? json.key_findings.map(String) : [],
      concerns: Array.isArray(json.concerns) ? json.concerns.map(String) : [],
      confidence: ['high', 'moderate', 'low'].includes(json.confidence) ? json.confidence : 'moderate',
      citations: Array.isArray(json.citations) ? json.citations.map(String) : []
    }
  } catch {
    return null
  }
}

class AnalystCouncilService {
  /**
   * Run all 5 council roles in parallel against the input. Persists the run
   * + each role's output. Returns the populated CouncilRun.
   */
  async run(input: CouncilRunInput): Promise<CouncilRun> {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    const inputSummary = input.inputContent.replace(/\s+/g, ' ').slice(0, 500)
    const classification = input.classification || 'UNCLASSIFIED'

    db.prepare(`
      INSERT INTO analyst_council_runs
        (id, session_id, preliminary_report_id, topic, input_summary, status, classification, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      id, input.sessionId || null, input.preliminaryReportId || null,
      input.topic, inputSummary, classification, now, now, now
    )

    auditChainService.append('council.start', {
      entityType: 'analyst_council_run',
      entityId: id,
      classification,
      payload: { topic: input.topic, sessionId: input.sessionId, preliminaryReportId: input.preliminaryReportId }
    })

    log.info(`AnalystCouncil: starting run ${id} on topic "${input.topic.slice(0, 60)}"`)

    // Run skeptic + red_team + counter_intel + citation_audit in parallel.
    // Synthesis runs last because it consumes their outputs.
    const independentRoles: CouncilRole[] = ['skeptic', 'red_team', 'counter_intel', 'citation_audit']
    const independentResults = await Promise.allSettled(
      independentRoles.map((role) => this.runRole(id, role, input, []))
    )

    const independentOutputs: CouncilOutput[] = independentResults.map((settled, i) => {
      const role = independentRoles[i]
      if (settled.status === 'fulfilled') return settled.value
      return this.persistError(id, role, String(settled.reason))
    })

    // Synthesis sees all the previous outputs as additional context
    const synthesisOutput = await this.runRole(id, 'synthesis', input, independentOutputs)
      .catch((err) => this.persistError(id, 'synthesis', String(err)))

    const allOutputs = [...independentOutputs, synthesisOutput]
    const completedAt = timestamp()
    const overallStatus = allOutputs.some((o) => o.status === 'error') ? 'completed' : 'completed'

    db.prepare(`
      UPDATE analyst_council_runs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(overallStatus, completedAt, completedAt, id)

    auditChainService.append('council.complete', {
      entityType: 'analyst_council_run',
      entityId: id,
      classification,
      payload: {
        topic: input.topic,
        durationMs: completedAt - now,
        outputCount: allOutputs.length,
        errorCount: allOutputs.filter((o) => o.status === 'error').length
      }
    })

    log.info(`AnalystCouncil: completed run ${id} in ${completedAt - now}ms (${allOutputs.filter((o) => o.status === 'error').length} errors of ${allOutputs.length})`)

    return {
      id,
      session_id: input.sessionId || null,
      preliminary_report_id: input.preliminaryReportId || null,
      topic: input.topic,
      input_summary: inputSummary,
      status: 'completed',
      classification,
      started_at: now,
      completed_at: completedAt,
      error: null,
      outputs: allOutputs
    }
  }

  private async runRole(
    runId: string,
    role: CouncilRole,
    input: CouncilRunInput,
    priorOutputs: CouncilOutput[]
  ): Promise<CouncilOutput> {
    const db = getDatabase()
    const start = Date.now()

    let userContent = `TOPIC: ${input.topic}\n\nINPUT INTEL:\n${input.inputContent}`
    if (priorOutputs.length > 0) {
      userContent += '\n\n----\nPRIOR COUNCIL OUTPUTS (for synthesis):\n'
      for (const o of priorOutputs) {
        userContent += `\n[${ROLE_LABELS[o.role]}] (${o.confidence})\n  Conclusion: ${o.conclusion}\n  Key findings: ${o.key_findings.join('; ')}\n  Concerns: ${o.concerns.join('; ')}\n`
      }
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: ROLE_PROMPTS[role] },
      { role: 'user', content: userContent }
    ]

    let raw = ''
    let parsed: RoleResult | null = null
    let status: 'success' | 'error' = 'success'
    let errMsg: string | null = null

    try {
      raw = await llmService.chat(messages, input.connectionId)
      parsed = parseRoleOutput(raw)
      if (!parsed) {
        // Model returned non-JSON — keep the raw text in conclusion as fallback
        parsed = {
          conclusion: raw.slice(0, 500),
          key_findings: [],
          concerns: ['Council role returned unstructured output; unable to parse as JSON'],
          confidence: 'low',
          citations: []
        }
      }
    } catch (err) {
      status = 'error'
      errMsg = String(err)
      parsed = { conclusion: '', key_findings: [], concerns: [], confidence: 'low', citations: [] }
    }

    const duration = Date.now() - start
    const outputId = generateId()
    db.prepare(`
      INSERT INTO analyst_council_outputs
        (id, run_id, role, conclusion, key_findings, concerns, confidence, citations, duration_ms, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outputId, runId, role,
      parsed.conclusion || null,
      JSON.stringify(parsed.key_findings),
      JSON.stringify(parsed.concerns),
      parsed.confidence || null,
      JSON.stringify(parsed.citations),
      duration, status, errMsg, timestamp()
    )

    return {
      id: outputId,
      role,
      conclusion: parsed.conclusion || null,
      key_findings: parsed.key_findings,
      concerns: parsed.concerns,
      confidence: parsed.confidence,
      citations: parsed.citations,
      duration_ms: duration,
      status,
      error: errMsg,
      created_at: timestamp()
    }
  }

  private persistError(runId: string, role: CouncilRole, msg: string): CouncilOutput {
    const db = getDatabase()
    const id = generateId()
    db.prepare(`
      INSERT INTO analyst_council_outputs
        (id, run_id, role, conclusion, key_findings, concerns, confidence, citations, status, error, created_at)
      VALUES (?, ?, ?, NULL, '[]', '[]', NULL, '[]', 'error', ?, ?)
    `).run(id, runId, role, msg, timestamp())
    return {
      id, role, conclusion: null, key_findings: [], concerns: [], confidence: null,
      citations: [], duration_ms: null, status: 'error', error: msg, created_at: timestamp()
    }
  }

  /** Fetch a single run + its outputs. */
  get(runId: string): CouncilRun | null {
    const db = getDatabase()
    const run = db.prepare('SELECT * FROM analyst_council_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined
    if (!run) return null
    const outputs = db.prepare('SELECT * FROM analyst_council_outputs WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Array<Record<string, unknown>>
    return {
      id: run.id as string,
      session_id: (run.session_id as string) || null,
      preliminary_report_id: (run.preliminary_report_id as string) || null,
      topic: run.topic as string,
      input_summary: (run.input_summary as string) || null,
      status: run.status as CouncilRun['status'],
      classification: run.classification as string,
      started_at: run.started_at as number,
      completed_at: (run.completed_at as number) || null,
      error: (run.error as string) || null,
      outputs: outputs.map((o) => ({
        id: o.id as string,
        role: o.role as CouncilRole,
        conclusion: (o.conclusion as string) || null,
        key_findings: JSON.parse((o.key_findings as string) || '[]'),
        concerns: JSON.parse((o.concerns as string) || '[]'),
        confidence: (o.confidence as string) || null,
        citations: JSON.parse((o.citations as string) || '[]'),
        duration_ms: (o.duration_ms as number) || null,
        status: o.status as CouncilOutput['status'],
        error: (o.error as string) || null,
        created_at: o.created_at as number
      }))
    }
  }

  /** List recent runs (lightweight — outputs not loaded). */
  list(opts: { sessionId?: string; preliminaryReportId?: string; limit?: number } = {}) {
    const db = getDatabase()
    const limit = Math.min(opts.limit ?? 25, 100)
    let q = 'SELECT id, session_id, preliminary_report_id, topic, status, classification, started_at, completed_at FROM analyst_council_runs'
    const where: string[] = []
    const vals: unknown[] = []
    if (opts.sessionId) { where.push('session_id = ?'); vals.push(opts.sessionId) }
    if (opts.preliminaryReportId) { where.push('preliminary_report_id = ?'); vals.push(opts.preliminaryReportId) }
    if (where.length) q += ' WHERE ' + where.join(' AND ')
    q += ' ORDER BY started_at DESC LIMIT ?'
    vals.push(limit)
    return db.prepare(q).all(...vals)
  }

  /** Helper for the UI panel — describes each role for tooltips/help text. */
  static getRoleDescriptions(): Array<{ role: CouncilRole; label: string; description: string }> {
    return COUNCIL_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role] }))
  }
}

export const analystCouncilService = new AnalystCouncilService()
