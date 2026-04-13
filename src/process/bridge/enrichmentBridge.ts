import { ipcMain } from 'electron'
import { intelEnricher } from '../services/enrichment/IntelEnricher'
import { getDatabase } from '../services/database'
import log from 'electron-log'

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

    // Simple approach: get reports that have tags, then filter
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

  // Get graph data for relationship visualization
  ipcMain.handle('enrichment:getGraph', (_event, params?: {
    reportId?: string; discipline?: string; linkType?: string; limit?: number
  }) => {
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

    // Collect unique node IDs
    const nodeIds = new Set<string>()
    for (const link of links) {
      nodeIds.add(link.source_report_id)
      nodeIds.add(link.target_report_id)
    }

    // Filter by discipline if needed
    let nodeQuery = `SELECT id, title, discipline, severity, source_name, verification_score FROM intel_reports WHERE id IN (${Array.from(nodeIds).map(() => '?').join(',')})`
    let nodeVals: unknown[] = Array.from(nodeIds)

    if (params?.discipline && params.discipline !== 'all') {
      // Re-query with discipline filter
      const filteredIds = db.prepare(
        `SELECT id FROM intel_reports WHERE id IN (${Array.from(nodeIds).map(() => '?').join(',')}) AND discipline = ?`
      ).all(...Array.from(nodeIds), params.discipline) as Array<{ id: string }>
      const filteredSet = new Set(filteredIds.map((r) => r.id))

      // Filter links to only include filtered nodes
      const filteredLinks = links.filter((l) => filteredSet.has(l.source_report_id) && filteredSet.has(l.target_report_id))

      const nodes = db.prepare(
        `SELECT id, title, discipline, severity, source_name, verification_score FROM intel_reports WHERE id IN (${filteredIds.map(() => '?').join(',') || "'none'"})`
      ).all(...filteredIds.map((r) => r.id)) as Array<Record<string, unknown>>

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

    const nodes = nodeIds.size > 0 ? db.prepare(nodeQuery).all(...nodeVals) as Array<Record<string, unknown>> : []

    return {
      nodes: nodes.map((n) => ({
        id: n.id, title: (n.title as string).slice(0, 50), discipline: n.discipline,
        severity: n.severity, source: n.source_name, verification: n.verification_score
      })),
      links: links.map((l) => ({
        source: l.source_report_id, target: l.target_report_id,
        type: l.link_type, strength: l.strength, reason: l.reason
      }))
    }
  })

  log.info('Enrichment bridge registered')
}
