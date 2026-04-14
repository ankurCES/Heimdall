import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { getDatabase } from '../services/database'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

export function registerIntelBridge(): void {
  ipcMain.handle(IPC_CHANNELS.INTEL_GET_REPORTS, (_event, params) => {
    const db = getDatabase()
    const { offset = 0, limit = 50, discipline, severity, search, reviewed } = params

    const conditions: string[] = []
    const values: unknown[] = []

    if (discipline) {
      conditions.push('discipline = ?')
      values.push(discipline)
    }
    if (severity) {
      conditions.push('severity = ?')
      values.push(severity)
    }
    if (search) {
      conditions.push('(title LIKE ? OR content LIKE ?)')
      values.push(`%${search}%`, `%${search}%`)
    }
    if (reviewed !== undefined) {
      conditions.push('reviewed = ?')
      values.push(reviewed ? 1 : 0)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const total = (
      db.prepare(`SELECT COUNT(*) as count FROM intel_reports ${where}`).get(...values) as { count: number }
    ).count

    const reports = db
      .prepare(
        `SELECT * FROM intel_reports ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...values, limit, offset)

    return { reports: mapReports(reports as RawReport[]), total }
  })

  ipcMain.handle(IPC_CHANNELS.INTEL_GET_REPORT, (_event, params: { id: string }) => {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM intel_reports WHERE id = ?').get(params.id)
    return row ? mapReport(row as RawReport) : null
  })

  ipcMain.handle(IPC_CHANNELS.INTEL_MARK_REVIEWED, (_event, params: { ids: string[] }) => {
    const db = getDatabase()
    const stmt = db.prepare('UPDATE intel_reports SET reviewed = 1, updated_at = ? WHERE id = ?')
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const id of params.ids) {
        stmt.run(now, id)
      }
    })
    tx()
  })

  ipcMain.handle(IPC_CHANNELS.INTEL_GET_DASHBOARD_STATS, () => {
    const db = getDatabase()
    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000

    const totalReports = (
      db.prepare('SELECT COUNT(*) as count FROM intel_reports').get() as { count: number }
    ).count

    const severityCounts = db
      .prepare(
        'SELECT severity, COUNT(*) as count FROM intel_reports WHERE created_at >= ? GROUP BY severity'
      )
      .all(oneDayAgo) as Array<{ severity: ThreatLevel; count: number }>

    const last24h = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const row of severityCounts) {
      last24h[row.severity] = row.count
    }

    const disciplineCounts = db
      .prepare('SELECT discipline, COUNT(*) as count FROM intel_reports GROUP BY discipline')
      .all() as Array<{ discipline: string; count: number }>

    const byDiscipline: Record<string, number> = {}
    for (const row of disciplineCounts) {
      byDiscipline[row.discipline] = row.count
    }

    const sourceCounts = db.prepare('SELECT COUNT(*) as count FROM sources').get() as { count: number }
    const enabledSources = db.prepare('SELECT COUNT(*) as count FROM sources WHERE enabled = 1').get() as { count: number }

    const recentCritical = db
      .prepare(
        "SELECT * FROM intel_reports WHERE severity IN ('critical','high') ORDER BY created_at DESC LIMIT 10"
      )
      .all()

    return {
      totalReports,
      last24h,
      byDiscipline,
      activeCollectors: enabledSources.count,
      totalCollectors: sourceCounts.count,
      recentCritical: mapReports(recentCritical as RawReport[])
    }
  })

  // Trajectory data for ADS-B aircraft and ISS
  ipcMain.handle('intel:getTrajectories', () => {
    const db = getDatabase()

    interface TrajectoryPoint { lat: number; lng: number; time: number }
    interface Trajectory { id: string; label: string; type: 'adsb' | 'iss'; points: TrajectoryPoint[] }
    const trajectories: Trajectory[] = []

    // ISS trajectory
    const issRows = db.prepare(
      "SELECT latitude, longitude, created_at FROM intel_reports WHERE source_name = 'ISS Tracker' AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY created_at ASC"
    ).all() as Array<{ latitude: number; longitude: number; created_at: number }>

    if (issRows.length >= 1) {
      trajectories.push({
        id: 'iss',
        label: 'ISS (International Space Station)',
        type: 'iss',
        points: issRows.map((r) => ({ lat: r.latitude, lng: r.longitude, time: r.created_at }))
      })
    }

    // ADS-B trajectories — group by callsign extracted from title
    const adsbRows = db.prepare(
      "SELECT title, latitude, longitude, created_at FROM intel_reports WHERE source_name LIKE 'ADS-B%' AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY created_at ASC"
    ).all() as Array<{ title: string; latitude: number; longitude: number; created_at: number }>

    const adsbGroups = new Map<string, TrajectoryPoint[]>()
    for (const row of adsbRows) {
      // Extract callsign from title pattern "ADS-B: {callsign} ..."
      const match = row.title.match(/ADS-B:\s*(\S+)/)
      const callsign = match ? match[1] : 'UNKNOWN'
      if (!adsbGroups.has(callsign)) adsbGroups.set(callsign, [])
      adsbGroups.get(callsign)!.push({ lat: row.latitude, lng: row.longitude, time: row.created_at })
    }

    for (const [callsign, points] of adsbGroups) {
      if (points.length >= 2) {
        trajectories.push({
          id: `adsb-${callsign}`,
          label: `ADS-B: ${callsign}`,
          type: 'adsb',
          points
        })
      }
    }

    log.info(`Trajectories: ${trajectories.length} paths (ISS: ${issRows.length} pts, ADS-B: ${adsbGroups.size} aircraft)`)
    return { trajectories }
  })

  log.info('Intel bridge registered')
}

interface RawReport {
  id: string
  discipline: string
  title: string
  content: string
  summary: string | null
  severity: string
  source_id: string
  source_url: string | null
  source_name: string
  content_hash: string
  latitude: number | null
  longitude: number | null
  verification_score: number
  reviewed: number
  created_at: number
  updated_at: number
}

function mapReport(row: RawReport): IntelReport {
  return {
    id: row.id,
    discipline: row.discipline as IntelReport['discipline'],
    title: row.title,
    content: row.content,
    summary: row.summary,
    severity: row.severity as IntelReport['severity'],
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    contentHash: row.content_hash,
    latitude: row.latitude,
    longitude: row.longitude,
    verificationScore: row.verification_score,
    reviewed: row.reviewed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapReports(rows: RawReport[]): IntelReport[] {
  return rows.map(mapReport)
}
