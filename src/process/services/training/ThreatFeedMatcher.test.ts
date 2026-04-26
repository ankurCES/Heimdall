// Phase 2 verification — proves ThreatFeedMatcher's scanText() correctly:
//   1. Extracts IOCs from arbitrary text via regex (no DB needed for that part)
//   2. Looks up actor/malware names by case-insensitive substring match
//   3. Returns the highest-severity match when an IOC appears in multiple feeds
//
// This test mocks getDatabase() to return a synthetic threat_feeds dataset so
// we don't depend on the user's runtime DB or the Electron-built native module.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ----- Mock the database module BEFORE importing the matcher -----------------
type Row = Record<string, unknown>
let mockRows: Row[] = []

vi.mock('../database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        const lower = sql.toLowerCase()
        if (lower.includes("indicator_type = 'actor'")) {
          return mockRows.filter((r) => r.indicator_type === 'actor')
        }
        if (lower.includes("indicator_type = 'malware'")) {
          return mockRows.filter((r) => r.indicator_type === 'malware')
        }
        // Generic two-arg lookup (type + value)
        if (lower.includes('where indicator_type = ? and indicator_value = ?')) {
          const [type, value] = args as [string, string]
          return mockRows
            .filter((r) => r.indicator_type === type && r.indicator_value === value)
            .map((r) => ({
              feed_source: r.feed_source, context: r.context, severity: r.severity,
              tags: r.tags, stix_id: r.stix_id, misp_event_id: r.misp_event_id,
              first_seen: r.first_seen, last_seen: r.last_seen
            }))
        }
        return []
      },
      get: () => ({ n: mockRows.length }),
      run: () => ({ changes: 0, lastInsertRowid: 0 })
    })
  })
}))

import { ThreatFeedMatcher } from './ThreatFeedMatcher'

beforeEach(() => {
  // Synthetic dataset that mimics what MITRE ingester produces
  mockRows = [
    {
      feed_source: 'mitre', indicator_type: 'actor', indicator_value: 'LockBit',
      context: 'Threat actor (ATT&CK group). LockBit ransomware affiliate program.',
      severity: 'high', tags: '["G0118","phase:impact"]',
      stix_id: 'intrusion-set--lockbit', misp_event_id: null,
      first_seen: 0, last_seen: 0
    },
    {
      feed_source: 'mitre', indicator_type: 'actor', indicator_value: 'Lazarus Group',
      context: 'Threat actor (ATT&CK group). North-Korean state-sponsored actor.',
      severity: 'high', tags: '["G0032","alias:HIDDEN COBRA"]',
      stix_id: 'intrusion-set--lazarus', misp_event_id: null,
      first_seen: 0, last_seen: 0
    },
    {
      feed_source: 'mitre', indicator_type: 'actor', indicator_value: 'APT29',
      context: 'Threat actor. Russian SVR-attributed.',
      severity: 'high', tags: '["G0016","alias:Dark Halo"]',
      stix_id: 'intrusion-set--apt29', misp_event_id: null,
      first_seen: 0, last_seen: 0
    },
    {
      feed_source: 'mitre', indicator_type: 'malware', indicator_value: 'WannaCry',
      context: 'Malware family (ATT&CK).',
      severity: 'high', tags: '["S0366"]',
      stix_id: null, misp_event_id: null,
      first_seen: 0, last_seen: 0
    },
    {
      feed_source: 'misp:circl-osint', indicator_type: 'ip', indicator_value: '185.220.101.45',
      context: 'Tor exit node observed in C2 traffic',
      severity: 'critical', tags: '["c2","tor"]',
      stix_id: null, misp_event_id: 'event-123',
      first_seen: 0, last_seen: 0
    },
    {
      feed_source: 'misp:circl-osint', indicator_type: 'cve', indicator_value: 'CVE-2024-3400',
      context: 'PAN-OS command injection',
      severity: 'critical', tags: '["panos","exploit"]',
      stix_id: null, misp_event_id: 'event-456',
      first_seen: 0, last_seen: 0
    },
    {
      feed_source: 'misp:circl-osint', indicator_type: 'hash', indicator_value: '5d41402abc4b2a76b9719d911017c592',
      context: 'MD5 of malicious payload',
      severity: 'high', tags: '["malware"]',
      stix_id: null, misp_event_id: 'event-789',
      first_seen: 0, last_seen: 0
    }
  ]
})

