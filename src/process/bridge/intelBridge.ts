import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { getDatabase } from '../services/database'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

export function registerIntelBridge(): void {
  ipcMain.handle(IPC_CHANNELS.INTEL_GET_REPORTS, (_event, params) => {
    const db = getDatabase()
    const { offset = 0, limit = 50, discipline, severity, search, reviewed, sourceType, sourceId } = params

    const conditions: string[] = []
    const values: unknown[] = []
    let needsJoin = false

    if (discipline) {
      conditions.push('r.discipline = ?')
      values.push(discipline)
    }
    if (severity) {
      conditions.push('r.severity = ?')
      values.push(severity)
    }
    if (search) {
      conditions.push('(r.title LIKE ? OR r.content LIKE ?)')
      values.push(`%${search}%`, `%${search}%`)
    }
    if (reviewed !== undefined) {
      conditions.push('r.reviewed = ?')
      values.push(reviewed ? 1 : 0)
    }
    if (sourceType) {
      conditions.push('s.type = ?')
      values.push(sourceType)
      needsJoin = true
    }
    if (sourceId) {
      conditions.push('r.source_id = ?')
      values.push(sourceId)
    }

    // Always JOIN sources so STANAG source-reliability rating is available
    // on every returned report. The previous gating on `needsJoin` only
    // joined when filtering by source_type.
    const join = 'LEFT JOIN sources s ON r.source_id = s.id'
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const total = (
      db.prepare(`SELECT COUNT(*) as count FROM intel_reports r ${join} ${where}`).get(...values) as { count: number }
    ).count

    const reports = db
      .prepare(
        `SELECT r.*, s.admiralty_reliability AS source_reliability FROM intel_reports r ${join} ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...values, limit, offset)

    return { reports: mapReports(reports as RawReport[]), total }
  })

  // List distinct source types currently in use (for filter dropdowns)
  ipcMain.handle('intel:getSourceTypes', () => {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT s.type, COUNT(r.id) as count
      FROM sources s
      LEFT JOIN intel_reports r ON r.source_id = s.id
      GROUP BY s.type
      HAVING count > 0
      ORDER BY count DESC
    `).all() as Array<{ type: string; count: number }>
    return rows
  })

  ipcMain.handle(IPC_CHANNELS.INTEL_GET_REPORT, (_event, params: { id: string }) => {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT r.*, s.admiralty_reliability AS source_reliability FROM intel_reports r LEFT JOIN sources s ON r.source_id = s.id WHERE r.id = ?'
    ).get(params.id)
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
        "SELECT r.*, s.admiralty_reliability AS source_reliability FROM intel_reports r LEFT JOIN sources s ON r.source_id = s.id WHERE r.severity IN ('critical','high') ORDER BY r.created_at DESC LIMIT 10"
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

  // Extended dashboard stats: hourly trend, geo heat, top entities/sources, market summary
  ipcMain.handle('intel:getDashboardExtras', () => {
    const db = getDatabase()
    const now = Date.now()
    const dayAgo = now - 24 * 60 * 60 * 1000
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000

    // Hourly trend — 24 hourly buckets
    const hourlyRows = db.prepare(`
      SELECT (created_at / 3600000) AS hour_bucket, severity, COUNT(*) AS c
      FROM intel_reports
      WHERE created_at >= ?
      GROUP BY hour_bucket, severity
    `).all(dayAgo) as Array<{ hour_bucket: number; severity: string; c: number }>

    const startHour = Math.floor(dayAgo / 3600000)
    const hourlyTrend: Array<{ hour: number; critical: number; high: number; medium: number; low: number; info: number }> = []
    for (let h = 0; h < 24; h++) {
      hourlyTrend.push({ hour: (startHour + h) * 3600000, critical: 0, high: 0, medium: 0, low: 0, info: 0 })
    }
    for (const r of hourlyRows) {
      const idx = r.hour_bucket - startHour
      if (idx >= 0 && idx < 24) {
        const bucket = hourlyTrend[idx]
        if (r.severity in bucket) (bucket as Record<string, number>)[r.severity] = r.c
      }
    }

    // Geo points for mini map (recent geo-tagged critical/high)
    const geoPoints = db.prepare(`
      SELECT id, latitude, longitude, severity, title, source_name
      FROM intel_reports
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        AND latitude != 0 AND longitude != 0
        AND created_at >= ?
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        created_at DESC
      LIMIT 200
    `).all(dayAgo) as Array<{ id: string; latitude: number; longitude: number; severity: string; title: string; source_name: string }>

    // Top entities (last 7 days)
    const topEntities = db.prepare(`
      SELECT entity_type, entity_value, COUNT(DISTINCT report_id) AS mentions
      FROM intel_entities
      WHERE created_at >= ?
        AND entity_type IN ('threat_actor', 'malware', 'country', 'organization', 'cve')
      GROUP BY entity_type, entity_value
      ORDER BY mentions DESC
      LIMIT 12
    `).all(weekAgo) as Array<{ entity_type: string; entity_value: string; mentions: number }>

    // Top sources by 24h volume
    const topSources = db.prepare(`
      SELECT source_name, discipline, COUNT(*) AS reports
      FROM intel_reports
      WHERE created_at >= ?
      GROUP BY source_name
      ORDER BY reports DESC
      LIMIT 8
    `).all(dayAgo) as Array<{ source_name: string; discipline: string; reports: number }>

    // Market summary — top 5 movers from latest market_quotes
    let marketSummary: Array<{ ticker: string; name: string; price: number; change_pct: number; category: string }> = []
    try {
      marketSummary = db.prepare(`
        SELECT q.ticker, q.name, q.price, q.change_pct, q.category
        FROM market_quotes q
        INNER JOIN (
          SELECT ticker, MAX(recorded_at) AS max_t
          FROM market_quotes
          GROUP BY ticker
        ) latest ON q.ticker = latest.ticker AND q.recorded_at = latest.max_t
        WHERE q.change_pct IS NOT NULL
        ORDER BY ABS(q.change_pct) DESC
        LIMIT 8
      `).all() as Array<{ ticker: string; name: string; price: number; change_pct: number; category: string }>
    } catch {}

    // Recent activity timeline (last 30 events)
    const timeline = db.prepare(`
      SELECT id, title, severity, discipline, source_name, created_at
      FROM intel_reports
      WHERE severity IN ('critical', 'high')
      ORDER BY created_at DESC
      LIMIT 25
    `).all() as Array<{ id: string; title: string; severity: string; discipline: string; source_name: string; created_at: number }>

    // Source health
    const sourceHealth = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_count,
        SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN last_collected_at >= ? THEN 1 ELSE 0 END) AS active_24h
      FROM sources
    `).get(dayAgo) as { total: number; enabled_count: number; error_count: number; active_24h: number }

    // Total entities/tags counts (knowledge graph size)
    const entityCount = (db.prepare('SELECT COUNT(DISTINCT entity_value) AS c FROM intel_entities').get() as { c: number }).c
    const tagCount = (db.prepare('SELECT COUNT(DISTINCT tag) AS c FROM intel_tags').get() as { c: number }).c
    const linkCount = (db.prepare('SELECT COUNT(*) AS c FROM intel_links').get() as { c: number }).c

    // 7-day total for header trend indicator
    const reportsLast7d = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports WHERE created_at >= ?').get(weekAgo) as { c: number }).c
    const reportsPrev7d = (db.prepare(
      'SELECT COUNT(*) AS c FROM intel_reports WHERE created_at >= ? AND created_at < ?'
    ).get(weekAgo - 7 * 24 * 60 * 60 * 1000, weekAgo) as { c: number }).c
    const trendPct = reportsPrev7d > 0 ? Math.round(((reportsLast7d - reportsPrev7d) / reportsPrev7d) * 100) : 0

    return {
      hourlyTrend,
      geoPoints,
      topEntities,
      topSources,
      marketSummary,
      timeline,
      sourceHealth,
      knowledgeGraph: { entities: entityCount, tags: tagCount, links: linkCount },
      trend: { last7d: reportsLast7d, prev7d: reportsPrev7d, pct: trendPct }
    }
  })

  // Trajectory data for ADS-B aircraft and ISS
  ipcMain.handle('intel:getTrajectories', () => {
    const db = getDatabase()

    interface TrajectoryPoint { lat: number; lng: number; time: number }
    interface Trajectory { id: string; label: string; type: 'adsb' | 'iss'; points: TrajectoryPoint[] }
    const trajectories: Trajectory[] = []

    // ISS trajectory — show only the most recent orbit (~92 min). The ISS
    // completes one revolution every ~92 minutes; historical paths overlap
    // themselves and clutter the map. Limit to the last 100 minutes so the
    // user sees a single clean orbital track.
    const ISS_ORBIT_MS = 100 * 60 * 1000
    const issCutoff = Date.now() - ISS_ORBIT_MS
    const issRows = db.prepare(
      "SELECT latitude, longitude, created_at FROM intel_reports WHERE source_name = 'ISS Tracker' AND latitude IS NOT NULL AND longitude IS NOT NULL AND created_at >= ? ORDER BY created_at ASC"
    ).all(issCutoff) as Array<{ latitude: number; longitude: number; created_at: number }>

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
  credibility: number | null
  source_reliability: string | null
  reviewed: number
  created_at: number
  updated_at: number
}

function mapReport(row: RawReport): IntelReport {
  const r = row.source_reliability
  const sourceReliability = (r === 'A' || r === 'B' || r === 'C' || r === 'D' || r === 'E' || r === 'F') ? r : null
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
    credibility: row.credibility,
    sourceReliability,
    reviewed: row.reviewed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapReports(rows: RawReport[]): IntelReport[] {
  return rows.map(mapReport)
}
