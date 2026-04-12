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

  log.info('Enrichment bridge registered')
}
