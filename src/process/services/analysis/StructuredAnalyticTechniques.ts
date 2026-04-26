// Structured Analytic Techniques (SATs) — ICD 203 standard 4 ("Incorporates
// analysis of alternatives") demands that analytic products explicitly
// consider competing hypotheses, contrarian views, and alternative futures.
//
// This module implements four SATs from the IC's standard tradecraft toolkit:
//
//   1. AnalysisOfCompetingHypotheses (ACH) — matrix-based hypothesis testing
//   2. KeyAssumptionsCheck — surfaces and challenges implicit assumptions
//   3. RedTeamAnalysis — devil's advocacy + adversary perspective
//   4. IndicatorsFramework — observable indicators that would confirm/refute
//
// Each technique takes a synthesized assessment + the underlying findings
// and produces a structured annex that gets appended to the report.
//
// All four are LLM-backed (no rule-based heuristics) — they're inherently
// interpretive analytical tasks. Each uses the 'analysis' task class so
// model routing picks the largest reasoning-capable model available.

import { llmService, type ChatMessage } from '../llm/LlmService'
import log from 'electron-log'

// ============================================================================
// 1. ANALYSIS OF COMPETING HYPOTHESES (ACH)
// ============================================================================
//
// ACH is the IC's gold-standard SAT for adversary intent / capability questions.
// Process: enumerate plausible hypotheses → score each evidence item for
// consistency with each hypothesis → reject hypotheses with most inconsistencies.
// Heuer's key insight: focus on disconfirming evidence, not confirming.

export interface AchHypothesis {
  id: string                      // H1, H2, H3, …
  statement: string               // "China will invade Taiwan in 2027"
  inconsistencies: number         // count of evidence rated "inconsistent"
  confidence: 'high' | 'moderate' | 'low'
  rejected: boolean               // True if too many inconsistencies
}

export interface AchEvidenceCell {
  evidenceId: string              // E1, E2, …
  hypothesisId: string            // H1, H2, …
  rating: 'C' | 'I' | 'NA'        // Consistent / Inconsistent / Not Applicable
  weight: number                  // 1 (low credibility) … 5 (high)
}

export interface AchEvidenceItem {
  id: string
  description: string
  source: string
  reliability: number             // 1-5
}

export interface AchMatrix {
  hypotheses: AchHypothesis[]
  evidence: AchEvidenceItem[]
  cells: AchEvidenceCell[]
  leadingHypothesisId: string
  rationale: string
  generatedAt: number
}

const ACH_PROMPT = `You are running an Analysis of Competing Hypotheses (ACH) using Richards Heuer's standard methodology.

Given the analytic question and a set of findings:

1. Enumerate 3-5 PLAUSIBLE, MUTUALLY EXCLUSIVE hypotheses. Hypotheses must be alternative answers — not variations of the same answer. Include at least one "null" hypothesis (e.g. "no change" / "status quo").

2. List 5-12 KEY EVIDENCE ITEMS drawn from the findings. Each must be specific (cite source).

3. Score each evidence item against each hypothesis: C (consistent), I (inconsistent), or NA (not applicable / no bearing).

4. Identify the hypothesis with FEWEST inconsistencies (Heuer's rule). That is the leading hypothesis.

5. Briefly explain which hypotheses you reject and why (focus on disconfirming evidence).

Respond ONLY in this JSON shape (no prose outside the JSON):

{
  "hypotheses": [
    {"id": "H1", "statement": "...", "inconsistencies": 0, "confidence": "high", "rejected": false},
    {"id": "H2", "statement": "...", "inconsistencies": 4, "confidence": "low", "rejected": true}
  ],
  "evidence": [
    {"id": "E1", "description": "...", "source": "...", "reliability": 4}
  ],
  "cells": [
    {"evidenceId": "E1", "hypothesisId": "H1", "rating": "C", "weight": 4},
    {"evidenceId": "E1", "hypothesisId": "H2", "rating": "I", "weight": 4}
  ],
  "leadingHypothesisId": "H1",
  "rationale": "H1 has the fewest inconsistencies (0). H2 is rejected because…"
}`

