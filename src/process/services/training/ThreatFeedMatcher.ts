// ThreatFeedMatcher — runtime cross-reference of IOCs against threat_feeds.
//
// Use case: during DeepResearchAgent synthesis we extract IOCs from findings,
// then call match()/matchBatch() to enrich them with known-bad context from
// MITRE ATT&CK + MISP feeds. The matched annotations are appended to the
// findings before LLM synthesis so the analyst sees:
//
//   "1.2.3.4  →  matched in MISP CIRCL-OSINT feed (high severity).
//                Tagged: 'malware-c2', 'apt'."
//   "LockBit  →  matched MITRE ATT&CK intrusion-set (G0118)."
//
// The DarkWebEnrichmentService also calls into this to bump severity when
// dark-web finds match known-bad indicators.

import { getDatabase } from '../database'
import log from 'electron-log'

export type IndicatorType =
  | 'ip'
  | 'domain'
  | 'url'
  | 'hash'
  | 'email'
  | 'btc'
  | 'xmr'
  | 'cve'
  | 'actor'
  | 'malware'
  | 'tool'
  | 'ttp'

export interface ThreatFeedMatch {
  type: IndicatorType
  value: string
  feedSource: string
  context: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  tags: string[]
  stixId: string | null
  mispEventId: string | null
  firstSeen: number | null
  lastSeen: number | null
}

interface DbRow {
  feed_source: string
  context: string | null
  severity: string | null
  tags: string | null
  stix_id: string | null
  misp_event_id: string | null
  first_seen: number | null
  last_seen: number | null
}

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

export class ThreatFeedMatcher {
  /**
   * Look up a single indicator. Returns the strongest match (highest
   * severity) if multiple feeds reference the same indicator.
   */
  match(type: IndicatorType, value: string): ThreatFeedMatch | null {
    const norm = this.normalize(type, value)
    if (!norm) return null

    let rows: DbRow[]
    try {
      rows = getDatabase().prepare(`
        SELECT feed_source, context, severity, tags, stix_id, misp_event_id,
               first_seen, last_seen
        FROM threat_feeds
        WHERE indicator_type = ? AND indicator_value = ?
      `).all(type, norm) as DbRow[]
    } catch (err) {
      log.debug(`ThreatFeedMatcher query failed: ${err}`)
      return null
    }

    if (rows.length === 0) return null

    // Pick highest-severity row.
    rows.sort((a, b) => (SEV_RANK[b.severity || 'low'] || 0) - (SEV_RANK[a.severity || 'low'] || 0))
    const r = rows[0]
    return {
      type,
      value: norm,
      feedSource: r.feed_source,
      context: r.context || '',
      severity: (r.severity as ThreatFeedMatch['severity']) || 'low',
      tags: r.tags ? this.parseTags(r.tags) : [],
      stixId: r.stix_id,
      mispEventId: r.misp_event_id,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen
    }
  }

  /** Batch lookup. Returns only matches (no entry for misses). */
  matchBatch(indicators: Array<{ type: IndicatorType; value: string }>): ThreatFeedMatch[] {
    const matches: ThreatFeedMatch[] = []
    for (const ind of indicators) {
      const m = this.match(ind.type, ind.value)
      if (m) matches.push(m)
    }
    return matches
  }

