import log from 'electron-log'

interface RobotsEntry {
  rules: Array<{ type: 'allow' | 'disallow'; path: string }>
  fetchedAt: number
}

const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

export class RobotsChecker {
  private cache = new Map<string, RobotsEntry>()
  private enabled: boolean = true
  private userAgent = 'Heimdall'

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  async isAllowed(url: string): Promise<boolean> {
    if (!this.enabled) return true

    try {
      const parsed = new URL(url)
      const domain = parsed.origin
      const path = parsed.pathname

      const entry = await this.getEntry(domain)
      if (!entry) return true

      // Check rules in order — first match wins
      for (const rule of entry.rules) {
        if (path.startsWith(rule.path)) {
          return rule.type === 'allow'
        }
      }

      return true // Default allow if no matching rule
    } catch {
      return true // Allow on parse error
    }
  }

  private async getEntry(origin: string): Promise<RobotsEntry | null> {
    const cached = this.cache.get(origin)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached
    }

    try {
      const response = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        // No robots.txt = everything allowed
        return null
      }

      const text = await response.text()
      const entry = this.parse(text)
      this.cache.set(origin, entry)
      return entry
    } catch (err) {
      log.debug(`Failed to fetch robots.txt for ${origin}: ${err}`)
      return null
    }
  }

  /** Evict expired entries and cap at 200 */
  prune(): void {
    const now = Date.now()
    // Remove expired
    for (const [domain, entry] of this.cache) {
      if (now - entry.fetchedAt > CACHE_TTL) {
        this.cache.delete(domain)
      }
    }
    // Cap at 200 — evict oldest
    if (this.cache.size > 200) {
      const sorted = [...this.cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
      const toRemove = sorted.slice(0, this.cache.size - 200)
      for (const [domain] of toRemove) {
        this.cache.delete(domain)
      }
    }
  }

  private parse(text: string): RobotsEntry {
    const rules: RobotsEntry['rules'] = []
    let relevantSection = false
    let foundWildcard = false

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue

      const [directive, ...valueParts] = line.split(':')
      const key = directive.trim().toLowerCase()
      const value = valueParts.join(':').trim()

      if (key === 'user-agent') {
        const ua = value.toLowerCase()
        if (ua === '*') {
          relevantSection = true
          foundWildcard = true
        } else if (ua === this.userAgent.toLowerCase()) {
          relevantSection = true
          foundWildcard = false // Specific match overrides wildcard
        } else {
          // Only stop if we had a wildcard and now hit a different specific UA
          if (relevantSection && !foundWildcard) continue
          relevantSection = false
        }
        continue
      }

      if (!relevantSection) continue

      if (key === 'disallow' && value) {
        rules.push({ type: 'disallow', path: value })
      } else if (key === 'allow' && value) {
        rules.push({ type: 'allow', path: value })
      }
    }

    return { rules, fetchedAt: Date.now() }
  }
}
