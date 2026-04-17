import { llmService, type ChatMessage } from './LlmService'
import type { ProposedToolCall } from './AgenticPlanStore'
import log from 'electron-log'

/**
 * LLM-driven search-term refinement.
 *
 * The orchestrator + collectors derive search terms from user queries and
 * recommended-action text, but raw terms like "Iran-China relations" are
 * vague and give thin results. This module rewrites those terms with the
 * full chat context + plan intent + per-tool style hints, e.g.:
 *
 *   "Iran-China relations"
 *      → vector_search: "China Iran Comprehensive Strategic Partnership 25-year energy deal"
 *      → ahmia_search:  "Iran sanctions evasion crypto IRGC procurement leak"
 *      → mcp:wikipedia:search: "China–Iran 25-year Cooperation Program"
 *      → mcp:duckduckgo:search: "China Iran cooperation agreement 2026 latest update"
 *
 * Two entry points:
 *   - refineProposedCalls() — refines all queries on a list of proposed
 *     tool calls in ONE LLM round-trip (for the agentic plan modal).
 *   - refineWatchTerms() — refines a list of raw watch terms into
 *     well-scoped, monitor-able phrases (for WatchTermsService).
 *
 * Both fall back to the original input on any LLM error so callers don't
 * need to handle missing LLM connections themselves.
 */

const REFINE_SYSTEM = `You are a search-query refinement engine for an intelligence analyst platform.
Your job: rewrite raw analyst queries into tool-specific search strings that will retrieve the most relevant results.

Per-tool style guide:
- vector_search / intel_search: 4-8 keywords + 1-2 named entities, no boolean operators. Avoid stop-words.
- ahmia_search (dark-web .onion search): actor names, leak/dump/marketplace/forum vocabulary, ransomware-group names, leaked-credential phrasing.
- web_fetch: do not refine (URLs are passed through).
- mcp:wikipedia:search / mcp:wikipedia:* : the canonical entity name as Wikipedia titles it. Use full official names.
- mcp:duckduckgo:search / mcp:duckduckgo:web_search: natural-language news-style query with a recent year for freshness.
- mcp:fetch:fetch: a search URL (e.g. https://duckduckgo.com/html/?q=...) — keep refined keywords compact.
- cve_detail: exact CVE id only.
- whois_lookup / dns_resolve: exact apex domain only.

Rules:
- Preserve specific entity names from the original query EXACTLY (CVE ids, domains, person names, .onion URLs).
- Add the current year (2026) when the query implies recency ("latest", "recent", "current").
- Do not invent facts. If you can't refine, return the original term unchanged.
- Output STRICT JSON only — no prose, no markdown fences.`

interface RefineRequest {
  id: string
  tool: string
  group: string
  default_query: string
}

/**
 * Refine every query on a list of proposed tool calls in a single LLM call.
 *
 * Returns a NEW array; the original list is left untouched. On any error
 * (no LLM, JSON parse fail, etc.) returns the input list unchanged so the
 * caller never has to catch.
 */
