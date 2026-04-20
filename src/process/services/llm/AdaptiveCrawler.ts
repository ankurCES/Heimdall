import { toolRegistry } from '../tools/ToolRegistry'
import { torService } from '../darkweb/TorService'
import {
  scoreSignalDensity, CrawlBudget, llmCrawlGate, adaptiveMaxDepth,
  type SignalScore, type CrawlDecision
} from './AdaptiveCrawl'
import log from 'electron-log'

/**
 * Adaptive Crawler — replaces the fixed-depth ResearchCrawler with
 * intelligent, relevance-driven crawling.
 *
 * Key differences from ResearchCrawler:
 *   - Depth is NOT fixed — each branch gets its own adaptive max depth
 *     based on signal density + LLM gate decision
 *   - Credit-based budget (50 per task) instead of flat fetch cap
 *   - LLM decides at each depth: ESSENTIAL / USEFUL / MARGINAL / IRRELEVANT
 *   - High-signal branches get explored deeper (up to hard cap 6)
 *   - Low-signal branches stop at depth 1-2
 *   - Image URLs extracted and returned separately
 *   - CSAM / porn / nav junk URL denylist enforced
 */

const CRAWL_PARALLELISM = 4
const MAX_WEB_BRANCHES = 3
const MAX_ONION_BRANCHES = 3
const LLM_GATE_INTERVAL = 2 // call LLM gate every N depth levels (not every single level)

const URL_RE = /https?:\/\/[^\s"'<>\])}]+/gi
const ONION_URL_RE = /https?:\/\/[a-z2-7]{16,56}\.onion(?:\/[^\s"'<>\])}]*)?/gi

const FILE_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'csv', 'doc', 'docx', 'json', 'xml', 'xlsx'
])
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'
])

const SKIP_URL_PATTERNS = [
  /\.(woff|woff2|ttf|eot|css|js|svg|ico)(\?|$)/i,
  /^https?:\/\/(www\.)?(google|facebook|twitter|instagram|youtube|tiktok|linkedin)\./i,
  /(login|logout|signup|register|cart|checkout|account|password|reset|unsubscribe)/i,
  /(privacy|terms|cookie|gdpr|disclaimer|about-us|contact-us|careers|jobs|faq|help)\/?$/i,
  /^mailto:/i,
  // CSAM / exploitation safety.
  /(boy.?and.?girl|stepfather|stepdad|preteen|pre-teen|underage|lolita|jailbait|pthc|kdv|ptsc|child.?porn|child.?abuse|csam|\/cp\/|\/cp$)/i,
  // Porn / adult.
  /(porn|adult|webcam|escort|sex.?work|onlyfans|xxx|nsfw)/i,
  // Nav junk.
  /(\/vendor\/|\/escrow|\/combine\/|\/assets\/css|\/feed\.xml|\/feed\/?$|\/comments\/feed|opensearchdescription|opengraph-image|wp-json\/oembed)/i,
  // Skip CDN image/static assets (handled separately by image discoverer).
  /\/(cdn|static|assets|fonts|media)\//i
]

export interface Finding {
  url: string
  hostname: string
  title: string
  content: string
  depth: number
  isOnion: boolean
  isFile: boolean
  fileExtension?: string
  sourceUrl: string | null
  relevanceScore: number
  signalScore: SignalScore | null
  crawlDecision?: CrawlDecision
}

export interface DiscoveredImage {
  url: string
  sourcePageUrl: string
  altText: string | null
  estimatedRelevance: 'high' | 'medium' | 'low'
}

export interface CrawlStats {
  totalFetched: number
  totalOnionFetched: number
  totalFilesFound: number
  totalImagesFound: number
  totalSkipped: number
  maxDepthReached: number
  budgetRemaining: number
  budgetSpent: number
  urlsExplored: string[]
}

export class AdaptiveCrawler {
  private visited = new Set<string>()
  private findings: Finding[] = []
  private discoveredImages: DiscoveredImage[] = []
  private failedHosts = new Map<string, number>()
  private readonly HOST_FAIL_THRESHOLD = 2
  private budget: CrawlBudget
  private taskKeywords: string[] = []
  private taskDescription: string = ''
  private connectionId?: string
  private stats: CrawlStats = {
    totalFetched: 0, totalOnionFetched: 0, totalFilesFound: 0,
    totalImagesFound: 0, totalSkipped: 0, maxDepthReached: 0,
    budgetRemaining: 50, budgetSpent: 0, urlsExplored: []
  }

