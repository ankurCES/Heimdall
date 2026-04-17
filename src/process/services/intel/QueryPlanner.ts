import { removeStopWords } from './StopWords'
import { expandSynonyms } from './SynonymDictionary'
import { llmService } from '../llm/LlmService'
import log from 'electron-log'

/**
 * QueryPlanner — turns raw analyst phrasing into a high-quality FTS5 query.
 *
 * Two-tier strategy:
 *
 *  1. **Deterministic** (sub-millisecond, no LLM call):
 *     - Detect & extract entities (CVE, IP, domain, .onion, email)
 *     - Detect & extract quoted phrases (preserve verbatim)
 *     - Tokenise + strip stop-words + dedupe
 *     - For SHORT queries (≤4 substantive tokens), expand each token via
 *       the SynonymDictionary
 *     - Build a recall-friendly FTS5 expression: phrases AS-IS, every
 *       remaining token gets prefix-marker `*`, OR-joined.
 *     - Routing hint: if entities are detected, surface a recommendation
 *       to call `entity_lookup` instead of (or in addition to) intel_search.
 *
 *  2. **LLM-assisted refinement** (only when needed):
 *     - Triggered when the deterministic path returns < 3 results AND
 *       the original query is > 4 tokens (i.e. natural language).
 *     - Asks the small/fast `planner`-routed model to produce 3-6 keyword
 *       groups with synonyms + entities.
 *     - 10-min in-memory cache keyed by the raw query.
 *
 * Returns a structured `PlannedQuery` so callers can:
 *   - Pass `ftsQuery` straight to IntelRagService.searchReports(..., {rawFts:true})
 *   - Use `entityHints` to redirect to entity_lookup
 *   - Display `meta` in the chat trail so the analyst sees the rewrite
 */

export interface EntityHint {
  type: 'cve' | 'ip' | 'domain' | 'onion' | 'email' | 'hash'
  value: string
}

export interface PlannedQuery {
  /** The rewritten FTS5 expression — pass to searchReports with rawFts: true. */
  ftsQuery: string
  /** Substantive tokens after stop-word removal, prior to FTS prefix expansion. */
  tokens: string[]
  /** Verbatim phrases extracted from the original query (already FTS5-quoted). */
  phrases: string[]
  /** Entities the analyst should consider routing to entity_lookup. */
  entityHints: EntityHint[]
  /** Whether synonym expansion was applied. */
  expandedSynonyms: boolean
  /** Whether the LLM refinement path was used. */
  llmRefined: boolean
  /** Human-readable summary of the rewrite, surfaced in the trail. */
  meta: string
  /** The original query, for cache lookup + display. */
  original: string
}