export async function refineProposedCalls(
  userQuery: string,
  history: ChatMessage[],
  planSteps: Array<{ task: string; searchTerms: string[]; discipline: string }>,
  calls: ProposedToolCall[],
  connectionId?: string
): Promise<ProposedToolCall[]> {
  if (calls.length === 0) return calls

  // web_fetch / cve_detail / whois / dns are pass-through — don't ask the
  // LLM to "refine" a CVE id or a URL.
  const refineableCalls = calls.filter((c) =>
    !['web_fetch', 'cve_detail', 'whois_lookup', 'dns_resolve'].includes(c.tool)
  )
  if (refineableCalls.length === 0) return calls

  const reqs: RefineRequest[] = refineableCalls.map((c) => ({
    id: c.id,
    tool: c.tool,
    group: c.group,
    default_query: c.query
  }))

  const recentTurns = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join('\n')
  const planSummary = planSteps.map((s, i) => `${i + 1}. ${s.task}`).join('\n')

  const prompt = `${REFINE_SYSTEM}

ORIGINAL ANALYST QUERY:
"${userQuery}"

RECENT CONVERSATION (for context):
${recentTurns || '(none)'}

RESEARCH PLAN STEPS:
${planSummary}

TOOL CALLS TO REFINE (${reqs.length}):
${reqs.map((r) => `- id: "${r.id}"   tool: ${r.tool}   default_query: "${r.default_query}"`).join('\n')}

Return STRICT JSON mapping each id to its refined query string. Example:
{
  "abc123": "China Iran Comprehensive Strategic Partnership 25-year energy",
  "def456": "Iran sanctions evasion IRGC crypto procurement leak"
}`

  let raw: string
  try {
    // Routes to the small/fast model selected for "refiner" tasks (same
    // profile as planner — short JSON output, latency matters).
    raw = await llmService.completeForTask('refiner', prompt, connectionId, 800)
  } catch (err) {
    log.warn(`SearchRefiner: LLM call failed, returning unrefined queries: ${(err as Error).message}`)
    return calls
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    log.warn(`SearchRefiner: no JSON in LLM response, returning unrefined queries`)
    return calls
  }

  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, string>
  } catch (err) {
    log.warn(`SearchRefiner: JSON parse failed, returning unrefined queries: ${(err as Error).message}`)
    return calls
  }

  const refinedCount = { changed: 0, kept: 0 }
  const out = calls.map((c) => {
    const refined = parsed[c.id]
    if (typeof refined === 'string' && refined.trim() && refined.trim() !== c.query) {
      refinedCount.changed++
      return { ...c, query: refined.trim().slice(0, 400) }
    }
    refinedCount.kept++
    return c
  })
  log.info(`SearchRefiner: refined ${refinedCount.changed}/${calls.length} queries (${refinedCount.kept} kept as-is)`)
  return out
}

/**
 * Refine raw watch terms (extracted from preliminary report actions/gaps)
 * into well-scoped, monitor-able phrases. Used by WatchTermsService.
 *
 * Input: raw terms like ["Iran", "Yemen blockade", "increase monitoring"]
 * Output: scoped terms like ["Iran nuclear weapons program", "Yemen Hormuz blockade", filtered out generic verbs]
 *
 * Returns the SAME ARRAY on LLM failure so the caller's existing flow
 * proceeds with the unrefined terms.
 */
export async function refineWatchTerms(
  rawTerms: string[],
  contextText: string,
  category: string,
  connectionId?: string
): Promise<string[]> {
  if (rawTerms.length === 0) return rawTerms

  const prompt = `${REFINE_SYSTEM}

Input context (the analyst recommendation / information gap these terms came from):
"${contextText.slice(0, 1500)}"

Category: ${category}

Raw extracted terms:
${rawTerms.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Task: Rewrite each into a well-scoped phrase suitable for monitoring intelligence sources (RSS, dark-web, OSINT). Drop terms that are generic verbs / actions ("increase monitoring", "advise stakeholders"). Add geographic / domain context where missing.

Return STRICT JSON: { "terms": ["refined1", "refined2", ...] }
The output array length may be smaller than input (drop low-value terms).`

  let raw: string
  try {
    raw = await llmService.completeForTask('watch_term_refine', prompt, connectionId, 500)
  } catch (err) {
    log.warn(`SearchRefiner.refineWatchTerms: LLM failed, using raw terms: ${(err as Error).message}`)
    return rawTerms
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return rawTerms

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { terms?: string[] }
    if (!Array.isArray(parsed.terms) || parsed.terms.length === 0) return rawTerms
    const refined = parsed.terms
      .map((t) => String(t).trim())
      .filter((t) => t.length >= 3 && t.length <= 80)
      .slice(0, 12)
    log.info(`SearchRefiner.refineWatchTerms: ${rawTerms.length} raw → ${refined.length} refined`)
    return refined.length > 0 ? refined : rawTerms
  } catch {
    return rawTerms
  }
}
