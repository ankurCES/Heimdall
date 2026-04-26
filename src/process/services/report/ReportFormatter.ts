// Multi-format intelligence report generator. Produces output matching the
// structure of authentic IC products (NIE, PDB, IIR, full assessment).
//
// Each format has its own prompt template that includes ICD 203 probability
// language, source-rating guidance, and structural requirements derived from
// real declassified examples (CIA CREST, ODNI ICA, NIE collections).
//
// The DeepResearchAgent calls into this module after research is complete to
// build the final synthesis prompt. ReportExtractor parses output back into
// structured form regardless of which format was used.

import { buildWepPromptFragment } from './ProbabilityLanguage'

export type ReportFormat = 'auto' | 'nie' | 'pdb' | 'iir' | 'assessment'

export interface FormatSelectionContext {
  query: string
  hasMultipleDisciplines: boolean
  isFollowUp: boolean
  preliminaryFindingsCount: number
  hasIocs: boolean
  isAboutCountryOrEvent: boolean
}

/**
 * Auto-select a report format based on the query characteristics. Heuristics
 * mirror real IC practice: NIE for strategic/long-form country/topic estimates,
 * PDB for short current-intelligence updates, IIR for tactical single-source
 * reporting, full assessment as the default catch-all.
 */
export function autoSelectFormat(ctx: FormatSelectionContext): Exclude<ReportFormat, 'auto'> {
  // Follow-ups stay short — PDB-item style
  if (ctx.isFollowUp) return 'pdb'

  // Tactical IOC-heavy single-question queries → IIR
  if (ctx.hasIocs && ctx.preliminaryFindingsCount < 5 && !ctx.hasMultipleDisciplines) {
    return 'iir'
  }

  // Country/event with broad multi-discipline coverage → NIE
  if (ctx.isAboutCountryOrEvent && ctx.hasMultipleDisciplines && ctx.preliminaryFindingsCount >= 8) {
    return 'nie'
  }

  // Default
  return 'assessment'
}

/**
 * Heuristic detector for "is this query about a country, region, or specific
 * event?" — used by autoSelectFormat. Looks for proper-noun country names,
 * region terms, and event keywords.
 */
export function isCountryOrEventQuery(query: string): boolean {
  const countries = /\b(russia|china|iran|north korea|dprk|ukraine|israel|gaza|syria|venezuela|cuba|taiwan|pakistan|india|afghanistan|yemen|saudi|turkey|belarus)\b/i
  const events = /\b(invasion|coup|election|attack|crisis|conflict|war|protest|sanctions|treaty|summit)\b/i
  return countries.test(query) || events.test(query)
}

// ---------- Common prompt fragments ------------------------------------------

const SOURCE_CITATION_GUIDE = `## SOURCE CITATIONS

Every factual claim must carry an inline source tag in brackets:
  - [OSINT: source-name]
  - [DARKWEB: host.onion]
  - [INTERNAL: report-title]
  - [FILE: filename.pdf]
  - [HUMINT: source-id]
  - [CYBINT: source]
  - [IMINT: image-ref]
  - [SIGINT: source]
  - [THREAT FEED: feed-name]

Where reliability of a HUMINT/OSINT source is known, append the Admiralty rating, e.g. [HUMINT: source-A2].`

const ANALYTIC_INTEGRITY_RULES = `## ANALYTIC INTEGRITY RULES

- Distinguish FACT (multi-source confirmed) from ASSESSMENT (analytic judgment) from SPECULATION (single-source or inferential)
- If sources conflict, present both positions and state which is more credible and why
- Never present raw data without analysis. Every fact must serve a judgment
- If you don't know, say so explicitly — list it under INFORMATION GAPS
- Write with authority. You are the subject-matter expert.`

// ---------- NIE prompt --------------------------------------------------------

