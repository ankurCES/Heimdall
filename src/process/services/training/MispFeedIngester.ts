// MISP public-feeds ingester. Pulls a curated set of free, no-auth MISP-format
// JSON feeds (the "MISP Default Feeds" list) and projects each Attribute into
// Heimdall's threat_feeds table.
//
// We deliberately ship a small built-in default feed list — the user can
// extend or disable in Settings. Each feed publishes a manifest.json + per-event
// JSON files. We pull the manifest, fetch the most-recent N events, and write
// out the IP/domain/url/hash/email attributes.
//
// Different from MispService.ts (the Theme 7.7 enterprise sync): that one
// talks to a user-configured MISP server with API key. THIS one consumes the
// public feeds anyone can read without credentials.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import { safeFetcher } from '../../collectors/SafeFetcher'
import log from 'electron-log'

interface MispFeed {
  id: string
  name: string
  url: string             // base URL (manifest.json must be under it)
  enabled: boolean
}

interface MispManifestEntry {
  Orgc?: { name?: string }
  Tag?: Array<{ name: string }>
  info?: string
  date?: string
  threat_level_id?: string
  // The manifest is a {uuid: entry} map.
}

interface MispEvent {
  Event: {
    uuid: string
    info: string
    date: string
    threat_level_id?: string
    Attribute?: Array<{
      type: string
      value: string
      category?: string
      to_ids?: boolean
      comment?: string
    }>
    Tag?: Array<{ name: string }>
  }
}

// Curated default feeds — all public, no-auth. Match the MISP project's
// official default list (https://www.misp-project.org/feeds/).
export const DEFAULT_MISP_FEEDS: MispFeed[] = [
  { id: 'circl-osint',  name: 'CIRCL OSINT Feed',
    url: 'https://www.circl.lu/doc/misp/feed-osint/', enabled: true },
  { id: 'botvrij',      name: 'botvrij.eu Default',
    url: 'https://www.botvrij.eu/data/feed-osint/', enabled: true },
  { id: 'threatfox',    name: 'ThreatFox by abuse.ch (MISP feed)',
    url: 'https://threatfox.abuse.ch/export/misp/recent/', enabled: false }
]

// Map MISP attribute types → our internal indicator types
const MISP_TYPE_MAP: Record<string, string | null> = {
  'ip-src':         'ip',
  'ip-dst':         'ip',
  'ip-src|port':    'ip',
  'ip-dst|port':    'ip',
  'domain':         'domain',
  'hostname':       'domain',
  'url':            'url',
  'uri':            'url',
  'md5':            'hash',
  'sha1':           'hash',
  'sha256':         'hash',
  'sha512':         'hash',
  'email':          'email',
  'email-src':      'email',
  'email-dst':      'email',
  'btc':            'btc',
  'xmr':            'xmr',
  'vulnerability':  'cve',
  'cve':            'cve',
  // Anything else returns null → skipped
  '_default':       null
}

// Threat-level mapping (1=high, 4=undefined) → our severity bucket
function severityFromThreatLevel(tl?: string): 'critical' | 'high' | 'medium' | 'low' {
  switch (tl) {
    case '1': return 'critical'
    case '2': return 'high'
    case '3': return 'medium'
    default:  return 'low'
  }
}

export interface MispIngestStats {
  feedId: string
  events: number
  attributes: number
  inserted: number
  skipped: number
  errors: number
  durationMs: number
}

const MAX_EVENTS_PER_FEED = 30          // most-recent N
const MAX_ATTRS_PER_EVENT = 200

export class MispFeedIngester {
  /** Run all enabled built-in feeds. */
  async runAll(): Promise<MispIngestStats[]> {
    const results: MispIngestStats[] = []
    for (const feed of DEFAULT_MISP_FEEDS.filter((f) => f.enabled)) {
      try {
        const r = await this.runFeed(feed)
        results.push(r)
      } catch (err) {
        log.warn(`misp-feed.${feed.id} failed: ${err}`)
        results.push({
          feedId: feed.id, events: 0, attributes: 0, inserted: 0,
          skipped: 0, errors: 1, durationMs: 0
        })
      }
    }
    return results
  }

