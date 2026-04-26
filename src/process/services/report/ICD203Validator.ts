// ICD 203 tradecraft validator. Scores generated reports against the 9
// analytic tradecraft standards from Intelligence Community Directive 203
// and surfaces specific deficiencies the LLM should fix on regeneration.
//
// Returns a 0-100 score. The orchestrator can re-prompt with deficiency
// notes if the score falls below a threshold (default 70).
//
// The 9 standards (from ICD 203, 2015 revision):
//   1. Properly describes quality and credibility of underlying sources
//   2. Properly expresses and explains uncertainties
//   3. Distinguishes intelligence information from analyst assumptions
//   4. Incorporates analysis of alternatives
//   5. Demonstrates customer relevance and addresses implications
//   6. Uses clear and logical argumentation
//   7. Explains change to or consistency of analytic judgments
//   8. Makes accurate judgments and assessments  (cannot evaluate at gen-time)
//   9. Incorporates effective visual information where appropriate

import { WEP_SCALE, FORBIDDEN_HEDGES, wepFromText, confidenceFromText } from './ProbabilityLanguage'

export interface TradecraftScore {
  total: number                  // 0-100
  perStandard: Record<number, { score: number; max: number; note: string }>
  deficiencies: string[]         // human-readable + LLM-prompt-ready
  passed: boolean                // total >= threshold (default 70)
}

const THRESHOLD = 70

export function validateReport(content: string, threshold: number = THRESHOLD): TradecraftScore {
  const checks: Array<[number, () => { score: number; max: number; note: string }]> = [
    [1, () => checkSourceQuality(content)],
    [2, () => checkUncertainties(content)],
    [3, () => checkFactVsJudgment(content)],
    [4, () => checkAlternatives(content)],
    [5, () => checkCustomerRelevance(content)],
    [6, () => checkLogicalArgumentation(content)],
    [7, () => checkChangeExplanation(content)],
    [9, () => checkVisualInformation(content)]
    // Standard 8 (accurate judgments) cannot be evaluated at generation time
  ]

  const perStandard: TradecraftScore['perStandard'] = {}
  const deficiencies: string[] = []
  let earned = 0
  let max = 0

  for (const [num, fn] of checks) {
    const r = fn()
    perStandard[num] = r
    earned += r.score
    max += r.max
    if (r.score < r.max * 0.6) {
      deficiencies.push(`Standard ${num}: ${r.note}`)
    }
  }

  const total = Math.round((earned / max) * 100)
  return {
    total,
    perStandard,
    deficiencies,
    passed: total >= threshold
  }
}