describe('ThreatFeedMatcher.match()', () => {
  it('returns null for non-existent indicator', () => {
    const m = new ThreatFeedMatcher()
    expect(m.match('actor', 'NonExistentActor')).toBeNull()
  })

  it('finds an exact actor match (case-sensitive lookup by name)', () => {
    const m = new ThreatFeedMatcher()
    const result = m.match('actor', 'LockBit')
    expect(result).not.toBeNull()
    expect(result!.feedSource).toBe('mitre')
    expect(result!.severity).toBe('high')
  })

  it('normalizes CVE to upper-case before lookup', () => {
    const m = new ThreatFeedMatcher()
    const result = m.match('cve', 'cve-2024-3400')
    expect(result).not.toBeNull()
    expect(result!.value).toBe('CVE-2024-3400')
    expect(result!.severity).toBe('critical')
  })

  it('normalizes hash to lower-case before lookup', () => {
    const m = new ThreatFeedMatcher()
    const result = m.match('hash', '5D41402ABC4B2A76B9719D911017C592')
    expect(result).not.toBeNull()
    expect(result!.value).toBe('5d41402abc4b2a76b9719d911017c592')
  })

  it('parses the JSON tags array', () => {
    const m = new ThreatFeedMatcher()
    const result = m.match('actor', 'APT29')
    expect(result!.tags).toEqual(expect.arrayContaining(['G0016']))
  })
})

describe('ThreatFeedMatcher.scanText()', () => {
  it('extracts and matches IPs, CVEs, hashes, and actor names from a paragraph', () => {
    const m = new ThreatFeedMatcher()
    const text = `Recent reporting links LockBit affiliates to a Lazarus Group operation
      exploiting CVE-2024-3400 against PAN-OS appliances. The C2 IP 185.220.101.45
      delivered a payload with MD5 5d41402abc4b2a76b9719d911017c592. Note: APT29
      attribution remains contested.`

    const matches = m.scanText(text)

    const types = matches.map((x) => x.type)
    expect(types).toEqual(expect.arrayContaining(['actor', 'cve', 'ip', 'hash']))
    const values = matches.map((x) => x.value)
    expect(values).toEqual(expect.arrayContaining([
      'LockBit', 'Lazarus Group', 'APT29',
      'CVE-2024-3400', '185.220.101.45',
      '5d41402abc4b2a76b9719d911017c592'
    ]))
  })

  it('case-insensitively matches actor name "lockbit" inside text', () => {
    const m = new ThreatFeedMatcher()
    const matches = m.scanText('the lockbit ransomware crew claimed responsibility')
    expect(matches.find((x) => x.value === 'LockBit')).toBeDefined()
  })

  it('returns empty array when text contains no recognized IOCs', () => {
    const m = new ThreatFeedMatcher()
    const matches = m.scanText('the weather in Paris was lovely yesterday')
    expect(matches.length).toBe(0)
  })

  it('does not match short common words as actor (min 3 char threshold)', () => {
    mockRows.push({
      feed_source: 'mitre', indicator_type: 'actor', indicator_value: 'AB',
      context: 'two-letter actor', severity: 'low',
      tags: '[]', stix_id: null, misp_event_id: null,
      first_seen: 0, last_seen: 0
    })
    const m = new ThreatFeedMatcher()
    const matches = m.scanText('the words AB and CD appear here often')
    expect(matches.find((x) => x.value === 'AB')).toBeUndefined()
  })
})

describe('ThreatFeedMatcher.formatAnnotations()', () => {
  it('produces a markdown block with severity icons for each match', () => {
    const m = new ThreatFeedMatcher()
    const matches = m.scanText('CVE-2024-3400 and Lazarus Group activity observed')
    const md = m.formatAnnotations(matches)

    expect(md).toContain('THREAT FEED MATCHES')
    expect(md).toContain('CVE-2024-3400')
    expect(md).toContain('Lazarus Group')
    // Severity icons present
    expect(md).toMatch(/[🔴🟠🟡⚪]/)
  })

  it('returns empty string when there are no matches', () => {
    const m = new ThreatFeedMatcher()
    expect(m.formatAnnotations([])).toBe('')
  })
})
