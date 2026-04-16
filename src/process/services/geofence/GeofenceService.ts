import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 3.2 — Geofence alerts.
 *
 * Circular geofences over lat/lng-tagged intel_reports. The corpus-scan
 * path is the only write path in this batch — every scan is full
 * (INSERT OR IGNORE against the unique (geofence_id, report_id) index
 * makes repeat runs idempotent).
 *
 * Haversine distance computed in-process — simpler than the SQLite
 * dependency of a geo extension, and still well under a second on
 * 20K reports × tens of fences.
 */

export interface Geofence {
  id: string
  name: string
  center_lat: number
  center_lng: number
  radius_km: number
  discipline_filter: string | null
  severity_filter: string | null
  enabled: number
  notes: string | null
  created_at: number
  updated_at: number
}

export interface GeofenceInput {
  name: string
  center_lat: number
  center_lng: number
  radius_km: number
  discipline_filter?: string | null
  severity_filter?: string | null
  notes?: string | null
}

export interface GeofenceAlert {
  id: number
  geofence_id: string
  geofence_name: string
  report_id: string
  report_title: string
  report_discipline: string
  report_severity: string
  report_created_at: number
  distance_km: number
  created_at: number
}

export interface GeofenceRun {
  id: number
  started_at: number
  finished_at: number
  fences_scanned: number
  reports_scanned: number
  alerts_created: number
  duration_ms: number
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371 // km
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export class GeofenceService {
  list(): Geofence[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, name, center_lat, center_lng, radius_km, discipline_filter,
             severity_filter, enabled, notes, created_at, updated_at
      FROM geofences ORDER BY created_at DESC
    `).all() as Geofence[]
  }

  create(input: GeofenceInput): Geofence {
    if (!input.name.trim()) throw new Error('Name is required')
    if (!(Number.isFinite(input.center_lat) && Math.abs(input.center_lat) <= 90)) {
      throw new Error('center_lat must be a valid latitude (−90..90)')
    }
    if (!(Number.isFinite(input.center_lng) && Math.abs(input.center_lng) <= 180)) {
      throw new Error('center_lng must be a valid longitude (−180..180)')
    }
    if (!(Number.isFinite(input.radius_km) && input.radius_km > 0 && input.radius_km <= 20000)) {
      throw new Error('radius_km must be > 0 and ≤ 20000')
    }
    const db = getDatabase()
    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO geofences
        (id, name, center_lat, center_lng, radius_km, discipline_filter,
         severity_filter, enabled, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, input.name.trim(), input.center_lat, input.center_lng, input.radius_km,
      input.discipline_filter || null, input.severity_filter || null,
      input.notes || null, now, now)

    try {
      auditChainService.append('geofence.create', {
        entityType: 'geofence', entityId: id,
        payload: { name: input.name, center: [input.center_lat, input.center_lng], radius_km: input.radius_km }
      })
    } catch { /* noop */ }

    return this.get(id)!
  }

  get(id: string): Geofence | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, name, center_lat, center_lng, radius_km, discipline_filter,
             severity_filter, enabled, notes, created_at, updated_at
      FROM geofences WHERE id = ?
    `).get(id) as Geofence) || null
  }

  update(id: string, patch: Partial<GeofenceInput> & { enabled?: boolean }): Geofence {
    const db = getDatabase()
    const cur = this.get(id)
    if (!cur) throw new Error(`Geofence ${id} not found`)
    const fields: string[] = []
    const vals: unknown[] = []
    const append = (col: string, v: unknown) => { fields.push(`${col} = ?`); vals.push(v) }

    if (patch.name != null) append('name', patch.name.trim())
    if (patch.center_lat != null) append('center_lat', patch.center_lat)
    if (patch.center_lng != null) append('center_lng', patch.center_lng)
    if (patch.radius_km != null) append('radius_km', patch.radius_km)
    if (patch.discipline_filter !== undefined) append('discipline_filter', patch.discipline_filter || null)
    if (patch.severity_filter !== undefined) append('severity_filter', patch.severity_filter || null)
    if (patch.notes !== undefined) append('notes', patch.notes || null)
    if (patch.enabled !== undefined) append('enabled', patch.enabled ? 1 : 0)
    append('updated_at', Date.now())

    if (fields.length === 1) return cur // only updated_at was appended
    vals.push(id)
    db.prepare(`UPDATE geofences SET ${fields.join(', ')} WHERE id = ?`).run(...vals)

    try {
      auditChainService.append('geofence.update', {
        entityType: 'geofence', entityId: id, payload: patch
      })
    } catch { /* noop */ }

    return this.get(id)!
  }

  remove(id: string): void {
    const db = getDatabase()
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM geofence_alerts WHERE geofence_id = ?').run(id)
      db.prepare('DELETE FROM geofences WHERE id = ?').run(id)
    })
    tx()
    try {
      auditChainService.append('geofence.delete', {
        entityType: 'geofence', entityId: id, payload: {}
      })
    } catch { /* noop */ }
  }

  /**
   * Scan the whole corpus against every enabled geofence. Idempotent —
   * repeat runs don't create duplicate alerts (UNIQUE constraint + INSERT
   * OR IGNORE).
   */
  scanCorpus(): GeofenceRun {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare('INSERT INTO geofence_runs (started_at) VALUES (?)').run(started).lastInsertRowid)

    try {
      const fences = db.prepare(`
        SELECT id, center_lat, center_lng, radius_km, discipline_filter, severity_filter
        FROM geofences WHERE enabled = 1
      `).all() as Array<Pick<Geofence, 'id' | 'center_lat' | 'center_lng' | 'radius_km' | 'discipline_filter' | 'severity_filter'>>

      if (fences.length === 0) {
        const finished = Date.now()
        db.prepare(
          'UPDATE geofence_runs SET finished_at=?, fences_scanned=0, reports_scanned=0, alerts_created=0, duration_ms=? WHERE id=?'
        ).run(finished, finished - started, runId)
        return { id: runId, started_at: started, finished_at: finished,
          fences_scanned: 0, reports_scanned: 0, alerts_created: 0,
          duration_ms: finished - started }
      }

      const reports = db.prepare(`
        SELECT id, latitude, longitude, discipline, severity
        FROM intel_reports
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      `).all() as Array<{ id: string; latitude: number; longitude: number; discipline: string; severity: string }>

      const ins = db.prepare(`
        INSERT OR IGNORE INTO geofence_alerts
          (geofence_id, report_id, distance_km, created_at)
        VALUES (?, ?, ?, ?)
      `)
      const now = Date.now()
      let alerts = 0
      const tx = db.transaction(() => {
        for (const r of reports) {
          for (const f of fences) {
            if (f.discipline_filter && f.discipline_filter !== r.discipline) continue
            if (f.severity_filter && f.severity_filter !== r.severity) continue
            const d = haversineKm(r.latitude, r.longitude, f.center_lat, f.center_lng)
            if (d <= f.radius_km) {
              const res = ins.run(f.id, r.id, d, now)
              if (res.changes > 0) alerts++
            }
          }
        }
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE geofence_runs SET finished_at=?, fences_scanned=?, reports_scanned=?, alerts_created=?, duration_ms=? WHERE id=?'
      ).run(finished, fences.length, reports.length, alerts, finished - started, runId)

      log.info(`geofence: scan — ${fences.length} fences × ${reports.length} reports → ${alerts} new alerts (${finished - started}ms)`)
      return { id: runId, started_at: started, finished_at: finished,
        fences_scanned: fences.length, reports_scanned: reports.length,
        alerts_created: alerts, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE geofence_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  recentAlerts(limit = 100, geofenceId?: string): GeofenceAlert[] {
    const db = getDatabase()
    if (geofenceId) {
      return db.prepare(`
        SELECT a.id, a.geofence_id, g.name AS geofence_name, a.report_id,
               r.title AS report_title, r.discipline AS report_discipline,
               r.severity AS report_severity, r.created_at AS report_created_at,
               a.distance_km, a.created_at
        FROM geofence_alerts a
        JOIN geofences g ON g.id = a.geofence_id
        JOIN intel_reports r ON r.id = a.report_id
        WHERE a.geofence_id = ?
        ORDER BY a.created_at DESC LIMIT ?
      `).all(geofenceId, limit) as GeofenceAlert[]
    }
    return db.prepare(`
      SELECT a.id, a.geofence_id, g.name AS geofence_name, a.report_id,
             r.title AS report_title, r.discipline AS report_discipline,
             r.severity AS report_severity, r.created_at AS report_created_at,
             a.distance_km, a.created_at
      FROM geofence_alerts a
      JOIN geofences g ON g.id = a.geofence_id
      JOIN intel_reports r ON r.id = a.report_id
      ORDER BY a.created_at DESC LIMIT ?
    `).all(limit) as GeofenceAlert[]
  }

  latestRun(): GeofenceRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, fences_scanned, reports_scanned,
             alerts_created, duration_ms
      FROM geofence_runs
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as GeofenceRun) || null
  }

  stats(): Array<{ geofence_id: string; name: string; alert_count: number; last_alert_at: number | null }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT g.id AS geofence_id, g.name,
             COUNT(a.id) AS alert_count,
             MAX(a.created_at) AS last_alert_at
      FROM geofences g
      LEFT JOIN geofence_alerts a ON a.geofence_id = g.id
      GROUP BY g.id
      ORDER BY alert_count DESC
    `).all() as Array<{ geofence_id: string; name: string; alert_count: number; last_alert_at: number | null }>
  }
}

export const geofenceService = new GeofenceService()
