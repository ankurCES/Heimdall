import log from 'electron-log'
import crypto from 'crypto'
import { RateLimiter } from '../services/ratelimit/RateLimiter'
import { RobotsChecker } from '../services/ratelimit/RobotsChecker'
import { auditService } from '../services/audit/AuditService'

const USER_AGENT = 'Heimdall/0.1.0 (Public Safety Intelligence Monitor; +https://github.com/ankurCES/Heimdall)'

export interface FetchOptions {
  headers?: Record<string, string>
  timeout?: number
  maxRetries?: number
}

export class SafeFetcher {
  private rateLimiter: RateLimiter
  private robotsChecker: RobotsChecker
  private airGapMode = false
  private airGapAllowlist: Set<string> = new Set()
  private socks5Proxy: { host: string; port: number } | null = null
  /** SHA-256 hashes of blocked .onion hostnames (CSAM prevention). */
  private csamBlocklist = new Set<string>()

  constructor(requestsPerMinute: number = 30, respectRobots: boolean = true) {
    this.rateLimiter = new RateLimiter(requestsPerMinute)
    this.robotsChecker = new RobotsChecker()
    this.robotsChecker.setEnabled(respectRobots)
  }

  setRate(requestsPerMinute: number): void {
    this.rateLimiter.setRate(requestsPerMinute)
  }

  setRobotsEnabled(enabled: boolean): void {
    this.robotsChecker.setEnabled(enabled)
  }

  /**
   * Air-gap mode (Theme 10.6). When enabled every outbound fetch is
   * refused unless the hostname matches the allowlist (exact or
   * DNS-suffix match). The failure is auditable and the collector
   * bubbles it up as any other fetch error.
   */
  setAirGap(enabled: boolean, allowlist: string[] = []): void {
    this.airGapMode = enabled
    this.airGapAllowlist = new Set(
      allowlist.map((s) => s.trim().toLowerCase()).filter(Boolean)
    )
    log.info(`SafeFetcher: air-gap ${enabled ? `ENABLED (allowlist=${Array.from(this.airGapAllowlist).join(',') || '<empty>'})` : 'disabled'}`)
  }

  isAirGapped(): boolean { return this.airGapMode }

  /**
   * Theme 7.5 — SOCKS5 proxy for .onion domains. Deployers run Tor
   * externally and point Heimdall at the local SOCKS5 port (default
   * 127.0.0.1:9050). Non-.onion URLs are NOT routed through the proxy.
   */
  setSocks5(host: string | null, port: number = 9050): void {
    if (host) {
      this.socks5Proxy = { host, port }
      log.info(`SafeFetcher: SOCKS5 proxy set to ${host}:${port}`)
    } else {
      this.socks5Proxy = null
      log.info('SafeFetcher: SOCKS5 proxy disabled')
    }
  }

  addCsamBlock(domainHash: string): void { this.csamBlocklist.add(domainHash) }

  private isCsamBlocked(hostname: string): boolean {
    const hash = crypto.createHash('sha256').update(hostname.toLowerCase()).digest('hex')
    return this.csamBlocklist.has(hash)
  }

