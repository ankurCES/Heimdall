import { ipcMain } from 'electron'
import { intelEnricher } from '../services/enrichment/IntelEnricher'
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
    const { getDatabase } = require('../services/database')
    const db = getDatabase()
    const limit = params?.limit || 100

    let query = `SELECT DISTINCT r.* FROM intel_reports r JOIN intel_tags t ON r.id = t.report_id`
    const conditions: string[] = []
    const vals: unknown[] = []

    if (params?.tag) {
      conditions.push('t.tag = ?')
      vals.push(params.tag)
    }
    if (params?.entityType) {
      query += ` JOIN intel_entities e ON r.id = e.report_id`
      conditions.push('e.entity_type = ?')
      vals.push(params.entityType)
    }
    if (params?.corroboration) {
      const corrobTag = `corroboration:${params.corroboration}`
      query += ` JOIN intel_tags ct ON r.id = ct.report_id AND ct.tag = ?`
      vals.push(corrobTag)
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`
    query += ` ORDER BY r.created_at DESC LIMIT ?`
    vals.push(limit)

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
  })

  log.info('Enrichment bridge registered')
}
