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
  /** Skip the robots.txt check for this single call. Use ONLY for explicit
   *  user-initiated actions (e.g. an analyst typing a dark-web search query
   *  in chat) where the destination's robots.txt blocks crawlers but not
   *  individual queries — Ahmia disallows /search/ to keep search engines
   *  out of its index, not to deny access. Audit log still records every
   *  fetch so the bypass is traceable. */
  skipRobots?: boolean
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
    const { headers = {}, timeout = 30000, maxRetries = 3, skipRobots = false } = options
    const domain = new URL(url).hostname

    // SSRF prevention — block private/loopback/link-local IP ranges.
    if (this.isPrivateHost(domain)) {
      auditService.log('fetch.ssrf_blocked', { url, domain })
      throw new Error(`Blocked: ${domain} resolves to a private/internal address`)
    }

    // v1.3.1 — OPSEC gate. When OpSec is in paranoid mode (or air-gap
    // explicitly enforced), only allow-listed hostnames are reachable.
    // We lazy-import to avoid a circular dep at boot time.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const opsec = require('../services/opsec/OpSecService') as typeof import('../services/opsec/OpSecService')
      if (opsec.opSecService.shouldBlockOutbound(domain)) {
        auditService.log('fetch.opsec_blocked', { url, domain })
        throw new Error(`Blocked by OPSEC air-gap mode: ${domain} not on allow-list`)
      }
      // Optional warning hook — non-blocking, just notes external calls
      const cfg = opsec.opSecService.config()
      if (cfg.warnOnExternalCalls && !opsec.opSecService.isLocalAddress(domain)) {
        auditService.log('fetch.external_call_warn', { url, domain, mode: cfg.mode })
      }
    } catch (err) {
      // OpSecService not yet loaded (very-early boot); fall through to
      // the legacy air-gap gate below.
      if ((err as Error).message?.includes('OPSEC')) throw err
    }

    // Air-gap gate (legacy / settings-driven). Hard block BEFORE robots
    // / rate limit / retry — nothing leaves the host unless explicitly
    // allowlisted.
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

    // Check robots.txt — skipped for explicit user-initiated actions
    // (skipRobots: true). Audit log still records the bypass below.
    if (!skipRobots) {
      const allowed = await this.robotsChecker.isAllowed(url)
      if (!allowed) {
        auditService.log('fetch.robots_blocked', { url, domain })
        throw new Error(`Blocked by robots.txt: ${url}`)
      }
    } else {
      auditService.log('fetch.robots_skipped', { url, domain, reason: 'explicit_skip_robots' })
    }

    // Acquire rate limit token
    await this.rateLimiter.acquire(domain)

    // Retry loop
    let lastError: Error | null = null
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        auditService.log('fetch.start', { url, domain, attempt })

        let response: Response

        // SOCKS5 proxy for .onion domains. Node's built-in fetch (undici)
        // silently ignores the legacy `agent` option, so passing
        // SocksProxyAgent there does NOTHING — the request goes through
        // the system DNS resolver, which has no .onion records, and fails
        // instantly with "fetch failed". For .onion we drop down to the
        // node:http module which DOES honor the agent option, then wrap
        // the response back into a Web Response so callers don't notice.
        if (domain.endsWith('.onion') && this.socks5Proxy) {
          response = await this.fetchOnionViaSocks(url, headers, timeout)
        } else {
          const fetchOpts: RequestInit = {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json, text/xml, application/xml, text/html, */*',
              ...headers
            },
            signal: AbortSignal.timeout(timeout)
          }
          response = await fetch(url, fetchOpts)
        }

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

  /**
   * Fetch a `.onion` URL via SOCKS5 using node:http (NOT undici fetch,
   * which silently drops the agent option). The SocksProxyAgent's
   * `socks5h://` scheme delegates DNS resolution to the SOCKS server (Tor),
   * so the .onion hostname is resolved inside the Tor network.
   *
   * The response is wrapped in a Web Response object so callers of fetch()
   * see the same shape regardless of clearnet vs. .onion path.
   *
   * Only HTTP (not HTTPS) is supported here — onion services typically use
   * unencrypted HTTP because the Tor circuit itself provides encryption.
   * If an .onion URL with https:// shows up we still try plain http.
   */
  private async fetchOnionViaSocks(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    if (!this.socks5Proxy) throw new Error('SOCKS5 proxy not configured')
    const { SocksProxyAgent } = await import('socks-proxy-agent')
    const http = await import('node:http')
    const https = await import('node:https')
    const agent = new SocksProxyAgent(`socks5h://${this.socks5Proxy.host}:${this.socks5Proxy.port}`)
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const lib = isHttps ? https : http

    return new Promise<Response>((resolve, reject) => {
      const req = (lib as typeof http).request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/xml, application/xml, text/html, */*',
            Host: parsed.hostname,
            ...headers
          },
          agent,
          timeout: timeoutMs,
          // Onion HTTPS services almost always use self-signed certs because
          // there's no public CA path for .onion hostnames. The Tor circuit
          // itself provides confidentiality + endpoint authentication via
          // the public-key-encoded onion address, so skipping CA validation
          // is the right default for .onion (NOT for clearnet HTTPS).
          rejectUnauthorized: false
        } as Parameters<typeof http.request>[0],
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const status = res.statusCode || 500
            const body = Buffer.concat(chunks).toString('utf-8')
            const hasBody = status !== 204 && status !== 304
            // Convert node http headers (string|string[]) to Headers-friendly shape.
            const respHeaders: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers)) {
              respHeaders[k] = Array.isArray(v) ? v.join(', ') : (v as string)
            }
            resolve(new Response(hasBody ? body : null, {
              status,
              statusText: res.statusMessage || '',
              headers: respHeaders
            }))
          })
        }
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error(`Onion fetch timed out after ${timeoutMs}ms via SOCKS5 ${this.socks5Proxy?.host}:${this.socks5Proxy?.port}`))
      })
      req.end()
    })
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
