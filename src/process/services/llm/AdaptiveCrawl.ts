import { llmService } from './LlmService'
import log from 'electron-log'

/**
 * Adaptive crawl components — replace hardcoded depth/branch limits with
 * intelligent, relevance-driven decisions.
 *
 * Three pieces:
 *   1. SignalDensityScorer — deterministic page quality (how relevant is this content?)
 *   2. CrawlBudget — credit-based fetch limiting (quality over quantity)
 *   3. LlmCrawlGate — one-line LLM call per depth transition ("go deeper?")
 */

// ── Signal Density Scorer ──────────────────────────────────────────────

export interface SignalScore {
  density: number           // 0–1 normalised signal density
  keywordMatches: number
  entityCount: number
  fileLinks: number
  onionLinks: number
  imageLinks: number
  verdict: 'high' | 'medium' | 'low' | 'noise'
}

const ENTITY_PATTERNS = [
  /\bCVE-\d{4}-\d{4,7}\b/gi,                         // CVEs
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,                     // IPv4
  /\b[a-f0-9]{32}\b/gi,                                // MD5
  /\b[a-f0-9]{64}\b/gi,                                // SHA256
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,            // BTC
  /\b0x[a-fA-F0-9]{40}\b/g,                            // ETH
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,                // Email
  /\b[a-z2-7]{16,56}\.onion\b/gi,                      // .onion
]

const FILE_EXT_RE = /\.(pdf|txt|md|csv|json|xml|xlsx|doc|docx)\b/gi
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp)\b/gi
const ONION_RE = /https?:\/\/[a-z2-7]{16,56}\.onion/gi

/**
 * Score a page's signal density relative to the research task.
 * Pure deterministic — no LLM call.
 */
export function scoreSignalDensity(
  pageText: string,
  taskKeywords: string[],
  extractedUrls: string[] = []
): SignalScore {
  const textLower = pageText.toLowerCase()
  const len = Math.max(pageText.length, 1)

  // Keyword matches.
  let keywordMatches = 0
  for (const kw of taskKeywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
    const matches = textLower.match(re)
    if (matches) keywordMatches += matches.length
  }

  // Entity extraction.
  let entityCount = 0
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0
    const matches = pageText.match(pattern)
    if (matches) entityCount += matches.length
  }

  // File / onion / image link counts (from extracted URLs).
  let fileLinks = 0
  let onionLinks = 0
  let imageLinks = 0
  for (const url of extractedUrls) {
    if (FILE_EXT_RE.test(url)) fileLinks++
    if (ONION_RE.test(url)) onionLinks++
    if (IMAGE_EXT_RE.test(url)) imageLinks++
    FILE_EXT_RE.lastIndex = 0
    ONION_RE.lastIndex = 0
    IMAGE_EXT_RE.lastIndex = 0
  }

  // Normalised density (signals per 1000 chars).
  const rawSignals = keywordMatches * 2 + entityCount * 3 + fileLinks * 5 + onionLinks * 4 + imageLinks
  const density = Math.min(1, rawSignals / (len / 1000))

  let verdict: SignalScore['verdict']
  if (density >= 0.3 || keywordMatches >= 5 || entityCount >= 3 || fileLinks >= 2) verdict = 'high'
  else if (density >= 0.1 || keywordMatches >= 2 || entityCount >= 1) verdict = 'medium'
  else if (density >= 0.03 || keywordMatches >= 1) verdict = 'low'
  else verdict = 'noise'

  return { density, keywordMatches, entityCount, fileLinks, onionLinks, imageLinks, verdict }
}

// ── Crawl Budget ───────────────────────────────────────────────────────

/**
 * Credit-based crawl budget. Each fetch costs credits based on expected
 * relevance. When credits run out, the crawler stops — favouring quality
 * over quantity.
 *
 * Default: 50 credits per research task.
 *   High-relevance fetch: 1 credit
 *   Medium: 2 credits
 *   Low: 4 credits
 *   File download: 1 credit (always worth it)
 */
