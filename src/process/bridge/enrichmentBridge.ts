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

  log.info('Enrichment bridge registered')
}
