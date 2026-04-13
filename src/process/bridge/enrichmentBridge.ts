import { ipcMain } from 'electron'
import { intelEnricher } from '../services/enrichment/IntelEnricher'
import { kuzuService } from '../services/graphdb/KuzuService'
import { getDatabase } from '../services/database'
import log from 'electron-log'

function getGraphFromSQLite(params?: {
  reportId?: string; discipline?: string; linkType?: string; limit?: number
}): { nodes: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> } {
  const db = getDatabase()
  const limit = params?.limit || 200

  let linkQuery = 'SELECT source_report_id, target_report_id, link_type, strength, reason FROM intel_links'
  const conditions: string[] = []
  const vals: unknown[] = []

  if (params?.reportId) {
    conditions.push('(source_report_id = ? OR target_report_id = ?)')
    vals.push(params.reportId, params.reportId)
  }
  if (params?.linkType && params.linkType !== 'all') {
    conditions.push('link_type = ?')
    vals.push(params.linkType)
  }

  if (conditions.length > 0) linkQuery += ` WHERE ${conditions.join(' AND ')}`
  linkQuery += ` ORDER BY strength DESC LIMIT ?`
  vals.push(limit)

  const links = db.prepare(linkQuery).all(...vals) as Array<{
    source_report_id: string; target_report_id: string; link_type: string; strength: number; reason: string
  }>

  const nodeIds = new Set<string>()
  for (const link of links) {
    nodeIds.add(link.source_report_id)
    nodeIds.add(link.target_report_id)
  }

  if (params?.discipline && params.discipline !== 'all') {
    const filteredIds = nodeIds.size > 0
      ? db.prepare(
          `SELECT id FROM intel_reports WHERE id IN (${Array.from(nodeIds).map(() => '?').join(',')}) AND discipline = ?`
        ).all(...Array.from(nodeIds), params.discipline) as Array<{ id: string }>
      : []
    const filteredSet = new Set(filteredIds.map((r) => r.id))
    const filteredLinks = links.filter((l) => filteredSet.has(l.source_report_id) && filteredSet.has(l.target_report_id))

    const nodes = filteredIds.length > 0
      ? db.prepare(
          `SELECT id, title, discipline, severity, source_name, verification_score FROM intel_reports WHERE id IN (${filteredIds.map(() => '?').join(',')})`
        ).all(...filteredIds.map((r) => r.id)) as Array<Record<string, unknown>>
      : []

    return {
      nodes: nodes.map((n) => ({
        id: n.id, title: (n.title as string).slice(0, 50), discipline: n.discipline,
        severity: n.severity, source: n.source_name, verification: n.verification_score
      })),
      links: filteredLinks.map((l) => ({
        source: l.source_report_id, target: l.target_report_id,
        type: l.link_type, strength: l.strength, reason: l.reason
      }))
    }
  }

  const nodeQuery = nodeIds.size > 0
    ? `SELECT id, title, discipline, severity, source_name, verification_score FROM intel_reports WHERE id IN (${Array.from(nodeIds).map(() => '?').join(',')})`
    : null
  const nodes = nodeQuery ? db.prepare(nodeQuery).all(...Array.from(nodeIds)) as Array<Record<string, unknown>> : []

  // Add preliminary report nodes
  const prelimReports = db.prepare('SELECT id, title, status FROM preliminary_reports ORDER BY created_at DESC LIMIT 50').all() as Array<Record<string, unknown>>
  const prelimNodes = prelimReports.map((p) => ({
    id: p.id as string, title: `\u{1F4CB} ${(p.title as string).slice(0, 40)}`,
    discipline: 'preliminary', severity: 'high', source: 'Preliminary Report',
    verification: 80, type: 'preliminary'
  }))

  // Add HUMINT nodes
  const humintReports = db.prepare('SELECT id, findings, confidence FROM humint_reports ORDER BY created_at DESC LIMIT 30').all() as Array<Record<string, unknown>>
  const humintNodes = humintReports.map((h) => ({
    id: h.id as string, title: `\u{1F530} HUMINT: ${(h.findings as string).slice(0, 35)}`,
    discipline: 'humint', severity: 'high', source: 'HUMINT',
    verification: 90, type: 'humint'
  }))

  // Add gap nodes
  const gaps = db.prepare("SELECT id, description, severity FROM intel_gaps WHERE status = 'open' LIMIT 30").all() as Array<Record<string, unknown>>
  const gapNodes = gaps.map((g) => ({
    id: g.id as string, title: `\u{26A0}\u{FE0F} ${(g.description as string).slice(0, 40)}`,
    discipline: 'gap', severity: g.severity as string, source: 'Information Gap',
    verification: 0, type: 'gap'
  }))

  // Gap links
  const gapLinks = gaps.map((g) => {
    const prelim = db.prepare('SELECT preliminary_report_id FROM intel_gaps WHERE id = ?').get(g.id) as { preliminary_report_id: string }
    return {
      source: prelim.preliminary_report_id, target: g.id as string,
      type: 'gap_identified', strength: 0.7, reason: 'Information gap identified in report'
    }
  })

  return {
    nodes: [
      ...nodes.map((n) => ({
        id: n.id, title: (n.title as string).slice(0, 50), discipline: n.discipline,
        severity: n.severity, source: n.source_name, verification: n.verification_score
      })),
      ...prelimNodes,
      ...humintNodes,
      ...gapNodes
    ],
    links: [
      ...links.map((l) => ({
        source: l.source_report_id, target: l.target_report_id,
        type: l.link_type, strength: l.strength, reason: l.reason
      })),
      ...gapLinks
    ]
  }
}