export async function runAchMatrix(
  query: string,
  findings: string[],
  connectionId?: string
): Promise<AchMatrix | null> {
  const truncatedFindings = findings.slice(0, 12).map((f) => f.slice(0, 400)).join('\n---\n')
  const prompt = `${ACH_PROMPT}\n\nANALYTIC QUESTION: ${query}\n\nFINDINGS:\n${truncatedFindings}`

  try {
    const raw = await llmService.completeForTask('analysis', prompt, connectionId, 2048)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON object in response')
    const parsed = JSON.parse(jsonMatch[0]) as Omit<AchMatrix, 'generatedAt'>
    return { ...parsed, generatedAt: Date.now() }
  } catch (err) {
    log.warn(`ACH matrix generation failed: ${err}`)
    return null
  }
}

export function formatAchAsMarkdown(m: AchMatrix): string {
  const evidenceRows = m.evidence.map((e) => {
    const row = m.hypotheses.map((h) => {
      const cell = m.cells.find((c) => c.evidenceId === e.id && c.hypothesisId === h.id)
      return cell ? cell.rating : '–'
    }).join(' | ')
    return `| ${e.id} | ${e.description.slice(0, 60).replace(/\|/g, '\\|')} | ${row} |`
  }).join('\n')
  const headerRow = '| ID | Evidence | ' + m.hypotheses.map((h) => h.id).join(' | ') + ' |'
  const sepRow = '|----|----------|' + m.hypotheses.map(() => '---').join('|') + '|'

  const hypotheses = m.hypotheses.map((h, i) => {
    const marker = h.id === m.leadingHypothesisId ? ' ✅' : (h.rejected ? ' ❌' : '')
    return `**${h.id}** ${h.statement} (inconsistencies: ${h.inconsistencies}, confidence: ${h.confidence})${marker}`
  }).join('\n\n')

  return `### ANNEX: ANALYSIS OF COMPETING HYPOTHESES (ACH)

#### Hypotheses
${hypotheses}

#### Evidence-Hypothesis Matrix
*C = Consistent · I = Inconsistent · – = Not Applicable*

${headerRow}
${sepRow}
${evidenceRows}

#### Leading Hypothesis: ${m.leadingHypothesisId}
${m.rationale}`
}

// ============================================================================
// 2. KEY ASSUMPTIONS CHECK
// ============================================================================
//
// Surfaces the implicit assumptions baked into key judgments and challenges
// each one — "What if this assumption is wrong?" The output flags FRAGILE
// assumptions (those that can't be independently verified) which become
// analytic caveats.

export interface AssumptionCheck {
  assumption: string              // The implicit premise
  fragility: 'solid' | 'moderate' | 'fragile'
  challenge: string               // What if this is wrong?
  verifiable: boolean             // Can we test this?
}

const ASSUMPTIONS_PROMPT = `You are conducting a Key Assumptions Check on an analytic assessment.

Given the assessment text, your job:

1. Identify 3-7 IMPLICIT ASSUMPTIONS the analyst has made. Assumptions are NOT explicit claims — they are unstated premises that, if false, would change the conclusion. Examples:
   - "The leader will continue current foreign policy"
   - "Reporting from Source X is reliable"
   - "Adversary capabilities have not changed since last assessment"

2. For each assumption, rate its FRAGILITY:
   - solid    — well-supported by independent evidence
   - moderate — plausible but has some risk
   - fragile  — single-source, undocumented, or historically unreliable

3. Pose a CHALLENGE: "What if this assumption is wrong? How would the assessment change?"

4. Note whether the assumption is VERIFIABLE through new collection.

Respond ONLY with JSON:

{
  "assumptions": [
    {
      "assumption": "...",
      "fragility": "fragile",
      "challenge": "If false, then …",
      "verifiable": true
    }
  ]
}`

export async function runKeyAssumptionsCheck(
  assessment: string,
  connectionId?: string
): Promise<AssumptionCheck[] | null> {
  const prompt = `${ASSUMPTIONS_PROMPT}\n\nASSESSMENT:\n${assessment.slice(0, 6000)}`
  try {
    const raw = await llmService.completeForTask('analysis', prompt, connectionId, 1500)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON in response')
    const parsed = JSON.parse(jsonMatch[0]) as { assumptions: AssumptionCheck[] }
    return parsed.assumptions || []
  } catch (err) {
    log.warn(`Key Assumptions Check failed: ${err}`)
    return null
  }
}