  private isPrivateHost(hostname: string): boolean {
    const h = hostname.toLowerCase()
    // Loopback
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
    // Link-local, metadata
    if (h.startsWith('169.254.') || h === '169.254.169.254') return true
    // Cloud metadata endpoints
    if (h === 'metadata.google.internal') return true
    // Private RFC 1918 ranges (rough hostname check — doesn't resolve DNS,
    // but blocks the obvious cases)
    if (/^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h)) return true
    // IPv6 mapped
    if (h.startsWith('::ffff:127.') || h.startsWith('::ffff:10.') || h.startsWith('::ffff:192.168.')) return true
    // file:// protocol guard (shouldn't reach here but defence in depth)
    if (h === '' || h === '0.0.0.0') return true
    return false
  }

  private airGapAllows(hostname: string): boolean {
    if (!this.airGapMode) return true
    const h = hostname.toLowerCase()
    for (const allowed of this.airGapAllowlist) {
      if (h === allowed || h.endsWith(`.${allowed}`)) return true
    }
    return false
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const { headers = {}, timeout = 30000, maxRetries = 3 } = options
    const domain = new URL(url).hostname

    // SSRF prevention — block private/loopback/link-local IP ranges.
    if (this.isPrivateHost(domain)) {
      auditService.log('fetch.ssrf_blocked', { url, domain })
      throw new Error(`Blocked: ${domain} resolves to a private/internal address`)
    }

    // Air-gap gate. Hard block BEFORE robots / rate limit / retry — nothing
    // leaves the host unless explicitly allowlisted.
    if (!this.airGapAllows(domain)) {
      auditService.log('fetch.airgap_blocked', { url, domain })
      throw new Error(`Blocked by air-gap mode: ${url}`)
    }

    // CSAM gate — SHA-256 hash comparison so the blocklist itself contains
    // no plaintext domain names.
    if (this.isCsamBlocked(domain)) {
      const domainHash = crypto.createHash('sha256').update(domain.toLowerCase()).digest('hex')
      auditService.log('fetch.csam_blocked', { domain_hash: domainHash })
      throw new Error(`Blocked by CSAM blocklist`)
    }

    // Check robots.txt
    const allowed = await this.robotsChecker.isAllowed(url)
    if (!allowed) {
      auditService.log('fetch.robots_blocked', { url, domain })
      throw new Error(`Blocked by robots.txt: ${url}`)
    }

    // Acquire rate limit token
    await this.rateLimiter.acquire(domain)

    // Retry loop
    let lastError: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        auditService.log('fetch.start', { url, domain, attempt })

        // SOCKS5 proxy for .onion domains (Theme 7.5 dark-web monitoring).
        // Non-.onion URLs bypass the proxy entirely.
        const fetchOpts: RequestInit & { dispatcher?: unknown } = {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/xml, application/xml, text/html, */*',
            ...headers
          },
          signal: AbortSignal.timeout(timeout)
        }
        if (domain.endsWith('.onion') && this.socks5Proxy) {
          try {
            const { SocksProxyAgent } = await import('socks-proxy-agent')
            const agent = new SocksProxyAgent(`socks5h://${this.socks5Proxy.host}:${this.socks5Proxy.port}`)
            ;(fetchOpts as Record<string, unknown>).agent = agent
          } catch (err) {
            log.warn(`SafeFetcher: SOCKS5 proxy failed to load: ${(err as Error).message}`)
          }
        }
        const response = await fetch(url, fetchOpts)

        auditService.log('fetch.success', {
          url,
          domain,
          status: response.status,
          attempt
        }, url, response.status)

        return response
      } catch (err) {
        lastError = err as Error
        log.warn(`Fetch attempt ${attempt + 1}/${maxRetries} failed for ${url}: ${err}`)
        auditService.log('fetch.error', {
          url,
          domain,
          error: String(err),
          attempt
        }, url)

        if (attempt < maxRetries - 1) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 10000)
          await new Promise((resolve) => setTimeout(resolve, backoff))
          await this.rateLimiter.acquire(domain) // Re-acquire for retry
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`)
  }

  async fetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
    const response = await this.fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...options.headers }
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return response.json() as Promise<T>
  }

  async fetchText(url: string, options: FetchOptions = {}): Promise<string> {
    const response = await this.fetch(url, options)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return response.text()
  }

  getRateLimitUsage(domain: string): { available: number; max: number } {
    return this.rateLimiter.getUsage(domain)
  }

  /** Remove rate limiter buckets not accessed in the last hour */
  pruneStale(): void {
    this.rateLimiter.pruneStale()
  }

  /** Remove expired robots.txt cache entries and cap at 200 */
  pruneRobotsCache(): void {
    this.robotsChecker.prune()
  }
}

// Shared instance
export const safeFetcher = new SafeFetcher()