export function registerEnrichmentBridge(): void {
  ipcMain.handle('enrichment:getTags', (_event, params: { reportId: string }) => {
    return intelEnricher.getTags(params.reportId)
  })

  ipcMain.handle('enrichment:getEntities', (_event, params: { reportId: string }) => {
    return intelEnricher.getEntities(params.reportId)
  })

  ipcMain.handle('enrichment:getLinks', (_event, params: { reportId: string }) => {
    return intelEnricher.getLinks(params.reportId)
  })

  ipcMain.handle('enrichment:getTopTags', (_event, params?: { limit?: number }) => {
    return intelEnricher.getTopTags(params?.limit)
  })

  ipcMain.handle('enrichment:getTopEntities', (_event, params?: { type?: string; limit?: number }) => {
    return intelEnricher.getTopEntities(params?.type, params?.limit)
  })

  // Get enriched reports with tags, entities, links
  ipcMain.handle('enrichment:getEnrichedReports', (_event, params: {
    tag?: string; entityType?: string; corroboration?: string; limit?: number
  }) => {
    log.info(`getEnrichedReports called with: ${JSON.stringify(params)}`)
    const db = getDatabase()
    const limit = params?.limit || 50

    let query = `SELECT DISTINCT r.id, r.title, r.discipline, r.severity, r.source_name,
      r.verification_score, r.content, r.created_at, r.source_url
      FROM intel_reports r
      INNER JOIN intel_tags t ON r.id = t.report_id`
    const conditions: string[] = []
    const vals: unknown[] = []

    if (params?.tag) {
      conditions.push('t.tag = ?')
      vals.push(params.tag)
    }

    if (params?.entityType) {
      conditions.push('r.id IN (SELECT report_id FROM intel_entities WHERE entity_type = ?)')
      vals.push(params.entityType)
    }

    if (params?.corroboration) {
      conditions.push(`r.id IN (SELECT report_id FROM intel_tags WHERE tag = ?)`)
      vals.push(`corroboration:${params.corroboration}`)
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`
    query += ` ORDER BY r.created_at DESC LIMIT ?`
    vals.push(limit)

    try {
      const reports = db.prepare(query).all(...vals) as Array<Record<string, unknown>>

      return reports.map((r) => ({
        id: r.id, title: r.title, discipline: r.discipline, severity: r.severity,
        sourceName: r.source_name, verificationScore: r.verification_score,
        content: (r.content as string).slice(0, 1000), createdAt: r.created_at,
        sourceUrl: r.source_url,
        tags: intelEnricher.getTags(r.id as string),
        entities: intelEnricher.getEntities(r.id as string),
        links: intelEnricher.getLinks(r.id as string)
      }))
    } catch (err) {
      log.error(`getEnrichedReports error: ${err}`)
      return []
    }
  })

  // Get graph data for relationship visualization — Kuzu-first with SQLite fallback
  ipcMain.handle('enrichment:getGraph', async (_event, params?: {
    reportId?: string; discipline?: string; linkType?: string; limit?: number
  }) => {
    // Try Kuzu first
    if (kuzuService.isReady()) {
      try {
        const result = await kuzuService.getGraph(params)
        if (result.nodes.length > 0 || result.links.length > 0) {
          return result
        }
        // If Kuzu returned empty, fall through to SQLite (may not be synced yet)
      } catch (err) {
        log.warn(`Kuzu graph query failed, falling back to SQLite: ${err}`)
      }
    }

    // Fallback: existing SQLite implementation
    return getGraphFromSQLite(params)
  })

  log.info('Enrichment bridge registered')
}