  constructor(
    private onChunk?: (c: string) => void,
    budgetCredits: number = 50
  ) {
    this.budget = new CrawlBudget(budgetCredits)
  }

  setTaskContext(taskDescription: string, connectionId?: string): void {
    this.taskDescription = taskDescription
    this.connectionId = connectionId
    this.taskKeywords = taskDescription
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((w) => w.length >= 3)
      .slice(0, 20)
  }

  getFindings(): Finding[] { return this.findings }
  getDiscoveredImages(): DiscoveredImage[] { return this.discoveredImages }
  getStats(): CrawlStats {
    return {
      ...this.stats,
      budgetRemaining: this.budget.remaining(),
      budgetSpent: this.budget.totalSpent()
    }
  }
  getVisited(): Set<string> { return this.visited }

  markVisited(urls: string[]): void {
    for (const u of urls) this.visited.add(this.normalizeUrl(u))
  }

  /**
   * Adaptively crawl from a URL. Depth is not fixed — the crawler
   * decides how deep to go based on signal density + LLM gate.
   */
  async crawl(
    url: string,
    depth: number = 0,
    sourceUrl: string | null = null,
    branchMaxDepth: number = 4 // initial max for this branch
  ): Promise<Finding[]> {
    const normalized = this.normalizeUrl(url)
    if (this.visited.has(normalized)) return []
    if (depth > branchMaxDepth) return []
    this.visited.add(normalized)

    const isOnion = /\.onion/i.test(url)
    const host = this.extractHostname(url)

    // Host-failure check.
    if (host && (this.failedHosts.get(host) || 0) >= this.HOST_FAIL_THRESHOLD) {
      this.stats.totalSkipped++
      return []
    }

    // Tor check for .onion.
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
      if (!this.budget.canAfford('file')) return []
      this.budget.spend('file')
      this.stats.totalFilesFound++
      this.emit(`\n**[File found depth ${depth}]** ${url.slice(0, 100)} (.${ext})\n`)
      const finding: Finding = {
        url, hostname: host || 'unknown', title: `File: ${url.split('/').pop() || url}`,
        content: '', depth, isOnion, isFile: true, fileExtension: ext,
        sourceUrl, relevanceScore: 5, signalScore: null
      }
      this.findings.push(finding)
      return [finding]
    }

    // Check budget before fetching.
    // Pre-estimate relevance from URL (cheap heuristic before actual fetch).
    const urlRelevance = this.estimateUrlRelevance(url)
    if (!this.budget.canAfford(urlRelevance)) {
      this.emit(`\n**[Research skip]** budget exhausted (${this.budget.remaining()} credits left)\n`)
      return []
    }

    // Fetch the page.
    const toolName = isOnion ? 'onion_fetch' : 'web_fetch'
    const params = isOnion ? { url, max_chars: 5000 } : { url }
    this.emit(`\n**[Web crawl depth ${depth}]** ${url.slice(0, 100)}\n`)

