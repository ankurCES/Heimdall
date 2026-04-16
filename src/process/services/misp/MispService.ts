import crypto from 'crypto'
import log from 'electron-log'
import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 7.7 — MISP bidirectional sync.
 *
 * MISP is the canonical open-source threat-intel platform. REST API is
 * stable and well-documented. This service supports:
 *
 *  Export (push) — Heimdall intel_reports → MISP event with per-entity
 *                  attributes (ip-src/hash-sha256/url/email-src/vulnerability).
 *                  Respects bundle_since window.
 *  Import (pull) — fetch MISP events updated since lastSync, create
 *                  intel_reports + intel_entities with stix_id-style
 *                  misp_uuid dedup.
 *
 * Settings (settings store under 'misp'):
 *   {
 *     url: 'https://misp.example.com',
 *     api_key: '...',
 *     verify_tls: true,
 *     default_distribution: 0,
 *     default_threat_level: 4,
 *     default_analysis: 0
 *   }
 */

interface MispConfig {
  url?: string
  api_key?: string
  verify_tls?: boolean
  default_distribution?: number
  default_threat_level?: number
  default_analysis?: number
}

const ENTITY_TO_MISP: Record<string, string> = {
  ip: 'ip-src',
  hash: 'sha256',
  url: 'url',
  email: 'email-src',
  cve: 'vulnerability',
  domain: 'domain',
  malware: 'malware-type',
  threat_actor: 'threat-actor'
}
const MISP_TO_ENTITY: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITY_TO_MISP).map(([k, v]) => [v, k])
)
// Also common MISP attribute types that map to our entity types.
MISP_TO_ENTITY['ip-dst'] = 'ip'
MISP_TO_ENTITY['md5'] = 'hash'
MISP_TO_ENTITY['sha1'] = 'hash'
MISP_TO_ENTITY['email-dst'] = 'email'

function headers(cfg: MispConfig): Record<string, string> {
  if (!cfg.api_key) throw new Error('MISP api_key not configured')
  return {
    'Authorization': cfg.api_key,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Heimdall-MISP-Sync'
  }
}

