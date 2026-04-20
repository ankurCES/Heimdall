import { toolRegistry } from '../tools/ToolRegistry'
import { torService } from '../darkweb/TorService'
import log from 'electron-log'

/**
 * Session-scoped recursive web + dark-web crawler for deep research.
 *
 * Used by DeepResearchAgent during the auto-research phase. For each
 * fetched page, extracts URLs, scores their relevance to the research
 * task, and follows the top-K. Recursion stops at MAX_DEPTH (4) or when
 * no relevant URLs remain.
 *
 * NOT a persistent service — created per research run, GC'd after.
 * Separate from OnionCrawlerService (which is persistent + stores to DB).
 *
 * No time cap — depth (4) + branch factor (3 web + all .onion) are the
 * only stopping conditions.
 */

const MAX_DEPTH = 4
const MAX_WEB_BRANCHES = 3   // max clearnet URLs to follow per page
const MAX_ONION_BRANCHES = 3 // max .onion URLs to follow per page
const CRAWL_PARALLELISM = 4
const MAX_TOTAL_FETCHES = 30 // global cap per crawl session — prevents exponential tree explosion

const URL_RE = /https?:\/\/[^\s"'<>\])}]+/gi
const ONION_URL_RE = /https?:\/\/[a-z2-7]{16,56}\.onion(?:\/[^\s"'<>\])}]*)?/gi
const FILE_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'csv', 'doc', 'docx', 'json', 'xml', 'xlsx'
])
const SKIP_URL_PATTERNS = [
  /\.(jpg|jpeg|png|gif|svg|ico|webp|mp4|mp3|woff|woff2|ttf|eot|css|js)(\?|$)/i,
  /^https?:\/\/(www\.)?(google|facebook|twitter|instagram|youtube|tiktok|linkedin)\./i,
  /(login|logout|signup|register|cart|checkout|account|password|reset|unsubscribe)/i,
  /(privacy|terms|cookie|gdpr|disclaimer|about-us|contact-us|careers|jobs|faq|help)\/?$/i,
  /^mailto:/i,
  // CSAM / exploitation safety — block URL paths that indicate child
  // abuse content. Defense in depth alongside SafeFetcher's hostname
  // hash blocklist. Conservative: false positives are acceptable.
  /(boy.?and.?girl|stepfather|stepdad|preteen|pre-teen|underage|lolita|jailbait|pthc|kdv|ptsc|child.?porn|child.?abuse|csam|\/cp\/|\/cp$)/i,
  // Porn / adult — not intel-relevant, waste of fetches.
  /(porn|adult|webcam|escort|sex.?work|onlyfans|xxx|nsfw)/i,
  // Marketplace nav junk — vendor pages, escrow, cart.
  /(\/vendor\/|\/escrow|\/combine\/|\/assets\/css|\/feed\.xml|\/feed\/?$|\/comments\/feed|opensearchdescription)/i
]

export interface Finding {
  url: string
  hostname: string
  title: string
  content: string // truncated text content
  depth: number
  isOnion: boolean
  isFile: boolean
  fileExtension?: string
  sourceUrl: string | null // parent URL that linked here
  relevanceScore: number
}

export interface CrawlStats {
  totalFetched: number
  totalOnionFetched: number
  totalFilesFound: number
  totalSkipped: number
  maxDepthReached: number
  urlsExplored: string[]
}

export class ResearchCrawler {
  private visited = new Set<string>()
  private findings: Finding[] = []
  private stats: CrawlStats = {
    totalFetched: 0, totalOnionFetched: 0, totalFilesFound: 0,
    totalSkipped: 0, maxDepthReached: 0, urlsExplored: []
  }
  private taskKeywords: string[] = []
  /** Hosts with ≥2 consecutive fetch failures — all future URLs on these
   *  hosts are skipped to avoid wasting 30s per timeout. */
  private failedHosts = new Map<string, number>()
  private readonly HOST_FAIL_THRESHOLD = 2

  constructor(private onChunk?: (c: string) => void) {}

  /** Set the research task context — keywords used for relevance scoring. */
  setTaskContext(taskDescription: string): void {
    this.taskKeywords = taskDescription
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => w.length >= 3)
      .slice(0, 20)
  }

  getFindings(): Finding[] { return this.findings }
  getStats(): CrawlStats { return this.stats }
  getVisited(): Set<string> { return this.visited }

  /** Mark URLs as already visited (e.g. from prior research steps). */
  markVisited(urls: string[]): void {
    for (const u of urls) this.visited.add(this.normalizeUrl(u))
  }

  /**
   * Recursively crawl starting from a URL. Fetches the page, extracts
   * links, scores relevance, follows top-K, repeats up to MAX_DEPTH.
   *
   * Returns findings discovered from this URL and its descendants.
   */
  async crawl(
    url: string,
    depth: number = 0,
    sourceUrl: string | null = null
  ): Promise<Finding[]> {
    const normalized = this.normalizeUrl(url)
    if (this.visited.has(normalized)) return []
    if (depth > MAX_DEPTH) return []
    // Global fetch cap — prevents exponential tree explosion.
    const totalFetches = this.stats.totalFetched + this.stats.totalOnionFetched
    if (totalFetches >= MAX_TOTAL_FETCHES) {
      this.emit(`\n**[Research skip]** global cap reached (${totalFetches}/${MAX_TOTAL_FETCHES} fetches)\n`)
      return []
    }
    this.visited.add(normalized)

    const isOnion = /\.onion/i.test(url)
    const host = this.extractHostname(url)

    // Host-level failure check — skip all URLs on hosts that have
    // failed ≥ HOST_FAIL_THRESHOLD times consecutively.
    if (host && (this.failedHosts.get(host) || 0) >= this.HOST_FAIL_THRESHOLD) {
      this.emit(`\n**[Research skip]** ${url.slice(0, 80)} — host ${host.slice(0, 20)}… failed ${this.failedHosts.get(host)} times, skipping\n`)
      this.stats.totalSkipped++
      return []
    }

    // Pre-checks.
    if (isOnion) {
      const torState = torService.getState()
      if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
        this.emit(`\n**[Research skip]** ${url.slice(0, 80)} — Tor not connected\n`)
        return []
      }
    }

    if (this.shouldSkipUrl(url)) {
      this.stats.totalSkipped++
      return []
    }

    // Check if it's a file download.
    const ext = this.getFileExtension(url)
    if (ext && FILE_EXTENSIONS.has(ext)) {
      this.stats.totalFilesFound++
      this.emit(`\n**[File found depth ${depth}]** ${url.slice(0, 100)} (.${ext})\n`)
      const finding: Finding = {
        url, hostname: this.extractHostname(url), title: `File: ${url.split('/').pop() || url}`,
        content: '', depth, isOnion, isFile: true, fileExtension: ext,
        sourceUrl, relevanceScore: this.scoreUrl(url, '')
      }
      this.findings.push(finding)
      return [finding]
    }

    // Fetch the page.
    const toolName = isOnion ? 'onion_fetch' : 'web_fetch'
    const params = isOnion ? { url, max_chars: 5000 } : { url }
    this.emit(`\n**[Web crawl depth ${depth}]** ${url.slice(0, 100)}\n`)

    let text = ''
    let extractedUrls: string[] = []
    try {
      const r = await toolRegistry.execute(toolName, params)
      if (r.error) {
        this.emit(`  → error: ${r.error.slice(0, 80)}\n`)
        this.stats.totalSkipped++
        if (host) this.failedHosts.set(host, (this.failedHosts.get(host) || 0) + 1)
        return []
      }
      text = r.output || ''
      if (r.data) {
        const data = r.data as { text?: string; extractedUrls?: string[] }
        if (data.text) text = data.text
        if (Array.isArray(data.extractedUrls)) extractedUrls = data.extractedUrls
      }
      // Success — reset host failure counter.
      if (host) this.failedHosts.delete(host)
    } catch (err) {
      this.stats.totalSkipped++
      if (host) this.failedHosts.set(host, (this.failedHosts.get(host) || 0) + 1)
      return []
    }

    if (isOnion) this.stats.totalOnionFetched++
    else this.stats.totalFetched++
    this.stats.maxDepthReached = Math.max(this.stats.maxDepthReached, depth)
    this.stats.urlsExplored.push(url)

    // Create finding for this page.
    const hostname = this.extractHostname(url)
    const titleMatch = text.match(/(?:^|\n)#\s*(.+)|<title>([^<]+)/i)
    const title = (titleMatch?.[1] || titleMatch?.[2] || hostname).slice(0, 120)
    const finding: Finding = {
      url, hostname, title, content: text.slice(0, 4000), depth, isOnion,
      isFile: false, sourceUrl, relevanceScore: this.scoreUrl(url, text)
    }
    this.findings.push(finding)
    this.emit(`  → ${text.length} chars, relevance=${finding.relevanceScore.toFixed(1)}\n`)

    // Stop recursion at max depth.
    if (depth >= MAX_DEPTH) return [finding]

    // Extract + score + follow child URLs. Use HTML-extracted hrefs
    // (which include file links like <a href="doc.pdf">) as the primary
    // source, supplemented by regex on the stripped text.
    const childFindings = await this.followLinks(url, text, depth, extractedUrls)
    return [finding, ...childFindings]
  }

  /** Extract URLs from page text + HTML-extracted hrefs, score relevance, follow top-K. */
  private async followLinks(
    parentUrl: string,
    pageText: string,
    currentDepth: number,
    htmlExtractedUrls: string[] = []
  ): Promise<Finding[]> {
    // Combine HTML-extracted hrefs (primary — catches file links in
    // <a href="doc.pdf"> that are lost after HTML→text stripping) with
    // regex-extracted URLs from the stripped text (fallback for URLs
    // that appear as plain text, not in href attributes).
    URL_RE.lastIndex = 0
    ONION_URL_RE.lastIndex = 0
    const allUrls = new Set<string>()
    const onionUrls = new Set<string>()

    // Primary: HTML-extracted hrefs (includes file downloads).
    for (const u of htmlExtractedUrls) {
      const cleaned = u.replace(/[.,;:!?)}\]'"]+$/, '')
      allUrls.add(cleaned)
      if (/\.onion/i.test(cleaned)) onionUrls.add(cleaned)
    }

    // Secondary: regex on stripped text.
    for (const m of pageText.match(URL_RE) || []) {
      const cleaned = m.replace(/[.,;:!?)}\]'"]+$/, '')
      allUrls.add(cleaned)
    }
    for (const m of pageText.match(ONION_URL_RE) || []) {
      const cleaned = m.replace(/[.,;:!?)}\]'"]+$/, '')
      onionUrls.add(cleaned)
      allUrls.add(cleaned)
    }

    // Remove already-visited + self-references.
    const parentHost = this.extractHostname(parentUrl)
    const candidates: Array<{ url: string; score: number; isOnion: boolean; isFile: boolean }> = []

    for (const url of allUrls) {
      const normalized = this.normalizeUrl(url)
      if (this.visited.has(normalized)) continue
      if (this.shouldSkipUrl(url)) continue

      const isOnion = onionUrls.has(url)
      const ext = this.getFileExtension(url)
      const isFile = !!(ext && FILE_EXTENSIONS.has(ext))
      const score = this.scoreUrl(url, pageText)

      candidates.push({ url, score, isOnion, isFile })
    }

    // Sort by score descending.
    candidates.sort((a, b) => b.score - a.score)

    // Select top-K: separate budgets for web vs onion.
    const webToFollow = candidates
      .filter((c) => !c.isOnion)
      .slice(0, MAX_WEB_BRANCHES)
    const onionToFollow = candidates
      .filter((c) => c.isOnion)
      .slice(0, MAX_ONION_BRANCHES)
    const filesToFollow = candidates
      .filter((c) => c.isFile && c.score > 0)
      .slice(0, 5)

    const toFollow = [...webToFollow, ...onionToFollow, ...filesToFollow]
      .filter((c) => c.score > 0)

    if (toFollow.length === 0) return []

    this.emit(`  → ${candidates.length} links found, following ${toFollow.length} (${webToFollow.length} web + ${onionToFollow.length} onion + ${filesToFollow.length} files)\n`)

    // Follow in parallel batches.
    const childFindings: Finding[] = []
    for (let i = 0; i < toFollow.length; i += CRAWL_PARALLELISM) {
      const batch = toFollow.slice(i, i + CRAWL_PARALLELISM)
      const results = await Promise.allSettled(
        batch.map((c) => this.crawl(c.url, currentDepth + 1, parentUrl))
      )
      for (const r of results) {
        if (r.status === 'fulfilled') childFindings.push(...r.value)
      }
    }
    return childFindings
  }

  /**
   * Score a URL's relevance to the current research task.
   *
   *   > 0 = worth following
   *   ≤ 0 = skip
   */
  private scoreUrl(url: string, pageContext: string): number {
    let score = 0
    const urlLower = url.toLowerCase()

    // Keyword match from task context.
    for (const kw of this.taskKeywords) {
      if (urlLower.includes(kw)) score += 3
    }

    // .onion = always interesting.
    if (/\.onion/i.test(url)) score += 2

    // File download = interesting.
    const ext = this.getFileExtension(url)
    if (ext && FILE_EXTENSIONS.has(ext)) score += 3

    // Same domain as known good intel sources.
    const host = this.extractHostname(url)
    const trustedDomains = ['cisa.gov', 'nvd.nist.gov', 'us-cert.gov', 'krebsonsecurity.com',
      'bleepingcomputer.com', 'therecord.media', 'thehackernews.com', 'securityweek.com',
      'threatpost.com', 'darkreading.com', 'bellingcat.com']
    if (trustedDomains.some((d) => host.endsWith(d))) score += 2

    // News / research indicators in URL.
    if (/\/(article|post|blog|report|advisory|bulletin|alert|brief|analysis|research)\//i.test(url)) score += 1

    // Skip patterns (navigation, auth, etc.).
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) { score -= 10; break }
    }

    return score
  }

  private shouldSkipUrl(url: string): boolean {
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) return true
    }
    return false
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, '')
    } catch {
      return url.toLowerCase()
    }
  }

  private extractHostname(url: string): string {
    try { return new URL(url).hostname } catch { return 'unknown' }
  }

  private getFileExtension(url: string): string | null {
    try {
      const path = new URL(url).pathname
      const parts = path.split('.')
      if (parts.length < 2) return null
      const ext = parts.pop()!.toLowerCase().split('?')[0]
      return ext.length <= 5 ? ext : null
    } catch { return null }
  }

  private emit(chunk: string): void {
    this.onChunk?.(chunk)
  }
}