export class CrawlBudget {
  private spent = 0
  private fetchCount = 0

  constructor(private totalCredits: number = 50) {}

  /** Can we afford another fetch at this relevance level? */
  canAfford(verdict: SignalScore['verdict'] | 'file'): boolean {
    return this.spent + this.costOf(verdict) <= this.totalCredits
  }

  /** Spend credits for a fetch. Returns false if over budget. */
  spend(verdict: SignalScore['verdict'] | 'file'): boolean {
    const cost = this.costOf(verdict)
    if (this.spent + cost > this.totalCredits) return false
    this.spent += cost
    this.fetchCount++
    return true
  }

  remaining(): number { return this.totalCredits - this.spent }
  totalSpent(): number { return this.spent }
  totalFetches(): number { return this.fetchCount }

  private costOf(verdict: SignalScore['verdict'] | 'file'): number {
    switch (verdict) {
      case 'high': return 1
      case 'file': return 1
      case 'medium': return 2
      case 'low': return 4
      case 'noise': return 8
    }
  }
}

// ── LLM Crawl Gate ─────────────────────────────────────────────────────

export type CrawlDecision = 'essential' | 'useful' | 'marginal' | 'irrelevant'

/**
 * Ask the small/fast LLM whether a crawl branch is worth continuing.
 * One-line prompt, ~200ms on fast models. Returns 'useful' on any error
 * (fail-open so the crawl doesn't stall).
 */
export async function llmCrawlGate(
  pageSnippet: string,
  taskDescription: string,
  currentDepth: number,
  connectionId?: string
): Promise<{ decision: CrawlDecision; reason: string }> {
  const prompt = `You are a research crawler deciding whether to follow links on this page.

Research task: "${taskDescription.slice(0, 200)}"
Current crawl depth: ${currentDepth}
Page snippet (first 500 chars):
"${pageSnippet.slice(0, 500)}"

Rate this page's value for the research task. Respond with ONLY one word:
ESSENTIAL — critical source, must follow all links
USEFUL — relevant, follow top links
MARGINAL — tangentially related, only follow file/onion links
IRRELEVANT — off-topic, stop crawling this branch

Your rating:`

  try {
    const raw = await llmService.completeForTask('planner', prompt, connectionId, 20)
    const word = raw.trim().toUpperCase().split(/\s+/)[0]
    const decision: CrawlDecision =
      word.startsWith('ESSENTIAL') ? 'essential' :
      word.startsWith('USEFUL') ? 'useful' :
      word.startsWith('MARGINAL') ? 'marginal' :
      word.startsWith('IRRELEVANT') ? 'irrelevant' :
      'useful' // default on parse failure
    log.debug(`LlmCrawlGate: depth=${currentDepth} → ${decision} (${word})`)
    return { decision, reason: word }
  } catch (err) {
    log.debug(`LlmCrawlGate: failed (${err}), defaulting to 'useful'`)
    return { decision: 'useful', reason: 'llm_error' }
  }
}

/**
 * Compute the adaptive max depth for a branch based on the LLM gate
 * decision and the parent page's signal density.
 *
 *   ESSENTIAL + high signal: current + 3 (max 6)
 *   USEFUL + medium signal: current + 2 (max 5)
 *   MARGINAL: current + 1 (only files/onion)
 *   IRRELEVANT: 0 (stop)
 */
export function adaptiveMaxDepth(
  currentDepth: number,
  decision: CrawlDecision,
  signalVerdict: SignalScore['verdict']
): number {
  const HARD_CAP = 6

  switch (decision) {
    case 'essential':
      return Math.min(currentDepth + 3, HARD_CAP)
    case 'useful':
      return Math.min(currentDepth + (signalVerdict === 'high' ? 3 : 2), HARD_CAP)
    case 'marginal':
      return currentDepth + 1 // only file/onion links at this depth
    case 'irrelevant':
      return currentDepth // stop
  }
}
