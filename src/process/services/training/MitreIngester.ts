// MITRE ATT&CK STIX ingester. Pulls the official enterprise-attack STIX
// bundle from the public MITRE GitHub repo and projects it into Heimdall's
// threat_feeds table.
//
// What we extract:
//   - intrusion-set objects   → indicator_type='actor',  value=group name
//   - malware objects         → indicator_type='malware', value=family name
//   - tool objects            → indicator_type='tool',    value=tool name
//   - attack-pattern objects  → indicator_type='ttp',     value=technique ID (Txxxx)
//
// Each row carries:
//   - stix_id (the STIX UUID — used for idempotent upserts)
//   - context (description + ATT&CK technique IDs related to this object)
//   - tags (kill_chain_phases joined)
//
// Refresh cadence: weekly (Mondays 5am via cron). Source repo updates roughly
// every 6 months; weekly is overkill but cheap (~3MB JSON).

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import { safeFetcher } from '../../collectors/SafeFetcher'
import log from 'electron-log'

const ATTACK_BUNDLE_URL =
  'https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json'

interface StixObject {
  type: string
  id: string
  name?: string
  description?: string
  external_references?: Array<{ source_name?: string; external_id?: string; url?: string }>
  kill_chain_phases?: Array<{ kill_chain_name: string; phase_name: string }>
  aliases?: string[]
  x_mitre_aliases?: string[]
  x_mitre_deprecated?: boolean
  revoked?: boolean
  modified?: string
  created?: string
}

interface StixBundle {
  type: string
  id: string
  objects: StixObject[]
}

export interface MitreIngestStats {
  totalObjects: number
  inserted: number
  updated: number
  skipped: number
  byType: Record<string, number>
  durationMs: number
  lastRunAt: number
}

/**
 * Pulls the latest enterprise ATT&CK bundle and writes its actor / malware /
 * tool / TTP objects into the threat_feeds table. Idempotent — uses the
 * (feed_source, indicator_type, indicator_value) UNIQUE constraint.
 */
export class MitreIngester {
  async run(): Promise<MitreIngestStats> {
    const start = Date.now()
    log.info('mitre.ingest: fetching enterprise ATT&CK STIX bundle…')
    const stats: MitreIngestStats = {
      totalObjects: 0, inserted: 0, updated: 0, skipped: 0,
      byType: {}, durationMs: 0, lastRunAt: start
    }

    let bundle: StixBundle
    try {
      const text = await safeFetcher.fetchText(ATTACK_BUNDLE_URL, {
        timeout: 60_000,
        skipRobots: true
      })
      bundle = JSON.parse(text) as StixBundle
    } catch (err) {
      log.error(`mitre.ingest: download failed: ${err}`)
      throw err
    }

    if (!Array.isArray(bundle.objects)) {
      throw new Error('mitre.ingest: STIX bundle missing objects array')
    }

    stats.totalObjects = bundle.objects.length
    log.info(`mitre.ingest: bundle has ${stats.totalObjects} objects`)

    const db = getDatabase()
    const upsert = db.prepare(`
      INSERT INTO threat_feeds (id, feed_source, indicator_type, indicator_value, context, severity, first_seen, last_seen, tags, stix_id, created_at)
      VALUES (?, 'mitre', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_source, indicator_type, indicator_value) DO UPDATE SET
        context=excluded.context, last_seen=excluded.last_seen,
        tags=excluded.tags, stix_id=excluded.stix_id
    `)

    const tx = db.transaction((objects: StixObject[]) => {
      for (const obj of objects) {
        if (obj.revoked || obj.x_mitre_deprecated) { stats.skipped++; continue }
        const mapped = this.mapStixObject(obj)
        if (!mapped) { stats.skipped++; continue }

        const created = obj.created ? Date.parse(obj.created) : Date.now()
        const modified = obj.modified ? Date.parse(obj.modified) : Date.now()
        try {
          upsert.run(
            generateId(),
            mapped.type,
            mapped.value,
            mapped.context,
            mapped.severity,
            created,
            modified,
            mapped.tags,
            obj.id,
            Date.now()
          )
          stats.inserted++
          stats.byType[mapped.type] = (stats.byType[mapped.type] || 0) + 1
        } catch (err) {
          log.debug(`mitre.ingest upsert failed for ${obj.id}: ${err}`)
          stats.skipped++
        }
      }
    })

    tx(bundle.objects)
    stats.durationMs = Date.now() - start

    log.info(
      `mitre.ingest: complete — ${stats.inserted} inserted (${Object.entries(stats.byType)
        .map(([t, n]) => `${t}=${n}`)
        .join(', ')}), ${stats.skipped} skipped in ${stats.durationMs}ms`
    )
    return stats
  }

  private mapStixObject(obj: StixObject): {
    type: 'actor' | 'malware' | 'tool' | 'ttp'
    value: string
    context: string
    severity: 'critical' | 'high' | 'medium' | 'low'
    tags: string
  } | null {
    if (!obj.name) return null

    const techniqueId = obj.external_references
      ?.find((r) => r.source_name === 'mitre-attack')?.external_id ?? null
    const tags: string[] = []
    if (techniqueId) tags.push(techniqueId)
    if (obj.kill_chain_phases) {
      for (const p of obj.kill_chain_phases) tags.push(`phase:${p.phase_name}`)
    }

    const aliases = obj.aliases || obj.x_mitre_aliases || []
    if (aliases.length > 0) tags.push(...aliases.slice(0, 5).map((a) => `alias:${a}`))

    const description = (obj.description || '').slice(0, 1500)

    switch (obj.type) {
      case 'intrusion-set':
        return {
          type: 'actor',
          value: obj.name,
          context: `Threat actor (ATT&CK group). ${description}`,
          severity: 'high',
          tags: JSON.stringify(tags)
        }
      case 'malware':
        return {
          type: 'malware',
          value: obj.name,
          context: `Malware family (ATT&CK). ${description}`,
          severity: 'high',
          tags: JSON.stringify(tags)
        }
      case 'tool':
        return {
          type: 'tool',
          value: obj.name,
          context: `Adversary tool (ATT&CK). ${description}`,
          severity: 'medium',
          tags: JSON.stringify(tags)
        }
      case 'attack-pattern':
        return techniqueId ? {
          type: 'ttp',
          value: techniqueId,
          context: `${obj.name} — ATT&CK technique. ${description}`,
          severity: 'medium',
          tags: JSON.stringify(tags)
        } : null
      default:
        return null
    }
  }

  /** Quick stats query for the UI / settings page. */
  getStatus(): { count: number; byType: Record<string, number>; lastSync: number | null } {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT indicator_type AS type, COUNT(*) AS n, MAX(last_seen) AS last
      FROM threat_feeds WHERE feed_source = 'mitre'
      GROUP BY indicator_type
    `).all() as Array<{ type: string; n: number; last: number }>

    const byType: Record<string, number> = {}
    let total = 0
    let lastSync: number | null = null
    for (const r of rows) {
      byType[r.type] = r.n
      total += r.n
      if (r.last && (!lastSync || r.last > lastSync)) lastSync = r.last
    }
    return { count: total, byType, lastSync }
  }
}

export const mitreIngester = new MitreIngester()