const PHRASE_RE = /"([^"]{2,80})"/g
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const ONION_RE = /\b[a-z2-7]{16,56}\.onion\b/gi
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g
const HASH_RE = /\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/gi
const DOMAIN_RE = /\b(?:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi

export class QueryPlanner {
  /** 10-min cache for LLM-refined queries to avoid re-paying the LLM cost. */
  private llmCache = new Map<string, { plan: PlannedQuery; expiresAt: number }>()
  private readonly LLM_CACHE_TTL_MS = 10 * 60_000

  /**
   * Plan a query — deterministic only. Use planAdaptive if you can await
   * the LLM fallback (callers like intel_search do; sync paths can't).
   */
  plan(query: string): PlannedQuery {
    return this.deterministic(query)
  }

  /**
   * Plan a query, falling back to the LLM-assisted refiner when the
   * deterministic plan is unlikely to find anything (long natural-language
   * queries with low signal density).
   *
   * `resultsForDeterministic` lets the caller pass a count from a fast
   * trial search — when ≥ threshold we skip the LLM entirely. When omitted,
   * the heuristic is "long + verbose" only.
   */
  async planAdaptive(
    query: string,
    opts: { resultsForDeterministic?: number; connectionId?: string; minResults?: number } = {}
  ): Promise<PlannedQuery> {
    const minResults = opts.minResults ?? 3
    const detPlan = this.deterministic(query)

    // Cache hit — return immediately.
    const cached = this.llmCache.get(query)
    if (cached && Date.now() < cached.expiresAt) return cached.plan

    // Skip LLM if we already have enough hits or the deterministic plan
    // looks rich (≥3 substantive tokens, long enough to be specific).
    const enoughHits = (opts.resultsForDeterministic ?? minResults) >= minResults
    const richEnough = detPlan.tokens.length >= 3 && detPlan.tokens.length <= 6
    if (enoughHits || richEnough) return detPlan

    // Trigger LLM refinement.
    try {
      const llmPlan = await this.llmRefine(query, opts.connectionId)
      if (llmPlan) {
        this.llmCache.set(query, { plan: llmPlan, expiresAt: Date.now() + this.LLM_CACHE_TTL_MS })
        return llmPlan
      }
    } catch (err) {
      log.debug(`QueryPlanner LLM refinement failed (returning deterministic): ${err}`)
    }
    return detPlan
  }

  // ── Deterministic path ────────────────────────────────────────────────
  private deterministic(query: string): PlannedQuery {
    const original = (query || '').trim()
    if (!original) {
      return { ftsQuery: '', tokens: [], phrases: [], entityHints: [], expandedSynonyms: false, llmRefined: false, meta: '(empty query)', original }
    }

    // 1. Extract entities first — we want them out of the token stream so
    //    they don't get stop-worded or stemmed.
    const entityHints: EntityHint[] = []
    let working = original

    const consume = (re: RegExp, type: EntityHint['type']) => {
      const seen = new Set<string>()
      working = working.replace(re, (match) => {
        const v = match.toLowerCase()
        if (!seen.has(v)) {
          seen.add(v)
          entityHints.push({ type, value: type === 'cve' ? match.toUpperCase() : match })
        }
        return ' '
      })
    }
    consume(CVE_RE, 'cve')
    consume(ONION_RE, 'onion')
    consume(EMAIL_RE, 'email')
    consume(HASH_RE, 'hash')
    consume(IP_RE, 'ip')
    // Domains LAST — IPs would otherwise match the domain regex.
    consume(DOMAIN_RE, 'domain')

    // 2. Extract quoted phrases. They go through unchanged as FTS5 quoted
    //    phrase queries.
    const phrases: string[] = []
    working = working.replace(PHRASE_RE, (_, p) => {
      const cleaned = p.replace(/[^\w\s.-]/g, ' ').trim()
      if (cleaned) phrases.push(`"${cleaned}"`)
      return ' '
    })

    // 3. Normalise + tokenise + stop-word strip.
    const rawTokens = working
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')         // strip punctuation
      .split(/\s+/)
      .filter((t) => t.length >= 2)
    const tokens = Array.from(new Set(removeStopWords(rawTokens)))

    // 4. Synonym expansion — only when query is short (≤4 substantive
    //    tokens). Long queries already have signal; expansion adds noise.
    const shouldExpand = tokens.length > 0 && tokens.length <= 4
    const groups: string[][] = shouldExpand
      ? expandSynonyms(tokens)
      : tokens.map((t) => [t])

    // 5. Build FTS5 query.
    //    - Phrases: passed through as exact matches (already quoted).
    //    - Each group: OR-joined within the group (synonym alternatives),
    //      every ≥4-char alpha token gets `*` prefix marker.
    //    - Groups: OR-joined together (recall-friendly; BM25 ranks precision).
    const ftsParts: string[] = [...phrases]
    for (const group of groups) {
      const expanded = group.map((t) => {
        const safe = t.replace(/[^a-z0-9-]/g, '')
        if (!safe) return null
        return safe.length >= 4 && /^[a-z]/.test(safe) ? `${safe}*` : safe
      }).filter((s): s is string => s !== null)
      if (expanded.length > 0) ftsParts.push(`(${expanded.join(' OR ')})`)
    }
    const ftsQuery = ftsParts.join(' OR ')

    const meta = this.buildMeta(original, ftsQuery, phrases, tokens, entityHints, shouldExpand, false)
    return { ftsQuery, tokens, phrases, entityHints, expandedSynonyms: shouldExpand, llmRefined: false, meta, original }
  }

  // ── LLM-refinement path ───────────────────────────────────────────────
  private async llmRefine(query: string, connectionId?: string): Promise<PlannedQuery | null> {
    const prompt = `You are a search-query refinement engine for an intelligence database.
The analyst's raw query is too vague or wordy for full-text search. Rewrite it as 3-6 high-signal keyword groups.

Raw query: "${query.slice(0, 400)}"

Return STRICT JSON only:
{
  "must":     ["term1", "term2"],          // tokens that should appear (concept anchors)
  "should":   ["alt1", "alt2", "alt3"],    // synonyms / alternative phrasings (boost recall)
  "phrases":  ["multi word phrase"],       // exact multi-word phrases worth quoting
  "entities": [{"type":"cve|ip|domain|onion|email|hash","value":"…"}]  // empty array if none
}

Rules:
- Drop articles, pronouns, conversational fillers ("what is", "tell me", "latest").
- Use canonical entity names (countries, organisations, threat actors).
- Don't invent — preserve specific names from the original.
- 3 must + 3 should + 1 phrase is a great target. Fewer is fine.
- Output ONLY the JSON, no prose, no markdown fences.`

    let raw: string
    try {
      // Routes to the small/fast model selected for "planner" tasks.
      raw = await llmService.completeForTask('planner', prompt, connectionId, 400)
    } catch (err) {
      log.debug(`QueryPlanner LLM call failed: ${(err as Error).message}`)
      return null
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    let parsed: { must?: string[]; should?: string[]; phrases?: string[]; entities?: EntityHint[] }
    try { parsed = JSON.parse(jsonMatch[0]) } catch { return null }

    const must = (parsed.must || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    const should = (parsed.should || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    const phrases = (parsed.phrases || []).map((s) => String(s).trim()).filter(Boolean)
    const entityHints = Array.isArray(parsed.entities)
      ? parsed.entities.filter((e): e is EntityHint => !!e && typeof e.type === 'string' && typeof e.value === 'string').slice(0, 6)
      : []

    if (must.length === 0 && should.length === 0 && phrases.length === 0) return null

    // Build FTS5 query: must-tokens joined by AND; should-tokens OR'd; phrases verbatim.
    // (FTS5 default operator is OR if unspecified in our build; we use explicit
    //  parens to avoid ambiguity.)
    const escTok = (t: string) => {
      const safe = t.replace(/[^a-z0-9-]/gi, '')
      if (!safe) return null
      return safe.length >= 4 && /^[a-z]/i.test(safe) ? `${safe}*` : safe
    }
    const mustEsc = must.map(escTok).filter((s): s is string => s !== null)
    const shouldEsc = should.map(escTok).filter((s): s is string => s !== null)
    const phraseEsc = phrases.map((p) => `"${p.replace(/[^\w\s.-]/g, ' ').trim()}"`).filter((p) => p.length > 2)

    const ftsParts: string[] = []
    if (mustEsc.length > 0) ftsParts.push(`(${mustEsc.join(' AND ')})`)
    if (shouldEsc.length > 0) ftsParts.push(`(${shouldEsc.join(' OR ')})`)
    ftsParts.push(...phraseEsc)
    const ftsQuery = ftsParts.join(' OR ')
    const allTokens = [...new Set([...must, ...should])]

    const meta = this.buildMeta(query, ftsQuery, phraseEsc, allTokens, entityHints, false, true)
    return { ftsQuery, tokens: allTokens, phrases: phraseEsc, entityHints, expandedSynonyms: false, llmRefined: true, meta, original: query }
  }

  private buildMeta(
    original: string,
    ftsQuery: string,
    phrases: string[],
    tokens: string[],
    entities: EntityHint[],
    expanded: boolean,
    llmRefined: boolean
  ): string {
    const parts: string[] = []
    parts.push(`source: ${llmRefined ? 'LLM-refined' : 'deterministic'}`)
    if (tokens.length > 0) parts.push(`tokens: [${tokens.join(', ')}]`)
    if (phrases.length > 0) parts.push(`phrases: ${phrases.join(' ')}`)
    if (expanded) parts.push('synonym-expanded')
    if (entities.length > 0) {
      parts.push(`entities: ${entities.map((e) => `${e.type}:${e.value}`).join(', ')} (consider entity_lookup)`)
    }
    return `[meta] FTS query: ${ftsQuery || '(empty)'} | ${parts.join(' | ')}`
  }
}

export const queryPlanner = new QueryPlanner()
