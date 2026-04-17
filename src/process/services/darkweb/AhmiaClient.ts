import { safeFetcher } from '../../collectors/SafeFetcher'
import log from 'electron-log'

/**
 * Ahmia clearnet search client.
 *
 * Ahmia removed the `format=json` API in 2024–25; queries against `/search/`
 * without the form's anti-bot token now 302 to the home page, and POSTs are
 * 405. The token is a hidden input on the home page whose NAME and VALUE
 * both rotate (e.g. `<input type="hidden" name="98391c" value="11eb60">`).
 *
 * This client:
 *   1. fetches the home page and extracts the current token name+value
 *   2. issues the search GET with `?q=<term>&<token_name>=<token_value>`
 *   3. parses the resulting HTML into structured hits
 *
 * Tokens are cached for a short TTL because rotating them per query would
 * (a) double the request count and (b) trip Ahmia's rate limit faster.
 */

export interface AhmiaHit {
  title: string
  onionUrl: string
  description: string
  lastSeen?: string
}

interface CachedToken {
  name: string
  value: string
  fetchedAt: number
}

const TOKEN_TTL_MS = 30 * 60_000 // 30 min — well within how long Ahmia keeps a token live
const HOME_URL = 'https://ahmia.fi/'
const SEARCH_URL = 'https://ahmia.fi/search/'

let cachedToken: CachedToken | null = null

async function fetchToken(): Promise<CachedToken> {
  const html = await safeFetcher.fetchText(HOME_URL, { timeout: 10_000, skipRobots: true })
  // Find the lone hidden input INSIDE the search form. The name is a short
  // hex string (e.g. "98391c"). Locate it by anchoring to the search form.
  const formMatch = html.match(/<form[^>]*id="searchForm"[\s\S]*?<\/form>/i)
  const scope = formMatch ? formMatch[0] : html
  const tokenMatch = scope.match(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/i)
    ?? scope.match(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"[^>]+type="hidden"/i)
  if (!tokenMatch) throw new Error('Ahmia anti-bot token not found on home page')
  const tok: CachedToken = { name: tokenMatch[1], value: tokenMatch[2], fetchedAt: Date.now() }
  cachedToken = tok
  log.debug(`AhmiaClient: cached token ${tok.name}=${tok.value}`)
  return tok
}

async function getToken(): Promise<CachedToken> {
  if (cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS) return cachedToken
  return fetchToken()
}

/**
 * Parse the search results HTML into structured hits. Each result lives in
 * `<li class="result">` containing:
 *   <h4><a href="/search/redirect?...&redirect_url=<onion>">Title</a></h4>
 *   <p>Description</p>
 *   <cite>onion-domain</cite>
 *   <span class="lastSeen" data-timestamp="...">
 */
function parseResults(html: string, limit: number): AhmiaHit[] {
  const hits: AhmiaHit[] = []
  // Split on `<li class="result">` to get one chunk per result. Anchored
  // string split is far more robust than crafting a single multi-line regex
  // for a structure with optional whitespace + escaped HTML in titles.
  const chunks = html.split(/<li class="result">/i).slice(1, limit + 1)
  for (const chunk of chunks) {
    // Title — strip surrounding whitespace + entities decode (minimal).
    const titleMatch = chunk.match(/<h4>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/i)
    const title = decodeHtmlEntities((titleMatch?.[1] || '').replace(/\s+/g, ' ').trim()).slice(0, 250)
    // Onion URL — pull from the redirect querystring. Fall back to <cite>
    // value if the redirect URL is missing.
    const redirectMatch = chunk.match(/redirect_url=(https?:\/\/[^"'&]+\.onion[^"'&]*)/i)
    const citeMatch = chunk.match(/<cite>([^<]+\.onion[^<]*)<\/cite>/i)
    const onionUrl = redirectMatch?.[1] ? decodeURIComponent(redirectMatch[1]) :
                     citeMatch ? `http://${citeMatch[1].trim()}` : ''
    if (!onionUrl) continue
    // Description.
    const descMatch = chunk.match(/<p>\s*([\s\S]*?)\s*<\/p>/i)
    const description = decodeHtmlEntities((descMatch?.[1] || '').replace(/\s+/g, ' ').trim()).slice(0, 500)
    // Last-seen timestamp from the <span class="lastSeen" data-timestamp="...">.
    const tsMatch = chunk.match(/class="lastSeen"\s+data-timestamp="([^"]+)"/i)
    hits.push({
      title: title || '(untitled)',
      onionUrl,
      description: description || '(no description)',
      lastSeen: tsMatch?.[1]
    })
  }
  return hits
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
}

/**
 * Run a search against ahmia.fi and return parsed hits. One internal retry
 * on token failure (rotates if Ahmia invalidated the cached one).
 */
export async function ahmiaSearch(query: string, limit: number = 10): Promise<AhmiaHit[]> {
  const q = query.trim()
  if (!q) return []
  const cap = Math.min(Math.max(limit, 1), 25)
  // Try with cached token first; on redirect-to-home (no results parsed),
  // refresh the token and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await getToken()
    const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&${encodeURIComponent(tok.name)}=${encodeURIComponent(tok.value)}`
    const html = await safeFetcher.fetchText(url, { timeout: 15_000, skipRobots: true })
    // If the page came back without any `<li class="result">`, Ahmia likely
    // rejected the token (silent 302 → home). Invalidate cache + retry.
    if (!/<li class="result">/i.test(html)) {
      cachedToken = null
      if (attempt === 0) continue
      return []
    }
    return parseResults(html, cap)
  }
  return []
}
