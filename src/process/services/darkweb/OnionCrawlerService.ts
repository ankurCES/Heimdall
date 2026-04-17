import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { toolRegistry } from '../tools/ToolRegistry'
import { torService } from './TorService'
import log from 'electron-log'

/**
 * Onion Link Crawler — nested traversal of `.onion` URLs found inside
 * fetched dark-web pages.
 *
 * Every stored [DARKWEB] report's content is scanned for `.onion` URLs.
 * New (un-ingested) URLs are fetched via Tor, stored as child intel
 * reports linked to the parent via intel_links (link_type='onion_crossref'),
 * enriched via DarkWebEnrichmentService, and then recursively crawled
 * up to MAX_DEPTH hops.
 *
 * Safety:
 *   - MAX_DEPTH = 2 (parent → child → grandchild, stop)
 *   - MAX_CHILDREN_PER_PAGE = 5 (no link-farm explosion)
 *   - Global dedup: checks intel_reports.source_url + in-memory visited set
 *   - CSAM blocklist enforced at SafeFetcher layer
 *   - Tor-gated: pre-checks torService.getState()
 *   - Queue capped at QUEUE_CAP (50) pending jobs
 *   - Quarantined hosts (from darkweb_host_health) are skipped
 */

const MAX_DEPTH = 2
const MAX_CHILDREN_PER_PAGE = 5
const CRAWL_PARALLELISM = 4
const QUEUE_CAP = 50

/** Regex to extract .onion URLs from page text. Matches both http and https
 *  schemes, captures the full URL up to the first whitespace or quote. */
