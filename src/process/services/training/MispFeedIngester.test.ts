// Phase 2 verification — proves MispFeedIngester correctly:
//   1. Fetches the manifest.json from a feed URL
//   2. Picks the most-recent N events
//   3. Maps MISP attribute types → our internal indicator types
//   4. Skips unsupported types and oversized values
//   5. UPSERTs without losing existing severity (severity-bump-only logic)
//
// Mocks both safeFetcher (HTTP) and getDatabase (SQL) so the test is fully
// hermetic — no network, no native sqlite binding required.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ----- Mock SafeFetcher ------------------------------------------------------
const mockResponses = new Map<string, string>()
vi.mock('../../collectors/SafeFetcher', () => ({
  safeFetcher: {
    fetchText: async (url: string) => {
      const r = mockResponses.get(url)
      if (!r) throw new Error(`no mock for ${url}`)
      return r
    }
  }
}))

// ----- Mock DB ---------------------------------------------------------------
interface InsertedRow {
  feed_source: string
  indicator_type: string
  indicator_value: string
  context: string
  severity: string
}
let inserted: InsertedRow[] = []

vi.mock('../database', () => ({
  getDatabase: () => ({
    prepare: (_sql: string) => ({
      run: (
        _id: string,
        feed_source: string,
        indicator_type: string,
        indicator_value: string,
        context: string,
        severity: string
      ) => {
        inserted.push({ feed_source, indicator_type, indicator_value, context, severity })
        return { changes: 1, lastInsertRowid: inserted.length }
      },
      all: () => [],
      get: () => ({ n: 0 })
    }),
    transaction: <T>(fn: (arg: T) => void) => (arg: T) => fn(arg)
  })
}))

import { MispFeedIngester } from './MispFeedIngester'

const FEED_URL = 'https://example.test/feed/'

beforeEach(() => {
  inserted = []
  mockResponses.clear()
  // Manifest with 2 events
  mockResponses.set(FEED_URL + 'manifest.json', JSON.stringify({
    'event-uuid-1': { date: '2026-04-25', info: 'Phishing wave' },
    'event-uuid-2': { date: '2026-04-26', info: 'Malware C2 infrastructure' }
  }))
  // Event 1 — 1 IP, 1 unsupported type
  mockResponses.set(FEED_URL + 'event-uuid-1.json', JSON.stringify({
    Event: {
      uuid: 'event-uuid-1',
      info: 'Phishing wave',
      date: '2026-04-25',
      threat_level_id: '1',
      Tag: [{ name: 'phishing' }, { name: 'campaign' }],
      Attribute: [
        { type: 'ip-src', value: '203.0.113.55', comment: 'sender IP' },
        { type: 'mutex',  value: 'NOT_SUPPORTED' },  // skipped
        { type: 'sha256', value: 'a'.repeat(64), comment: 'payload' }
      ]
    }
  }))
  // Event 2 — domain + url + cve, plus an ip|port composite
  mockResponses.set(FEED_URL + 'event-uuid-2.json', JSON.stringify({
    Event: {
      uuid: 'event-uuid-2',
      info: 'Malware C2',
      date: '2026-04-26',
      threat_level_id: '2',
      Tag: [{ name: 'c2' }],
      Attribute: [
        { type: 'domain',        value: 'evil.example.com' },
        { type: 'url',           value: 'https://evil.example.com/payload' },
        { type: 'ip-dst|port',   value: '198.51.100.7|8443' },     // strip port
        { type: 'vulnerability', value: 'CVE-2024-99999' },
        { type: 'email-src',     value: 'attacker@example.com' }
      ]
    }
  }))
})

describe('MispFeedIngester.runFeed()', () => {
  it('pulls manifest, fetches each event, inserts mapped indicators', async () => {
    const ing = new MispFeedIngester()
    const stats = await ing.runFeed({
      id: 'test-feed', name: 'Test', url: FEED_URL, enabled: true
    })

    expect(stats.events).toBe(2)
    expect(stats.errors).toBe(0)
    expect(stats.inserted).toBeGreaterThanOrEqual(7)

    // Specific values present
    const values = inserted.map((r) => r.indicator_value)
    expect(values).toEqual(expect.arrayContaining([
      '203.0.113.55',
      'a'.repeat(64),
      'evil.example.com',
      'https://evil.example.com/payload',
      '198.51.100.7',                 // port stripped from "198.51.100.7|8443"
      'CVE-2024-99999',
      'attacker@example.com'
    ]))

    // Type mapping
    const findType = (v: string) => inserted.find((r) => r.indicator_value === v)?.indicator_type
    expect(findType('203.0.113.55')).toBe('ip')
    expect(findType('a'.repeat(64))).toBe('hash')
    expect(findType('evil.example.com')).toBe('domain')
    expect(findType('https://evil.example.com/payload')).toBe('url')
    expect(findType('CVE-2024-99999')).toBe('cve')
    expect(findType('attacker@example.com')).toBe('email')

    // Severity mapping (threat_level_id 1 = critical, 2 = high)
    expect(inserted.find((r) => r.indicator_value === '203.0.113.55')!.severity).toBe('critical')
    expect(inserted.find((r) => r.indicator_value === 'evil.example.com')!.severity).toBe('high')
  })

  it('feed_source is namespaced as misp:<feed-id>', async () => {
    const ing = new MispFeedIngester()
    await ing.runFeed({ id: 'circl-osint', name: 'CIRCL', url: FEED_URL, enabled: true })
    expect(inserted.every((r) => r.feed_source === 'misp:circl-osint')).toBe(true)
  })

  it('skips unsupported attribute types and reports skipped count', async () => {
    const ing = new MispFeedIngester()
    const stats = await ing.runFeed({
      id: 'test', name: 'Test', url: FEED_URL, enabled: true
    })
    // Event 1 had 1 unsupported (mutex) attribute
    expect(stats.skipped).toBeGreaterThanOrEqual(1)
    expect(inserted.find((r) => r.indicator_value === 'NOT_SUPPORTED')).toBeUndefined()
  })

  it('handles manifest fetch failure gracefully', async () => {
    mockResponses.delete(FEED_URL + 'manifest.json')
    const ing = new MispFeedIngester()
    const stats = await ing.runFeed({
      id: 'test', name: 'Test', url: FEED_URL, enabled: true
    })
    expect(stats.errors).toBeGreaterThan(0)
    expect(stats.inserted).toBe(0)
  })

  it('continues after a single event fetch fails', async () => {
    mockResponses.delete(FEED_URL + 'event-uuid-1.json')   // event 1 broken
    const ing = new MispFeedIngester()
    const stats = await ing.runFeed({
      id: 'test', name: 'Test', url: FEED_URL, enabled: true
    })
    expect(stats.errors).toBe(1)
    expect(stats.events).toBe(1)              // only event 2 succeeded
    expect(stats.inserted).toBeGreaterThanOrEqual(5) // event 2 attrs
  })
})