export function formatAssumptionsAsMarkdown(items: AssumptionCheck[]): string {
  if (items.length === 0) return ''
  const rows = items.map((a) => {
    const icon = a.fragility === 'fragile' ? '🔴' : a.fragility === 'moderate' ? '🟠' : '🟢'
    const verifyTag = a.verifiable ? ' (verifiable)' : ' (hard to verify)'
    return `- ${icon} **${a.fragility.toUpperCase()}**${verifyTag}: ${a.assumption}\n  - *Challenge*: ${a.challenge}`
  }).join('\n')
  return `### ANNEX: KEY ASSUMPTIONS CHECK\n\n${rows}`
}

// ============================================================================
// 3. RED TEAM ANALYSIS — Devil's Advocacy + Red Hat
// ============================================================================
//
// Two contrarian techniques bundled:
//   (a) Devil's Advocacy — argues against the primary assessment regardless
//       of personal agreement
//   (b) Red Hat — adopts the adversary's perspective to identify deception,
//       counter-strategies, or surprises the analyst missed

export interface RedTeamAnalysisResult {
  devilsAdvocacy: {
    counterArgument: string
    weakestKeyJudgment: string
    alternativeExplanation: string
  }
  redHat: {
    adversaryGoal: string
    likelyCounterstrategy: string
    deceptionRisk: string
  }
}

const REDTEAM_PROMPT = `You are conducting Red-Team analysis on an intelligence assessment.

Your job is two-fold:

PART A — Devil's Advocacy
Argue AGAINST the primary assessment. Even if you privately agree with it, your role here is to find weaknesses. Specifically:
  - "counterArgument": A 2-3 sentence strongest case that the primary assessment is WRONG.
  - "weakestKeyJudgment": Which key judgment in the assessment is most vulnerable to challenge, and why?
  - "alternativeExplanation": If the primary judgment is wrong, what is the most plausible alternative?

PART B — Red Hat (Adversary Perspective)
Adopt the adversary's mindset. Specifically:
  - "adversaryGoal": What is the adversary actually trying to achieve? (May differ from what the analyst infers.)
  - "likelyCounterstrategy": How will the adversary respond to the actions implied by our assessment?
  - "deceptionRisk": What deception or denial measures might the adversary be using to mislead our collection?

Respond ONLY with JSON:
{
  "devilsAdvocacy": {"counterArgument": "...", "weakestKeyJudgment": "...", "alternativeExplanation": "..."},
  "redHat": {"adversaryGoal": "...", "likelyCounterstrategy": "...", "deceptionRisk": "..."}
}`

export async function runRedTeamAnalysis(
  assessment: string,
  connectionId?: string
): Promise<RedTeamAnalysisResult | null> {
  const prompt = `${REDTEAM_PROMPT}\n\nASSESSMENT:\n${assessment.slice(0, 6000)}`
  try {
    const raw = await llmService.completeForTask('analysis', prompt, connectionId, 1500)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON in response')
    return JSON.parse(jsonMatch[0]) as RedTeamAnalysisResult
  } catch (err) {
    log.warn(`Red-team analysis failed: ${err}`)
    return null
  }
}

export function formatRedTeamAsMarkdown(r: RedTeamAnalysisResult): string {
  return `### ANNEX: RED-TEAM ANALYSIS

#### Devil's Advocacy
- **Counter-argument**: ${r.devilsAdvocacy.counterArgument}
- **Weakest key judgment**: ${r.devilsAdvocacy.weakestKeyJudgment}
- **Alternative explanation**: ${r.devilsAdvocacy.alternativeExplanation}

#### Red Hat (Adversary Perspective)
- **Adversary's goal**: ${r.redHat.adversaryGoal}
- **Likely counter-strategy**: ${r.redHat.likelyCounterstrategy}
- **Deception risk**: ${r.redHat.deceptionRisk}`
}

// ============================================================================
// 4. INDICATORS FRAMEWORK
// ============================================================================
//
// For each key judgment, define the OBSERVABLE INDICATORS that would confirm
// (or refute) it as events unfold. This is what gets watched in subsequent
// collection cycles. Outputs become watchlist entries.

export interface IndicatorItem {
  hypothesis: string              // The judgment being tracked
  confirmingIndicators: string[]  // "If we see X, the judgment is being borne out"
  refutingIndicators: string[]    // "If we see Y, the judgment is being challenged"
  collectionPriority: 'high' | 'medium' | 'low'
}