// ---------- Standard 1: source quality ---------------------------------------
// Look for inline citation tags [OSINT: ...] [DARKWEB: ...] etc.
function checkSourceQuality(content: string): { score: number; max: number; note: string } {
  const citationPattern = /\[(OSINT|DARKWEB|INTERNAL|FILE|HUMINT|CYBINT|IMINT|SIGINT|THREAT FEED):/gi
  const matches = content.match(citationPattern) ?? []
  // Look for Admiralty ratings (e.g. "B2" near a source)
  const admiraltyPattern = /\b[A-F][1-6]\b/g
  const admiraltyMatches = content.match(admiraltyPattern) ?? []

  if (matches.length === 0) {
    return { score: 0, max: 15, note: 'No inline source citations found. Every factual claim needs a [DISCIPLINE: source] tag.' }
  }
  if (matches.length < 5) {
    return { score: 6, max: 15, note: `Only ${matches.length} source citations found. Sourcing is sparse — every factual claim should be cited.` }
  }
  if (admiraltyMatches.length === 0) {
    return { score: 11, max: 15, note: 'No Admiralty source ratings (A1-F6) found. HUMINT/OSINT sources should carry reliability ratings where known.' }
  }
  return { score: 15, max: 15, note: 'Sources well-cited with reliability ratings.' }
}

// ---------- Standard 2: uncertainties ----------------------------------------
// WEP terms must be present; forbidden hedges ("might", "could") must not be.
function checkUncertainties(content: string): { score: number; max: number; note: string } {
  let wepCount = 0
  for (const band of WEP_SCALE) {
    const re = new RegExp(`\\b${band.term}\\b`, 'gi')
    wepCount += (content.match(re) ?? []).length
  }

  let forbiddenCount = 0
  for (const hedge of FORBIDDEN_HEDGES) {
    const re = new RegExp(`\\b${hedge}\\b`, 'gi')
    forbiddenCount += (content.match(re) ?? []).length
  }

  const hasConfidenceMarker = confidenceFromText(content) !== null

  let score = 0
  const max = 20
  const notes: string[] = []

  if (wepCount >= 3) score += 8
  else if (wepCount >= 1) { score += 4; notes.push(`Only ${wepCount} WEP term(s) found — expand probability language.`) }
  else notes.push('No ICD 203 WEP terms found. Every analytic judgment requires probability language.')

  if (forbiddenCount === 0) score += 6
  else { score += Math.max(0, 6 - forbiddenCount); notes.push(`${forbiddenCount} forbidden hedge(s) ("might", "could", "maybe", etc.) — replace with WEP language.`) }

  if (hasConfidenceMarker) score += 6
  else notes.push('No High/Moderate/Low Confidence markers found.')

  return {
    score,
    max,
    note: notes.length === 0 ? 'Uncertainty language compliant.' : notes.join(' ')
  }
}

// ---------- Standard 3: fact vs judgment -------------------------------------
function checkFactVsJudgment(content: string): { score: number; max: number; note: string } {
  // Look for explicit markers or analyst-judgment phrasing.
  const factMarkers = /\b(confirmed|fact|verified|multiple sources)\b/gi
  const judgmentMarkers = /\b(we (assess|judge)|analytic judgment|assessment|estimate|likely|unlikely|almost certainly)\b/gi
  const speculationMarkers = /\b(speculation|inferential|single-source|unconfirmed)\b/gi

  const hasFact = factMarkers.test(content)
  const hasJudgment = judgmentMarkers.test(content)
  const hasSpec = speculationMarkers.test(content)

  let score = 0
  const max = 12
  if (hasFact) score += 4
  if (hasJudgment) score += 4
  if (hasSpec) score += 4

  return {
    score,
    max,
    note: score === max
      ? 'Fact / assessment / speculation distinguished.'
      : 'Reports should explicitly distinguish FACT (multi-source) from ASSESSMENT (analytic judgment) from SPECULATION (single-source / inferential).'
  }
}

// ---------- Standard 4: alternatives -----------------------------------------
function checkAlternatives(content: string): { score: number; max: number; note: string } {
  const altSection = /alternative analysis|alternative hypothes|devil['']s advoca|red team|alternative view|contrarian|opposing|alternate possibility/i
  const hasSection = altSection.test(content)
  return hasSection
    ? { score: 12, max: 12, note: 'Alternative analysis present.' }
    : { score: 0, max: 12, note: 'No alternative analysis found. Add an "Alternative Analysis" or "Devil\'s Advocacy" section presenting the strongest case against the primary judgments.' }
}

// ---------- Standard 5: customer relevance -----------------------------------
function checkCustomerRelevance(content: string): { score: number; max: number; note: string } {
  const recommendationsSection = /recommended (collection )?actions|recommendations|outlook|implications|collection focus/i
  const actionableLanguage = /\b(should|recommend|task|monitor|prioritize|escalate)\b/gi
  const hasSection = recommendationsSection.test(content)
  const actionMatches = content.match(actionableLanguage) ?? []

  let score = 0
  const max = 10
  if (hasSection) score += 6
  if (actionMatches.length >= 3) score += 4
  else if (actionMatches.length >= 1) score += 2

  return {
    score,
    max,
    note: score >= 8
      ? 'Customer relevance and implications addressed.'
      : 'Add explicit recommendations / collection focus / outlook with actionable language.'
  }
}

// ---------- Standard 6: logical argumentation --------------------------------
function checkLogicalArgumentation(content: string): { score: number; max: number; note: string } {
  // Look for connective reasoning words
  const connectives = /\b(because|therefore|however|consequently|based on|supports|contradicts|suggests|indicates|implies)\b/gi
  const matches = content.match(connectives) ?? []
  const hasKeyJudgments = /key judgments?/i.test(content)

  let score = 0
  const max = 10
  if (matches.length >= 5) score += 6
  else if (matches.length >= 2) score += 3
  if (hasKeyJudgments) score += 4

  return {
    score,
    max,
    note: score >= 8
      ? 'Argumentation is clear and logical.'
      : `Strengthen argumentation with connective reasoning ("because", "therefore", "based on") — found ${matches.length}.`
  }
}

// ---------- Standard 7: change explanation -----------------------------------
function checkChangeExplanation(content: string): { score: number; max: number; note: string } {
  const changeMarkers = /\b(prior assessment|previous(ly)?|earlier reporting|consistent with|departs from|revises|updates?|new information|since (our )?last)\b/i
  const hasMarker = changeMarkers.test(content)

  return hasMarker
    ? { score: 6, max: 6, note: 'Change/consistency with prior reporting addressed.' }
    : { score: 3, max: 6, note: 'Consider noting whether judgments are consistent with or depart from prior assessments. Partial credit since first-time analyses are exempt.' }
}

// ---------- Standard 9: visual information -----------------------------------
function checkVisualInformation(content: string): { score: number; max: number; note: string } {
  const tablePattern = /\|.*\|.*\|/   // markdown table rows
  const bulletList = /^[\s]*[-*•]\s+/m
  const numberedList = /^[\s]*\d+\.\s+/m
  const timeline = /timeline|chronological/i
  const iocs = /\b(iocs?|indicators?|threat indicators)\b/i

  let score = 0
  const max = 15
  if (tablePattern.test(content)) score += 6
  if (bulletList.test(content)) score += 3
  if (numberedList.test(content)) score += 3
  if (timeline.test(content)) score += 1.5
  if (iocs.test(content)) score += 1.5

  return {
    score: Math.round(score),
    max,
    note: score >= 10
      ? 'Effective visual information present (tables, lists, timelines).'
      : 'Add structured visual elements: tables for IOCs, bulleted timelines, numbered key judgments.'
  }
}

/**
 * Build a deficiency-notes string suitable for re-prompting the LLM. The
 * caller can prepend this to a regeneration request: "Your previous draft
 * had these tradecraft deficiencies — fix them and regenerate."
 */
export function buildDeficiencyPrompt(score: TradecraftScore): string {
  if (score.deficiencies.length === 0) return ''
  return `## TRADECRAFT DEFICIENCIES TO FIX (ICD 203)

Your previous draft scored ${score.total}/100 against ICD 203 standards. Fix these specific issues in the regenerated version:

${score.deficiencies.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
}
