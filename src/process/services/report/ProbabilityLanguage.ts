// ICD 203 Words of Estimative Probability (WEP) — the canonical scale that
// every IC analytic product must use. We expose three layers:
//   1. The 7-band probability scale (almost no chance → almost certainly)
//   2. The 3-tier confidence model (low / moderate / high)
//   3. Admiralty source rating (A1–F6) for HUMINT/OSINT source quality
//
// Used by:
//   - Analyst prompt construction (DeepResearchAgent)
//   - ICD203Validator (post-generation compliance check)
//   - ReportExtractor (parsing language back into numeric confidence)
//   - UI tooltips (so the analyst can see what "likely" actually means)
//
// Source: ICD 203 (DNI), CIS CTI Words of Estimative Probability framework

export type WepTerm =
  | 'almost no chance'
  | 'very unlikely'
  | 'unlikely'
  | 'roughly even chance'
  | 'likely'
  | 'very likely'
  | 'almost certainly'

export interface WepBand {
  term: WepTerm
  alternates: string[]   // synonyms acceptable in IC writing
  min: number            // lower bound (0-1)
  max: number            // upper bound (0-1)
  midpoint: number
}

export const WEP_SCALE: WepBand[] = [
  { term: 'almost no chance',    alternates: ['remote'],                     min: 0.01, max: 0.05, midpoint: 0.03 },
  { term: 'very unlikely',       alternates: ['highly improbable'],          min: 0.05, max: 0.20, midpoint: 0.13 },
  { term: 'unlikely',            alternates: ['improbable'],                 min: 0.20, max: 0.45, midpoint: 0.33 },
  { term: 'roughly even chance', alternates: ['roughly even odds'],          min: 0.45, max: 0.55, midpoint: 0.50 },
  { term: 'likely',              alternates: ['probable'],                   min: 0.55, max: 0.80, midpoint: 0.68 },
  { term: 'very likely',         alternates: ['highly probable'],            min: 0.80, max: 0.95, midpoint: 0.88 },
  { term: 'almost certainly',    alternates: ['nearly certain'],             min: 0.95, max: 0.99, midpoint: 0.97 }
]

export type ConfidenceLevel = 'low' | 'moderate' | 'high'

export interface ConfidenceDef {
  level: ConfidenceLevel
  shortLabel: string
  description: string
}

export const CONFIDENCE_LEVELS: Record<ConfidenceLevel, ConfidenceDef> = {
  high: {
    level: 'high',
    shortLabel: 'High Confidence',
    description: 'Based on high-quality information from multiple sources, most or all considered trustworthy, with minimal to no conflict among sources. Does not imply certainty.'
  },
  moderate: {
    level: 'moderate',
    shortLabel: 'Moderate Confidence',
    description: 'Information is credibly sourced and plausible but insufficient quality or corroboration for higher confidence. Sources may present opposing views.'
  },
  low: {
    level: 'low',
    shortLabel: 'Low Confidence',
    description: 'Source information credibility or plausibility is uncertain — scant, questionable, fragmented, or poorly corroborated. May indicate reliability concerns.'
  }
}

// ---------- Admiralty / NATO source-rating system (STANAG 2511) ---------------
// Letter = source reliability, Number = information accuracy. Combined as e.g.
// "B2" = usually reliable source reporting probably-true information.

export const SOURCE_RELIABILITY: Record<string, string> = {
  A: 'Completely reliable — no doubt about authenticity, trustworthiness, or competency. History of complete reliability.',
  B: 'Usually reliable — minor doubt about authenticity, trustworthiness, or competency. History of valid information most of the time.',
  C: 'Fairly reliable — doubt about authenticity, trustworthiness, or competency, but has provided valid information in the past.',
  D: 'Not usually reliable — significant doubt about authenticity, trustworthiness, or competency. Has provided valid information in the past.',
  E: 'Unreliable — lacking in authenticity, trustworthiness, or competency. History of invalid information.',
  F: 'Reliability cannot be judged — no basis exists for evaluating reliability of the source.'
}

export const INFORMATION_ACCURACY: Record<string, string> = {
  '1': 'Confirmed — confirmed by other independent sources, logical in itself, consistent with other information on the subject.',
  '2': 'Probably true — not confirmed but logical in itself, consistent with other information on the subject.',
  '3': 'Possibly true — not confirmed, reasonably logical in itself, agrees with some other information on the subject.',
  '4': 'Doubtful — not confirmed, possible but not logical, no other information on the subject.',
  '5': 'Improbable — not confirmed, not logical in itself, contradicted by other information on the subject.',
  '6': 'Truth cannot be judged — no basis exists for evaluating the validity of the information.'
}

/** Pick the WEP band that contains a numeric probability. */
export function probabilityToWep(prob: number): WepBand {
  const p = Math.max(0.01, Math.min(0.99, prob))
  return WEP_SCALE.find((b) => p >= b.min && p <= b.max) ?? WEP_SCALE[3]
}

/** Map a free-text term back to its WEP band, if it matches. */
export function wepFromText(text: string): WepBand | null {
  const lower = text.toLowerCase()
  for (const band of WEP_SCALE) {
    if (lower.includes(band.term)) return band
    for (const alt of band.alternates) {
      if (lower.includes(alt)) return band
    }
  }
  return null
}

/** Map free-text confidence phrasing to the canonical level. */
export function confidenceFromText(text: string): ConfidenceLevel | null {
  const lower = text.toLowerCase()
  if (/\bhigh\s+confidence\b/.test(lower)) return 'high'
  if (/\bmoderate\s+confidence\b/.test(lower)) return 'moderate'
  if (/\blow\s+confidence\b/.test(lower)) return 'low'
  return null
}

/** Forbidden hedging words that indicate ICD 203 violations. */
export const FORBIDDEN_HEDGES = [
  'might',
  'could',
  'maybe',
  'possibly',     // unless paired with WEP
  'perhaps',
  'sort of',
  'kind of'
]

/**
 * Build the prompt fragment that instructs the LLM in the WEP scale. Used
 * in every analyst prompt to keep terminology consistent across formats.
 */
export function buildWepPromptFragment(): string {
  const bands = WEP_SCALE
    .map((b) => `  - "${b.term}" (${Math.round(b.min * 100)}–${Math.round(b.max * 100)}%)`)
    .join('\n')

  return `## ICD 203 PROBABILITY LANGUAGE (MANDATORY)

Every analytic judgment MUST use one of these probability terms:

${bands}

NEVER use unanchored hedges: "might", "could", "maybe", "perhaps", or "possibly" without a WEP term.

Every key judgment MUST also state a CONFIDENCE LEVEL:
  - High Confidence  — multiple high-quality sources, minimal conflict
  - Moderate Confidence — credibly sourced and plausible, some conflict or limited corroboration
  - Low Confidence — scant, questionable, fragmented, or poorly corroborated

Format example: "Russia is very likely (High Confidence) to escalate cyber operations against Ukrainian infrastructure within the next 30 days, based on [DARKWEB: ransomware-leak-site] and [INTERNAL: report-2024-07-12]."`
}