const INDICATORS_PROMPT = `You are building an Indicators & Warnings framework for an intelligence assessment.

For each KEY JUDGMENT in the assessment, identify:

1. CONFIRMING INDICATORS: 2-4 observable events / signals that, if seen, would confirm the judgment is being borne out.

2. REFUTING INDICATORS: 2-4 observable events / signals that, if seen, would challenge or refute the judgment.

3. COLLECTION PRIORITY: high / medium / low based on the judgment's policy importance and confidence level.

Indicators must be SPECIFIC and OBSERVABLE — not vague ("political instability") but concrete ("more than 3 senior officials reassigned within 30 days").

Respond ONLY with JSON:
{
  "indicators": [
    {
      "hypothesis": "...",
      "confirmingIndicators": ["...", "..."],
      "refutingIndicators": ["...", "..."],
      "collectionPriority": "high"
    }
  ]
}`

export async function runIndicatorsFramework(
  assessment: string,
  connectionId?: string
): Promise<IndicatorItem[] | null> {
  const prompt = `${INDICATORS_PROMPT}\n\nASSESSMENT:\n${assessment.slice(0, 6000)}`
  try {
    const raw = await llmService.completeForTask('analysis', prompt, connectionId, 1500)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no JSON in response')
    const parsed = JSON.parse(jsonMatch[0]) as { indicators: IndicatorItem[] }
    return parsed.indicators || []
  } catch (err) {
    log.warn(`Indicators framework failed: ${err}`)
    return null
  }
}

export function formatIndicatorsAsMarkdown(items: IndicatorItem[]): string {
  if (items.length === 0) return ''
  const sections = items.map((it, i) => {
    const priorityIcon = it.collectionPriority === 'high' ? '🔴' : it.collectionPriority === 'medium' ? '🟠' : '🟢'
    const confirming = it.confirmingIndicators.map((c) => `  - ✓ ${c}`).join('\n')
    const refuting = it.refutingIndicators.map((c) => `  - ✗ ${c}`).join('\n')
    return `**Judgment ${i + 1}** ${priorityIcon} (priority: ${it.collectionPriority})
*${it.hypothesis}*

Confirming indicators (would strengthen judgment):
${confirming}

Refuting indicators (would challenge judgment):
${refuting}`
  }).join('\n\n')
  return `### ANNEX: INDICATORS & WARNINGS FRAMEWORK\n\n${sections}`
}

// ============================================================================
// CONVENIENCE: run all SATs and return concatenated markdown for the report
// ============================================================================

export interface SatBundle {
  ach?: AchMatrix | null
  assumptions?: AssumptionCheck[] | null
  redTeam?: RedTeamAnalysisResult | null
  indicators?: IndicatorItem[] | null
}

export interface SatRunOptions {
  ach?: boolean
  assumptions?: boolean
  redTeam?: boolean
  indicators?: boolean
}

/**
 * Run all enabled SATs in parallel and return both raw + formatted output.
 * The DeepResearchAgent calls this AFTER initial synthesis when the
 * `runSats` flag is set on the chat request.
 */
export async function runStructuredAnalyticTechniques(
  query: string,
  findings: string[],
  assessment: string,
  opts: SatRunOptions,
  connectionId?: string
): Promise<{ bundle: SatBundle; markdown: string }> {
  const tasks: Array<Promise<unknown>> = []
  const bundle: SatBundle = {}

  if (opts.ach) {
    tasks.push(runAchMatrix(query, findings, connectionId).then((r) => { bundle.ach = r }))
  }
  if (opts.assumptions) {
    tasks.push(runKeyAssumptionsCheck(assessment, connectionId).then((r) => { bundle.assumptions = r }))
  }
  if (opts.redTeam) {
    tasks.push(runRedTeamAnalysis(assessment, connectionId).then((r) => { bundle.redTeam = r }))
  }
  if (opts.indicators) {
    tasks.push(runIndicatorsFramework(assessment, connectionId).then((r) => { bundle.indicators = r }))
  }

  await Promise.allSettled(tasks)

  const sections: string[] = []
  if (bundle.ach) sections.push(formatAchAsMarkdown(bundle.ach))
  if (bundle.assumptions) sections.push(formatAssumptionsAsMarkdown(bundle.assumptions))
  if (bundle.redTeam) sections.push(formatRedTeamAsMarkdown(bundle.redTeam))
  if (bundle.indicators) sections.push(formatIndicatorsAsMarkdown(bundle.indicators))

  return {
    bundle,
    markdown: sections.length > 0 ? '\n\n---\n\n' + sections.join('\n\n---\n\n') : ''
  }
}