async function mispFetch(cfg: MispConfig, path: string, init?: RequestInit): Promise<unknown> {
  if (!cfg.url) throw new Error('MISP url not configured')
  const url = `${cfg.url.replace(/\/$/, '')}${path}`
  const res = await fetch(url, { ...init, headers: { ...headers(cfg), ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`MISP ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

export interface MispRun {
  id: number
  direction: 'push' | 'pull'
  started_at: number
  finished_at: number
  events_in: number | null
  events_out: number | null
  attributes_in: number | null
  attributes_out: number | null
  endpoint: string | null
  summary: string | null
  duration_ms: number
}

export class MispService {
  private config(): MispConfig {
    return (settingsService.get<MispConfig>('misp') ?? {}) as MispConfig
  }

  configured(): boolean {
    const c = this.config()
    return !!(c.url && c.api_key)
  }

  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const cfg = this.config()
      const info = await mispFetch(cfg, '/servers/getVersion.json') as { version?: string }
      return { ok: true, version: info.version }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async push(opts: { since_ms?: number; discipline?: string | null } = {}): Promise<MispRun> {
    const db = getDatabase()
    const cfg = this.config()
    const started = Date.now()
    const runId = Number(db.prepare(
      "INSERT INTO misp_runs (direction, started_at, endpoint) VALUES ('push', ?, ?)"
    ).run(started, cfg.url ?? null).lastInsertRowid)

    try {
      const since = opts.since_ms ?? (started - 7 * 24 * 60 * 60 * 1000)
      const reports = db.prepare(`
        SELECT id, title, content, discipline, created_at
        FROM intel_reports
        WHERE created_at >= ? ${opts.discipline ? 'AND discipline = ?' : ''}
          AND (quarantined IS NULL OR quarantined = 0)
        ORDER BY created_at DESC LIMIT 200
      `).all(...(opts.discipline ? [since, opts.discipline] : [since])) as Array<{ id: string; title: string; content: string; discipline: string; created_at: number }>

      let eventsOut = 0, attrsOut = 0
      for (const r of reports) {
        // Attributes from entities.
        const entities = db.prepare(
          'SELECT entity_type, entity_value FROM intel_entities WHERE report_id = ?'
        ).all(r.id) as Array<{ entity_type: string; entity_value: string }>
        const attributes = entities
          .map((e) => ({ mispType: ENTITY_TO_MISP[e.entity_type], value: e.entity_value }))
          .filter((a) => !!a.mispType)
          .map((a) => ({
            type: a.mispType,
            value: a.value,
            category: a.mispType.startsWith('ip') || a.mispType === 'url' || a.mispType === 'sha256' || a.mispType === 'md5' || a.mispType === 'sha1' || a.mispType === 'email-src' || a.mispType === 'email-dst' || a.mispType === 'domain'
              ? 'Network activity' : a.mispType === 'vulnerability' ? 'External analysis' : 'Other',
            to_ids: true,
            comment: 'imported from Heimdall'
          }))

        const body = {
          Event: {
            info: r.title.slice(0, 150),
            distribution: cfg.default_distribution ?? 0,
            threat_level_id: cfg.default_threat_level ?? 4,
            analysis: cfg.default_analysis ?? 0,
            date: new Date(r.created_at).toISOString().slice(0, 10),
            uuid: crypto.randomUUID(),
            Attribute: attributes
          }
        }
        try {
          await mispFetch(cfg, '/events/add.json', { method: 'POST', body: JSON.stringify(body) })
          eventsOut++
          attrsOut += attributes.length
        } catch (err) {
          log.warn(`misp push: skipped ${r.id}: ${(err as Error).message}`)
        }
      }

      const finished = Date.now()
      const summary = `pushed ${eventsOut}/${reports.length} events, ${attrsOut} attributes`
      db.prepare(
        'UPDATE misp_runs SET finished_at=?, events_out=?, attributes_out=?, summary=?, duration_ms=? WHERE id=?'
      ).run(finished, eventsOut, attrsOut, summary, finished - started, runId)

      try {
        auditChainService.append('misp.push', {
          entityType: 'misp_run', entityId: String(runId),
          payload: { events: eventsOut, attributes: attrsOut, endpoint: cfg.url }
        })
      } catch { /* noop */ }

      log.info(`misp push: ${summary} (${finished - started}ms)`)
      return { id: runId, direction: 'push', started_at: started, finished_at: finished,
        events_in: null, events_out: eventsOut, attributes_in: null, attributes_out: attrsOut,
        endpoint: cfg.url ?? null, summary, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE misp_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  async pull(opts: { since_ms?: number } = {}): Promise<MispRun> {
    const db = getDatabase()
    const cfg = this.config()
    const started = Date.now()
    const runId = Number(db.prepare(
      "INSERT INTO misp_runs (direction, started_at, endpoint) VALUES ('pull', ?, ?)"
    ).run(started, cfg.url ?? null).lastInsertRowid)

    try {
      const since = opts.since_ms ?? (started - 30 * 24 * 60 * 60 * 1000)
      const sinceSec = Math.floor(since / 1000)
      // MISP restSearch is the stable way to filter by timestamp.
      const resp = await mispFetch(cfg, '/events/restSearch', {
        method: 'POST',
        body: JSON.stringify({ returnFormat: 'json', timestamp: sinceSec, limit: 500 })
      }) as { response?: Array<{ Event: Record<string, unknown> }> } | Array<{ Event: Record<string, unknown> }>

      const rawEvents = Array.isArray(resp) ? resp : (resp.response ?? [])
      let eventsIn = 0, attrsIn = 0
      const now = Date.now()
      const tx = db.transaction(() => {
        for (const wrap of rawEvents) {
          const e = wrap.Event
          const uuid = String(e.uuid || '')
          if (!uuid) continue
          // Dedup via stix_id column on intel_reports. We re-use stix_id
          // to hold misp:<uuid> so the two interop paths share dedup.
          const stixKey = `misp:${uuid}`
          const existing = db.prepare('SELECT id FROM intel_reports WHERE stix_id = ? LIMIT 1').get(stixKey) as { id: string } | undefined
          const title = String(e.info || 'MISP event').slice(0, 500)
          const content = `MISP event ${uuid}. Distribution=${e.distribution} threat_level=${e.threat_level_id} analysis=${e.analysis}.`
          const eventDateStr = String(e.date || new Date().toISOString().slice(0, 10))
          const publishedMs = new Date(`${eventDateStr}T00:00:00`).getTime()
          let reportId: string
          if (existing) {
            db.prepare('UPDATE intel_reports SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(title, content, now, existing.id)
            reportId = existing.id
          } else {
            reportId = crypto.randomUUID()
            const hash = crypto.createHash('sha256').update(`misp|${uuid}`).digest('hex')
            db.prepare(`
              INSERT INTO intel_reports
                (id, discipline, title, content, summary, severity,
                 source_id, source_url, source_name, content_hash,
                 verification_score, reviewed, created_at, updated_at, stix_id)
              VALUES (?, 'cybint', ?, ?, NULL, 'medium', 'misp-import', ?, 'MISP', ?, 60, 0, ?, ?, ?)
            `).run(reportId, title, content,
              `${cfg.url?.replace(/\/$/, '')}/events/view/${uuid}`,
              hash, publishedMs, now, stixKey)
            eventsIn++
          }
          const attrs = Array.isArray(e.Attribute) ? e.Attribute as Array<Record<string, unknown>> : []
          for (const a of attrs) {
            const mtype = String(a.type || '')
            const entityType = MISP_TO_ENTITY[mtype]
            if (!entityType) continue
            const val = String(a.value || '')
            if (!val) continue
            const entStixKey = `misp:${uuid}:${a.uuid ?? mtype + '|' + val}`
            const prior = db.prepare('SELECT id FROM intel_entities WHERE stix_id = ? AND report_id = ? LIMIT 1').get(entStixKey, reportId) as { id: string } | undefined
            if (prior) continue
            db.prepare(`
              INSERT INTO intel_entities (id, report_id, entity_type, entity_value, confidence, created_at, stix_id)
              VALUES (?, ?, ?, ?, 0.9, ?, ?)
            `).run(crypto.randomUUID(), reportId, entityType, val, now, entStixKey)
            attrsIn++
          }
        }
      })
      tx()

      const finished = Date.now()
      const summary = `pulled ${rawEvents.length} events, ${eventsIn} new reports, ${attrsIn} attributes`
      db.prepare(
        'UPDATE misp_runs SET finished_at=?, events_in=?, attributes_in=?, summary=?, duration_ms=? WHERE id=?'
      ).run(finished, rawEvents.length, attrsIn, summary, finished - started, runId)

      try {
        auditChainService.append('misp.pull', {
          entityType: 'misp_run', entityId: String(runId),
          payload: { events_fetched: rawEvents.length, reports_created: eventsIn, attributes_in: attrsIn }
        })
      } catch { /* noop */ }

      log.info(`misp pull: ${summary} (${finished - started}ms)`)
      return { id: runId, direction: 'pull', started_at: started, finished_at: finished,
        events_in: rawEvents.length, events_out: null, attributes_in: attrsIn, attributes_out: null,
        endpoint: cfg.url ?? null, summary, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE misp_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  recentRuns(limit = 50): MispRun[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, direction, started_at, finished_at, events_in, events_out,
             attributes_in, attributes_out, endpoint, summary, duration_ms
      FROM misp_runs ORDER BY id DESC LIMIT ?
    `).all(limit) as MispRun[]
  }
}
export const mispService = new MispService()
