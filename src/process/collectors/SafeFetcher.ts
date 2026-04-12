import log from 'electron-log'
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

  async fetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const { headers = {}, timeout = 30000, maxRetries = 3 } = options
    const domain = new URL(url).hostname

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

        const response = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/xml, application/xml, text/html, */*',
            ...headers
          },
          signal: AbortSignal.timeout(timeout)
        })

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
}

// Shared instance
export const safeFetcher = new SafeFetcher()