  async runFeed(feed: MispFeed): Promise<MispIngestStats> {
    const start = Date.now()
    const stats: MispIngestStats = {
      feedId: feed.id, events: 0, attributes: 0, inserted: 0,
      skipped: 0, errors: 0, durationMs: 0
    }

    log.info(`misp-feed.${feed.id}: fetching manifest…`)

    // 1. Pull manifest.json
    const manifestUrl = feed.url.endsWith('/') ? feed.url + 'manifest.json' : feed.url + '/manifest.json'
    let manifest: Record<string, MispManifestEntry>
    try {
      const text = await safeFetcher.fetchText(manifestUrl, {
        timeout: 30_000,
        skipRobots: true
      })
      manifest = JSON.parse(text)
    } catch (err) {
      log.warn(`misp-feed.${feed.id} manifest fetch failed: ${err}`)
      stats.errors++
      return stats
    }

    // 2. Sort by date desc, take the most-recent N
    const entries = Object.entries(manifest)
      .sort((a, b) => (b[1].date || '').localeCompare(a[1].date || ''))
      .slice(0, MAX_EVENTS_PER_FEED)

    log.info(`misp-feed.${feed.id}: manifest has ${Object.keys(manifest).length} events, processing ${entries.length}`)

    // 3. Fetch each event JSON + insert attributes
    const db = getDatabase()
    const upsert = db.prepare(`
      INSERT INTO threat_feeds (id, feed_source, indicator_type, indicator_value, context, severity, first_seen, last_seen, tags, misp_event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_source, indicator_type, indicator_value) DO UPDATE SET
        context=excluded.context, last_seen=excluded.last_seen,
        severity=CASE WHEN threat_feeds.severity='low' THEN excluded.severity ELSE threat_feeds.severity END,
        tags=excluded.tags
    `)

    for (const [uuid] of entries) {
      const eventUrl = feed.url.endsWith('/') ? `${feed.url}${uuid}.json` : `${feed.url}/${uuid}.json`
      let event: MispEvent
      try {
        const text = await safeFetcher.fetchText(eventUrl, {
          timeout: 20_000,
          skipRobots: true
        })
        event = JSON.parse(text)
      } catch (err) {
        log.debug(`misp-feed.${feed.id} event ${uuid} fetch failed: ${err}`)
        stats.errors++
        continue
      }

      stats.events++
      const attrs = event.Event.Attribute?.slice(0, MAX_ATTRS_PER_EVENT) || []
      const sev = severityFromThreatLevel(event.Event.threat_level_id)
      const tags = (event.Event.Tag || []).map((t) => t.name).slice(0, 10)
      const info = (event.Event.info || '').slice(0, 500)

      const eventDateMs = event.Event.date ? Date.parse(event.Event.date) : Date.now()

      const tx = db.transaction((rows: typeof attrs) => {
        for (const attr of rows) {
          stats.attributes++
          const ourType = MISP_TYPE_MAP[attr.type]
          if (!ourType) { stats.skipped++; continue }

          // For ip-src|port style values, strip the port suffix
          const value = attr.value.includes('|') ? attr.value.split('|')[0] : attr.value
          if (!value || value.length > 500) { stats.skipped++; continue }

          try {
            upsert.run(
              generateId(),
              `misp:${feed.id}`,
              ourType,
              value,
              `${info} ${attr.comment || ''}`.trim().slice(0, 800),
              sev,
              eventDateMs,
              Date.now(),
              JSON.stringify(tags),
              event.Event.uuid,
              Date.now()
            )
            stats.inserted++
          } catch (err) {
            log.debug(`misp-feed.${feed.id} insert failed for ${value}: ${err}`)
            stats.skipped++
          }
        }
      })
      tx(attrs)
    }

    stats.durationMs = Date.now() - start
    log.info(`misp-feed.${feed.id}: ${stats.inserted} indicators from ${stats.events} events in ${stats.durationMs}ms (${stats.errors} errors, ${stats.skipped} skipped)`)
    return stats
  }

  getStatus(): {
    feeds: Array<{ id: string; name: string; enabled: boolean; count: number; lastSync: number | null }>
    totalIndicators: number
  } {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT feed_source AS source, COUNT(*) AS n, MAX(last_seen) AS last
      FROM threat_feeds WHERE feed_source LIKE 'misp:%'
      GROUP BY feed_source
    `).all() as Array<{ source: string; n: number; last: number }>

    const byFeed = new Map<string, { n: number; last: number }>()
    for (const r of rows) {
      const id = r.source.replace(/^misp:/, '')
      byFeed.set(id, { n: r.n, last: r.last })
    }

    let total = 0
    const feeds = DEFAULT_MISP_FEEDS.map((f) => {
      const stats = byFeed.get(f.id)
      total += stats?.n ?? 0
      return {
        id: f.id, name: f.name, enabled: f.enabled,
        count: stats?.n ?? 0,
        lastSync: stats?.last ?? null
      }
    })
    return { feeds, totalIndicators: total }
  }
}

export const mispFeedIngester = new MispFeedIngester()