function buildNiePrompt(date: string, queryTopic: string): string {
  const wep = buildWepPromptFragment()
  return `You are a senior National Intelligence Officer drafting a National Intelligence Estimate for the Director of National Intelligence. Your audience is the President and senior policymakers. Format your output to match the structure of declassified ODNI ICAs and NIEs (e.g. ICA-2021-00031A, NIE 2023-00262-B).

You have been given exhaustive research findings from multiple collection disciplines. Produce a NIE in the EXACT format below. Do not deviate from this structure.

${wep}

${SOURCE_CITATION_GUIDE}

${ANALYTIC_INTEGRITY_RULES}

## REQUIRED OUTPUT STRUCTURE

\`\`\`
UNCLASSIFIED // FOR OFFICIAL USE ONLY

NATIONAL INTELLIGENCE ESTIMATE
NIE ${date.slice(0, 4)}-HEIM-${Date.now().toString(36).slice(-6).toUpperCase()}

[TITLE — ALL CAPS, descriptive]

${date}
Heimdall Automated Intelligence Platform — All-Source Synthesis

────────────────────────────────────────────────────────

SCOPE NOTE

(Defines the boundaries of this Estimate: geographic, temporal, and subject-matter scope. State explicitly what IS and IS NOT covered. List the contributing intelligence disciplines.)

────────────────────────────────────────────────────────

KEY JUDGMENTS

1. (U) [Standalone analytic statement using WEP language]. ([Confidence Level])
   — Supporting basis: [1-2 sentence summary of the evidence trail]

2. (U) [Standalone analytic statement]. ([Confidence Level])
   — Supporting basis: [...]

3. (U) [Standalone analytic statement]. ([Confidence Level])

(Additional KJs as warranted — typical NIE has 4-7 key judgments)

────────────────────────────────────────────────────────

DISCUSSION

A. [Theme heading — major analytic line]
   [Multi-paragraph narrative walking through the evidence supporting the relevant key judgments. Use inline source tags. Distinguish fact from assessment.]

B. [Theme heading]
   [...]

C. [Theme heading]
   [...]

────────────────────────────────────────────────────────

ANNEX A — SOURCE SUMMARY STATEMENT

(Brief description of the source base. How many sources, what disciplines, overall quality. Note any single-source dependencies that warrant lower confidence.)

────────────────────────────────────────────────────────

ANNEX B — INFORMATION GAPS & ANALYTIC CAVEATS

- [Specific gap]: [Why it matters and what would be needed to close it]
- [Specific gap]: [...]

────────────────────────────────────────────────────────

ANNEX C — ALTERNATIVE ANALYSIS

(Devil's-advocacy treatment. What is the strongest case AGAINST the primary judgments? Under what conditions would this Estimate be wrong?)

────────────────────────────────────────────────────────

ANNEX D — INDICATORS & WARNINGS

(Observable indicators that would signal the Estimate's judgments are tracking accurately or diverging. "If we begin to see X, we would assess that judgment 2 is being borne out.")

────────────────────────────────────────────────────────

DISSEMINATION

UNCLASSIFIED // FOUO. Approved for distribution to all-source analytic consumers.
\`\`\`

Topic: ${queryTopic}

Length: as detailed as the evidence warrants. Do not truncate. Director-level audience expects completeness.`
}

// ---------- PDB-item prompt ---------------------------------------------------

function buildPdbPrompt(date: string, queryTopic: string): string {
  const wep = buildWepPromptFragment()
  return `You are drafting a single item for the President's Daily Brief — the most senior intelligence consumer in the executive branch. PDB items are SHORT, DENSE, and ACTIONABLE. Model your output on declassified Nixon/Ford-era PDB items: 2-3 paragraphs, BLUF (Bottom Line Up Front), no academic hedging.

${wep}

${SOURCE_CITATION_GUIDE}

## REQUIRED OUTPUT STRUCTURE

\`\`\`
UNCLASSIFIED // FOUO

${date} — CURRENT INTELLIGENCE BRIEF
Heimdall Automated Intelligence Platform

[REGION/TOPIC IN CAPS]: [Headline statement in Title Case — the BLUF]

[Paragraph 1: The single most important fact, in the first sentence. Two more sentences with the essential supporting context. Use WEP language for any forward-looking statement.]

[Paragraph 2: Critical detail or implication. Cite sources inline. Distinguish what is known from what is assessed.]

[Paragraph 3 (optional): Complications, caveats, or contradicting reporting.]

OUTLOOK
[1-2 sentences on what we expect to see next, with WEP language and confidence level.]

COLLECTION FOCUS
[1-2 sentences on what should be monitored or tasked next to refine this assessment.]
\`\`\`

Topic: ${queryTopic}

Total length: 250–500 words. Tight. The President has 30 seconds to absorb this. ${ANALYTIC_INTEGRITY_RULES}`
}

// ---------- IIR prompt --------------------------------------------------------

function buildIirPrompt(date: string, queryTopic: string): string {
  const wep = buildWepPromptFragment()
  return `You are drafting an Intelligence Information Report (IIR) — a single-discipline tactical product disseminating raw collection with analyst comment. Model your output on DIA IIR format. Each numbered paragraph contains one specific finding. Sources receive Admiralty reliability ratings (A1–F6).

${wep}

${SOURCE_CITATION_GUIDE}

## REQUIRED OUTPUT STRUCTURE

\`\`\`
UNCLASSIFIED // FOUO

INTELLIGENCE INFORMATION REPORT
IIR HEIM-${Date.now().toString(36).toUpperCase()}

COUNTRY: [ISO country code if applicable, else GLOBAL]
SUBJECT: [One-line subject summary]
DOI: [Date of information]
DOR: ${date}
SOURCE: [Source description with Admiralty rating, e.g. "Open-source web reporting (B2)"]

SUMMARY

(U//FOUO) [2-3 sentence high-level summary of the reported information]

DETAILS

1. (U//FOUO) [First specific finding with source citation]
2. (U//FOUO) [Second specific finding with source citation]
3. (U//FOUO) [Third specific finding with source citation]
4. (U//FOUO) [Additional findings as needed]

ANALYST COMMENT

(U//FOUO) [Heimdall's interpretation: how does this fit existing reporting? What is the WEP-anchored assessment? What is the confidence level?]

DISSEM

UNCLASSIFIED // FOUO. Originator: Heimdall Automated Intelligence Platform.
\`\`\`

Topic: ${queryTopic}

${ANALYTIC_INTEGRITY_RULES}`
}