  /**
   * Extract IOCs from arbitrary text and look each one up. Useful for
   * scanning a finding/blob for known-bad references in one call.
   */
  scanText(text: string, opts: { caseSensitiveActors?: boolean } = {}): ThreatFeedMatch[] {
    const indicators: Array<{ type: IndicatorType; value: string }> = []

    // IP v4 (rough — matcher will validate vs threat feeds)
    const ipMatches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []
    for (const ip of new Set(ipMatches)) indicators.push({ type: 'ip', value: ip })

    // CVE
    const cves = text.match(/CVE-\d{4}-\d{4,7}/gi) || []
    for (const c of new Set(cves)) indicators.push({ type: 'cve', value: c.toUpperCase() })

    // SHA256 (64 hex)
    const sha256 = text.match(/\b[a-f0-9]{64}\b/gi) || []
    for (const h of new Set(sha256)) indicators.push({ type: 'hash', value: h.toLowerCase() })

    // SHA1 (40 hex)
    const sha1 = text.match(/\b[a-f0-9]{40}\b/gi) || []
    for (const h of new Set(sha1)) indicators.push({ type: 'hash', value: h.toLowerCase() })

    // MD5 (32 hex)
    const md5 = text.match(/\b[a-f0-9]{32}\b/gi) || []
    for (const h of new Set(md5)) indicators.push({ type: 'hash', value: h.toLowerCase() })

    // BTC (basic P2PKH/P2SH/Bech32)
    const btc = text.match(/\b(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g) || []
    for (const b of new Set(btc)) indicators.push({ type: 'btc', value: b })

    // Domain (cheap heuristic — full validation deferred to feed)
    const domains = text.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})\b/gi) || []
    const skipDomains = new Set(['e.g.', 'i.e.', 'github.com', 'wikipedia.org'])
    for (const d of new Set(domains.map((x) => x.toLowerCase()))) {
      if (!skipDomains.has(d) && d.length < 256) indicators.push({ type: 'domain', value: d })
    }

    // Threat-actor names — match against known actor feed entries by
    // case-insensitive substring search rather than exact full-text scan.
    const actorRows = (() => {
      try {
        return getDatabase().prepare(
          `SELECT indicator_value FROM threat_feeds WHERE indicator_type = 'actor'`
        ).all() as Array<{ indicator_value: string }>
      } catch { return [] }
    })()
    const haystack = opts.caseSensitiveActors ? text : text.toLowerCase()
    for (const row of actorRows) {
      const needle = opts.caseSensitiveActors ? row.indicator_value : row.indicator_value.toLowerCase()
      if (needle.length >= 3 && haystack.includes(needle)) {
        indicators.push({ type: 'actor', value: row.indicator_value })
      }
    }

    // Same trick for malware
    const malwareRows = (() => {
      try {
        return getDatabase().prepare(
          `SELECT indicator_value FROM threat_feeds WHERE indicator_type = 'malware'`
        ).all() as Array<{ indicator_value: string }>
      } catch { return [] }
    })()
    for (const row of malwareRows) {
      const needle = row.indicator_value.toLowerCase()
      if (needle.length >= 4 && haystack.includes(needle)) {
        indicators.push({ type: 'malware', value: row.indicator_value })
      }
    }

    return this.matchBatch(indicators)
  }

  /**
   * Build a markdown-formatted annotation block for inclusion in findings.
   * Returns empty string when there are no matches.
   */
  formatAnnotations(matches: ThreatFeedMatch[]): string {
    if (matches.length === 0) return ''
    const lines = matches.slice(0, 30).map((m) => {
      const tagStr = m.tags.length > 0 ? ` [tags: ${m.tags.slice(0, 3).join(', ')}]` : ''
      const severityIcon = m.severity === 'critical' ? '🔴' : m.severity === 'high' ? '🟠' : m.severity === 'medium' ? '🟡' : '⚪'
      return `${severityIcon} **${m.type.toUpperCase()}** \`${m.value}\` — matched ${m.feedSource} (${m.severity})${tagStr}`
    })
    const more = matches.length > 30 ? `\n_(+${matches.length - 30} more matches)_` : ''
    return `\n\n**[THREAT FEED MATCHES — ${matches.length}]**\n${lines.join('\n')}${more}`
  }

  // ----- helpers -----------------------------------------------------------

  private normalize(type: IndicatorType, value: string): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (trimmed.length === 0) return null

    switch (type) {
      case 'cve':    return trimmed.toUpperCase()
      case 'hash':   return trimmed.toLowerCase()
      case 'domain': return trimmed.toLowerCase()
      case 'email':  return trimmed.toLowerCase()
      case 'url':    return trimmed
      default:       return trimmed
    }
  }

  private parseTags(raw: string): string[] {
    try { return JSON.parse(raw) }
    catch { return raw.split(',').map((s) => s.trim()).filter(Boolean) }
  }

  /** Quick tally for the UI / status pages. */
  getStats(): {
    total: number
    bySource: Record<string, number>
    byType: Record<string, number>
    bySeverity: Record<string, number>
  } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM threat_feeds`).get() as { n: number }).n

    const bySource: Record<string, number> = {}
    for (const r of db.prepare(`SELECT feed_source AS s, COUNT(*) AS n FROM threat_feeds GROUP BY feed_source`).all() as Array<{ s: string; n: number }>) {
      bySource[r.s] = r.n
    }

    const byType: Record<string, number> = {}
    for (const r of db.prepare(`SELECT indicator_type AS t, COUNT(*) AS n FROM threat_feeds GROUP BY indicator_type`).all() as Array<{ t: string; n: number }>) {
      byType[r.t] = r.n
    }

    const bySeverity: Record<string, number> = {}
    for (const r of db.prepare(`SELECT severity AS s, COUNT(*) AS n FROM threat_feeds GROUP BY severity`).all() as Array<{ s: string; n: number }>) {
      bySeverity[r.s || 'unknown'] = r.n
    }

    return { total, bySource, byType, bySeverity }
  }
}

export const threatFeedMatcher = new ThreatFeedMatcher()