    let text = ''
    let extractedUrls: string[] = []
    let extractedImageUrls: string[] = []

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
        const data = r.data as { text?: string; extractedUrls?: string[]; extractedImageUrls?: string[] }
        if (data.text) text = data.text
        if (Array.isArray(data.extractedUrls)) extractedUrls = data.extractedUrls
        if (Array.isArray(data.extractedImageUrls)) extractedImageUrls = data.extractedImageUrls
      }
      if (host) this.failedHosts.delete(host)
    } catch (err) {
      this.stats.totalSkipped++
      if (host) this.failedHosts.set(host, (this.failedHosts.get(host) || 0) + 1)
      return []
    }

    // Score signal density.
    const signalScore = scoreSignalDensity(text, this.taskKeywords, extractedUrls)
    this.budget.spend(signalScore.verdict)

    if (isOnion) this.stats.totalOnionFetched++
    else this.stats.totalFetched++
    this.stats.maxDepthReached = Math.max(this.stats.maxDepthReached, depth)
    this.stats.urlsExplored.push(url)

    // Create finding.
    const hostname = host || 'unknown'
    const titleMatch = text.match(/(?:^|\n)#\s*(.+)|<title>([^<]+)/i)
    const title = (titleMatch?.[1] || titleMatch?.[2] || hostname).slice(0, 120)
    const finding: Finding = {
      url, hostname, title, content: text.slice(0, 4000), depth, isOnion,
      isFile: false, sourceUrl, relevanceScore: signalScore.density * 10,
      signalScore
    }
    this.findings.push(finding)

    this.emit(`  → ${text.length} chars, signal=${signalScore.verdict} (kw=${signalScore.keywordMatches} ent=${signalScore.entityCount} files=${signalScore.fileLinks} onion=${signalScore.onionLinks} img=${signalScore.imageLinks})\n`)

    // Collect discovered images.
    for (const imgUrl of extractedImageUrls.slice(0, 5)) {
      if (this.isRelevantImage(imgUrl, url)) {
        this.discoveredImages.push({
          url: imgUrl,
          sourcePageUrl: url,
          altText: null,
          estimatedRelevance: signalScore.verdict === 'high' ? 'high' : 'medium'
        })
        this.stats.totalImagesFound++
      }
    }

    // ── Adaptive depth decision ──
    // At depth transitions, decide whether to go deeper.
    let childMaxDepth = branchMaxDepth

    if (depth > 0 && depth % LLM_GATE_INTERVAL === 0 && this.budget.remaining() > 5) {
      const gate = await llmCrawlGate(text.slice(0, 500), this.taskDescription, depth, this.connectionId)
      finding.crawlDecision = gate.decision
      childMaxDepth = adaptiveMaxDepth(depth, gate.decision, signalScore.verdict)
      this.emit(`  → LLM gate: ${gate.decision} → max depth ${childMaxDepth}\n`)

      if (gate.decision === 'irrelevant') {
        return [finding] // stop this branch
      }
      if (gate.decision === 'marginal') {
        // Only follow file + onion links at this depth.
        const marginalFindings = await this.followLinksFiltered(url, text, depth, extractedUrls, true)
        return [finding, ...marginalFindings]
      }
    }

    // Follow links normally.
    if (depth < childMaxDepth && this.budget.remaining() > 0) {
      const childFindings = await this.followLinks(url, text, depth, extractedUrls, childMaxDepth)
      return [finding, ...childFindings]
    }

    return [finding]
  }

  /** Follow top-K relevant links from a page. */
  private async followLinks(
    parentUrl: string,
    pageText: string,
    currentDepth: number,
    htmlExtractedUrls: string[],
    branchMaxDepth: number
  ): Promise<Finding[]> {
    const candidates = this.buildCandidates(parentUrl, pageText, htmlExtractedUrls)

    const webToFollow = candidates.filter((c) => !c.isOnion && !c.isFile).slice(0, MAX_WEB_BRANCHES)
    const onionToFollow = candidates.filter((c) => c.isOnion).slice(0, MAX_ONION_BRANCHES)
    const filesToFollow = candidates.filter((c) => c.isFile).slice(0, 3)

    const toFollow = [...webToFollow, ...onionToFollow, ...filesToFollow].filter((c) => c.score > 0)
    if (toFollow.length === 0) return []

    this.emit(`  → ${candidates.length} links, following ${toFollow.length}\n`)

    const childFindings: Finding[] = []
    for (let i = 0; i < toFollow.length; i += CRAWL_PARALLELISM) {
      if (this.budget.remaining() <= 0) break
      const batch = toFollow.slice(i, i + CRAWL_PARALLELISM)
      const results = await Promise.allSettled(
        batch.map((c) => this.crawl(c.url, currentDepth + 1, parentUrl, branchMaxDepth))
      )
      for (const r of results) {
        if (r.status === 'fulfilled') childFindings.push(...r.value)
      }
    }
    return childFindings
  }

  /** Marginal mode: only follow file + onion links. */
  private async followLinksFiltered(
    parentUrl: string,
    pageText: string,
    currentDepth: number,
    htmlExtractedUrls: string[],
    onlyFilesAndOnion: boolean
  ): Promise<Finding[]> {
    const candidates = this.buildCandidates(parentUrl, pageText, htmlExtractedUrls)
    const filtered = candidates.filter((c) => c.isFile || c.isOnion).slice(0, 5)
    if (filtered.length === 0) return []

    const childFindings: Finding[] = []
    for (const c of filtered) {
      if (this.budget.remaining() <= 0) break
      const results = await this.crawl(c.url, currentDepth + 1, parentUrl, currentDepth + 1)
      childFindings.push(...results)
    }
    return childFindings
  }

  private buildCandidates(parentUrl: string, pageText: string, htmlExtractedUrls: string[]): Array<{
    url: string; score: number; isOnion: boolean; isFile: boolean
  }> {
    URL_RE.lastIndex = 0
    ONION_URL_RE.lastIndex = 0
    const allUrls = new Set<string>()
    const onionUrls = new Set<string>()

    for (const u of htmlExtractedUrls) {
      const cleaned = u.replace(/[.,;:!?)}\]'"]+$/, '')
      allUrls.add(cleaned)
      if (/\.onion/i.test(cleaned)) onionUrls.add(cleaned)
    }
    for (const m of pageText.match(URL_RE) || []) {
      allUrls.add(m.replace(/[.,;:!?)}\]'"]+$/, ''))
    }
    for (const m of pageText.match(ONION_URL_RE) || []) {
      const cleaned = m.replace(/[.,;:!?)}\]'"]+$/, '')
      onionUrls.add(cleaned)
      allUrls.add(cleaned)
    }

    const candidates: Array<{ url: string; score: number; isOnion: boolean; isFile: boolean }> = []
    for (const url of allUrls) {
      if (this.visited.has(this.normalizeUrl(url))) continue
      if (this.shouldSkipUrl(url)) continue
      const isOnion = onionUrls.has(url)
      const ext = this.getFileExtension(url)
      const isFile = !!(ext && FILE_EXTENSIONS.has(ext))
      const score = this.scoreUrl(url)
      candidates.push({ url, score, isOnion, isFile })
    }
    candidates.sort((a, b) => b.score - a.score)
    return candidates
  }

  private scoreUrl(url: string): number {
    let score = 0
    const urlLower = url.toLowerCase()
    for (const kw of this.taskKeywords) {
      if (urlLower.includes(kw)) score += 3
    }
    if (/\.onion/i.test(url)) score += 2
    const ext = this.getFileExtension(url)
    if (ext && FILE_EXTENSIONS.has(ext)) score += 3
    if (ext && IMAGE_EXTENSIONS.has(ext)) score += 1
    const trustedDomains = ['cisa.gov', 'nvd.nist.gov', 'krebsonsecurity.com',
      'bleepingcomputer.com', 'therecord.media', 'thehackernews.com',
      'bellingcat.com', 'justice.gov', 'fbi.gov']
    const host = this.extractHostname(url)
    if (host && trustedDomains.some((d) => host.endsWith(d))) score += 2
    if (/\/(article|post|blog|report|advisory|bulletin|analysis|research)\//i.test(url)) score += 1
    for (const pattern of SKIP_URL_PATTERNS) {
      if (pattern.test(url)) { score -= 10; break }
    }
    return score
  }

  private estimateUrlRelevance(url: string): SignalScore['verdict'] {
    const score = this.scoreUrl(url)
    if (score >= 5) return 'high'
    if (score >= 2) return 'medium'
    if (score >= 0) return 'low'
    return 'noise'
  }

  private isRelevantImage(imgUrl: string, pageUrl: string): boolean {
    const urlLower = imgUrl.toLowerCase()
    // Skip tiny UI assets.
    if (/(logo|avatar|favicon|icon|sprite|banner|header|footer|button|arrow|close|menu)/i.test(urlLower)) return false
    if (/(cdn\.|static\.|assets\.|fonts\.|gravatar)/i.test(urlLower)) return false
    // Prefer images with task keywords in filename.
    for (const kw of this.taskKeywords) {
      if (urlLower.includes(kw)) return true
    }
    // Accept images from high-signal pages.
    return true
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
    } catch { return url.toLowerCase() }
  }

  private extractHostname(url: string): string | null {
    try { return new URL(url).hostname } catch { return null }
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