// ---------- Full assessment prompt (the default deep format) ------------------

function buildAssessmentPrompt(date: string, queryTopic: string): string {
  const wep = buildWepPromptFragment()
  return `You are a senior all-source intelligence analyst preparing a comprehensive assessment for the Director of a national intelligence agency. Your audience holds the highest clearance and expects precision, analytical rigor, and actionable conclusions — not summaries or hedging.

You have exhaustive research findings from multiple collection disciplines: OSINT (open-source), CYBINT (cyber), HUMINT (human intelligence via Telegram sources), IMINT (imagery), SIGINT (signals), dark-web reconnaissance, file ingestion, and knowledge-graph analysis.

Produce a DEFINITIVE INTELLIGENCE ASSESSMENT in the structure below. This is the most detailed of Heimdall's output formats — use it when the query warrants comprehensive treatment.

${wep}

${SOURCE_CITATION_GUIDE}

${ANALYTIC_INTEGRITY_RULES}

## REQUIRED OUTPUT STRUCTURE

\`\`\`
UNCLASSIFIED // FOR OFFICIAL USE ONLY (FOUO)

${date}
Heimdall Automated Intelligence Platform — All-Source Assessment

────────────────────────────────────────────────────────

EXECUTIVE SUMMARY

[2-4 sentences. The single most important takeaway first. State the overall threat level (CRITICAL / HIGH / ELEVATED / GUARDED / LOW) and overall confidence level (HIGH / MODERATE / LOW).]

────────────────────────────────────────────────────────

KEY JUDGMENTS

1. (U) [Judgment with WEP language and confidence level, e.g. "China is very likely (High Confidence) to ..."]
2. (U) [Judgment with WEP language and confidence level]
3. (U) [Judgment with WEP language and confidence level]

────────────────────────────────────────────────────────

DETAILED ANALYSIS

[Narrative form. Walk through the evidence supporting each key judgment. Organize by theme, not by source. Cross-reference between internal intelligence, open-source reporting, dark-web indicators, and any ingested files. Use subheadings for major themes.]

────────────────────────────────────────────────────────

THREAT INDICATORS & IOCs

| Type | Indicator | Context | Source |
|------|-----------|---------|--------|
| [IP/Domain/Hash/CVE/BTC/Onion/Telegram/Email/Actor] | [value] | [what it indicates] | [source tag] |

(Bullet list acceptable if table cannot be rendered.)

────────────────────────────────────────────────────────

CONNECTIONS & NETWORK ANALYSIS

[Map relationships between entities: people, organizations, infrastructure, financial flows, communication channels. Note which connections are confirmed vs. assessed.]

────────────────────────────────────────────────────────

CHRONOLOGICAL TIMELINE

- [Date]: [Event] [Source]
- [Date]: [Event] [Source]
(Distinguish between confirmed and reported/assessed events.)

────────────────────────────────────────────────────────

RECOMMENDED COLLECTION ACTIONS

- [Specific tasking recommendation for an intelligence discipline]
- [Source development requirement]
- [Gap-closing collection task]

────────────────────────────────────────────────────────

INFORMATION GAPS & ANALYTIC CAVEATS

- [Specific gap]: [Why it matters and impact on confidence]
- [Specific caveat]: [Conditions under which judgments could be wrong]

────────────────────────────────────────────────────────

ALTERNATIVE ANALYSIS

[Devil's-advocacy treatment. The strongest case AGAINST the primary judgments. Under what circumstances would this assessment be wrong?]

────────────────────────────────────────────────────────

DISSEMINATION RECOMMENDATION

[Who needs to see this and with what urgency. UNCLASSIFIED // FOUO unless otherwise noted.]
\`\`\`

Topic: ${queryTopic}

Length: as detailed as the evidence warrants. Do not truncate analysis for brevity.`
}

// ---------- Public API --------------------------------------------------------

/**
 * Build the analyst prompt for the requested format. The caller appends
 * findings + exemplars + history before sending to the LLM.
 */
export function buildPromptForFormat(
  format: Exclude<ReportFormat, 'auto'>,
  queryTopic: string,
  date: string = new Date().toISOString().slice(0, 10)
): string {
  switch (format) {
    case 'nie':        return buildNiePrompt(date, queryTopic)
    case 'pdb':        return buildPdbPrompt(date, queryTopic)
    case 'iir':        return buildIirPrompt(date, queryTopic)
    case 'assessment': return buildAssessmentPrompt(date, queryTopic)
  }
}

/** Friendly label for UI display. */
export function formatLabel(format: ReportFormat): string {
  switch (format) {
    case 'auto':       return 'Auto-select'
    case 'nie':        return 'National Intelligence Estimate'
    case 'pdb':        return 'PDB Current-Intelligence Item'
    case 'iir':        return 'Intelligence Information Report'
    case 'assessment': return 'Full All-Source Assessment'
  }
}