const ONION_URL_RE = /https?:\/\/[a-z2-7]{16,56}\.onion(?:\/[^\s"'<>\])}]*)?/gi

interface CrawlJob {
  reportId: string
  depth: number
}

export interface CrawlerStatus {
  enabled: boolean
  queued: number
  inFlight: number
  totalCrawled: number
  totalDiscovered: number
  totalSkippedDedup: number
  totalSkippedDepth: number
  totalFailed: number
}

class OnionCrawlerServiceImpl {
  private queue: CrawlJob[] = []
  private inFlight = new Set<string>() // reportId
  private visited = new Set<string>()  // source_url dedup within session
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private enabled = true
  private stats = {
    totalCrawled: 0,
    totalDiscovered: 0,
    totalSkippedDedup: 0,
    totalSkippedDepth: 0,
    totalFailed: 0
  }
  private listeners = new Set<(s: CrawlerStatus) => void>()

  constructor() {
    this.drainTimer = setInterval(() => this.drain(), 5_000)
  }

  /** Toggle auto-crawl on/off. When off, enqueue is a no-op. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    log.info(`OnionCrawler: ${enabled ? 'enabled' : 'disabled'}`)
  }
  isEnabled(): boolean { return this.enabled }

  /**
   * Enqueue a report for crawl-link extraction. Typically called right
   * after a [DARKWEB] report is stored. Fire-and-forget — the queue
   * handles back-pressure + dedup.
   *
   * @param reportId The stored report whose content to scan for .onion links
   * @param depth    Current traversal depth (0 = root, callers should omit)
   */
  enqueue(reportId: string, depth: number = 0): void {
    if (!this.enabled) return
    if (depth > MAX_DEPTH) { this.stats.totalSkippedDepth++; return }
    if (this.queue.length >= QUEUE_CAP) return
    if (this.inFlight.has(reportId)) return
    // Don't re-queue if we've already processed this report in this session
    if (this.visited.has(reportId)) return
    this.queue.push({ reportId, depth })
    this.emit()
    void this.drain()
  }

  getStatus(): CrawlerStatus {
    return {
      enabled: this.enabled,
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      ...this.stats
    }
  }

  onStatus(listener: (s: CrawlerStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reset session-level dedup set (useful after a restart or when the
   *  analyst wants to force re-crawl of previously visited pages). */
  resetVisited(): void {
    this.visited.clear()
    log.info('OnionCrawler: visited set reset')
  }

  // ── Internal ─────────────────────────────────────────────────────────
  private async drain(): Promise<void> {
    while (this.inFlight.size < CRAWL_PARALLELISM && this.queue.length > 0) {
      const job = this.queue.shift()!
      if (this.visited.has(job.reportId)) continue
      this.inFlight.add(job.reportId)
      this.emit()
      void this.processOne(job)
        .catch((err) => {
          log.warn(`OnionCrawler: crawlFrom(${job.reportId}, depth=${job.depth}) failed: ${err}`)
          this.stats.totalFailed++
        })
        .finally(() => {
          this.inFlight.delete(job.reportId)
          this.visited.add(job.reportId)
          this.emit()
        })
    }
  }

  private async processOne(job: CrawlJob): Promise<void> {
    const { reportId, depth } = job
    const db = getDatabase()

    // Tor check
    const torState = torService.getState()
    if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
      log.debug(`OnionCrawler: skipping ${reportId} — Tor not connected`)
      return
    }

    // Load report content
    const report = db.prepare('SELECT id, content, source_url FROM intel_reports WHERE id = ?').get(reportId) as {
      id: string; content: string; source_url: string | null
    } | undefined
    if (!report || !report.content) return

    // Extract .onion URLs from content
    const urls = this.extractOnionUrls(report.content)
    if (urls.length === 0) return

    this.stats.totalDiscovered += urls.length

    // Filter: already ingested?
    const newUrls: string[] = []
    for (const url of urls) {
      if (this.isAlreadyIngested(url)) {
        this.stats.totalSkippedDedup++
        // Still create a link if the child report exists — the relationship
        // is valuable even if the content was already stored from another path.
        this.linkExistingChild(reportId, url)
        continue
      }
      if (this.visited.has(url)) {
        this.stats.totalSkippedDedup++
        continue
      }
      newUrls.push(url)
    }

    // Cap children
    const toFetch = newUrls.slice(0, MAX_CHILDREN_PER_PAGE)

    // Fetch in parallel batches
    for (let i = 0; i < toFetch.length; i += CRAWL_PARALLELISM) {
      const batch = toFetch.slice(i, i + CRAWL_PARALLELISM)
      await Promise.allSettled(batch.map(async (url) => {
        this.visited.add(url) // mark before fetch to prevent parallel re-queue
        const host = this.extractHostname(url)
        if (!host) return

        // Skip quarantined hosts
        if (this.isQuarantined(host)) {
          this.stats.totalSkippedDedup++
          return
        }

        const r = await toolRegistry.execute('onion_fetch', { url, max_chars: 4000 })
        if (r.error || !r.data) {
          this.stats.totalFailed++
          this.recordHostFailure(host, r.error || 'empty response')
          return
        }
        this.recordHostSuccess(host)

        const data = r.data as { hostname?: string; text?: string }
        if (!data?.text) return

        // Store as child report
        const childId = await this.storeChild(reportId, url, data.hostname || host, data.text, depth)
        if (!childId) return // duplicate content hash

        this.stats.totalCrawled++
        this.emit()

        // Enqueue enrichment (fire-and-forget)
        try {
          const { darkWebEnrichmentService } = await import('./DarkWebEnrichmentService')
          darkWebEnrichmentService.enqueue(childId)
        } catch { /* */ }

        // RECURSE — enqueue child for next-depth crawl
        if (depth + 1 <= MAX_DEPTH) {
          this.enqueue(childId, depth + 1)
        }
      }))
    }
  }

  /**
   * Extract unique .onion URLs from page text. Normalizes by stripping
   * trailing punctuation and deduplicating.
   */
  extractOnionUrls(text: string): string[] {
    ONION_URL_RE.lastIndex = 0
    const matches = text.match(ONION_URL_RE) || []
    const seen = new Set<string>()
    const out: string[] = []
    for (let url of matches) {
      // Strip trailing punctuation that regex may have captured
      url = url.replace(/[.,;:!?)}\]'"]+$/, '')
      // Normalize: lowercase hostname portion
      try {
        const parsed = new URL(url)
        const normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`
        if (seen.has(normalized)) continue
        seen.add(normalized)
        out.push(url)
      } catch {
        // Malformed URL — skip
      }
    }
    return out
  }

  private isAlreadyIngested(url: string): boolean {
    try {
      const db = getDatabase()
      return !!(db.prepare('SELECT 1 FROM intel_reports WHERE source_url = ? LIMIT 1').get(url))
    } catch {
      return false
    }
  }

  private isQuarantined(hostname: string): boolean {
    try {
      const db = getDatabase()
      const row = db.prepare('SELECT quarantined FROM darkweb_host_health WHERE hostname = ?').get(hostname) as { quarantined: number } | undefined
      return row?.quarantined === 1
    } catch {
      return false
    }
  }

  /** Link an already-ingested child to the parent. Creates the relationship
   *  even though we don't re-fetch the content. */
  private linkExistingChild(parentId: string, childUrl: string): void {
    try {
      const db = getDatabase()
      const child = db.prepare('SELECT id FROM intel_reports WHERE source_url = ? LIMIT 1').get(childUrl) as { id: string } | undefined
      if (!child) return
      db.prepare(
        'INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(generateId(), parentId, child.id, 'onion_crossref', 0.7, 'Onion URL found in parent page (already ingested)', timestamp())
    } catch { /* */ }
  }

  private async storeChild(
    parentId: string,
    url: string,
    hostname: string,
    text: string,
    depth: number
  ): Promise<string | null> {
    const { createHash } = await import('crypto')
    const db = getDatabase()
    const now = timestamp()
    const trimmed = text.slice(0, 8000)
    const hash = createHash('sha256').update(url + '|' + trimmed).digest('hex')

    // Content-hash dedup
    const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
    if (existing) {
      // Still link even if content is duplicate
      db.prepare(
        'INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(generateId(), parentId, existing.id, 'onion_crossref', 0.7, `Onion URL crawled at depth ${depth} (content hash match)`, now)
      db.prepare('UPDATE intel_reports SET updated_at = ? WHERE id = ?').run(now, existing.id)
      return null
    }

    const id = generateId()
    const title = `[DARKWEB] ${hostname}`.slice(0, 200)
    const summary = trimmed.slice(0, 240).replace(/\s+/g, ' ').trim()
    const content = `**Source**: onion-crawl (depth ${depth}, parent: ${parentId.slice(0, 8)})\n**Onion URL**: ${url}\n**Crawled at**: ${new Date(now).toISOString()}\n\n---\n\n${trimmed}`

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'osint', title, content, summary, 'medium', 'onion-crawler', `Onion: ${hostname}`, url, hash, 35, 0, now, now)

    // Tags
    const tags = ['darkweb', 'onion-fetch', 'onion-crawl', `crawl-depth:${depth}`, `parent:${parentId.slice(0, 8)}`]
    const tagStmt = db.prepare(
      'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const tag of tags) {
      try { tagStmt.run(id, tag, 1.0, 'onion-crawler', now) } catch { /* */ }
    }

    // Link parent → child
    db.prepare(
      'INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(generateId(), parentId, id, 'onion_crossref', 0.7, `Onion URL crawled at depth ${depth}`, now)

    log.info(`OnionCrawler: stored child [${hostname}] → ${id} (depth ${depth}, parent ${parentId.slice(0, 8)})`)
    return id
  }

  private recordHostSuccess(hostname: string): void {
    try {
      const { darkWebSeedService } = require('./DarkWebSeedService')
      darkWebSeedService.recordHostSuccess(hostname)
    } catch { /* */ }
  }
  private recordHostFailure(hostname: string, error: string): void {
    try {
      const { darkWebSeedService } = require('./DarkWebSeedService')
      darkWebSeedService.recordHostFailure(hostname, error)
    } catch { /* */ }
  }

  private extractHostname(url: string): string | null {
    try { return new URL(url).hostname } catch { return null }
  }

  private emit(): void {
    const s = this.getStatus()
    for (const l of this.listeners) {
      try { l(s) } catch { /* */ }
    }
  }
}

export const onionCrawlerService = new OnionCrawlerServiceImpl()
