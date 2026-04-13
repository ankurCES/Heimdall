import { ipcMain } from 'electron'
import { syncManager } from '../services/sync/SyncManager'
import log from 'electron-log'

export function registerSyncBridge(): void {
  ipcMain.handle('sync:getJobs', () => syncManager.getJobs())

  ipcMain.handle('sync:runJob', async (_event, params: { type: string }) => {
    log.info(`Sync: manual trigger for ${params.type}`)
    switch (params.type) {
      case 'obsidian-push': syncManager.syncObsidianPush(); break
      case 'vector-db': syncManager.syncVectorDb(); break
      case 'enrichment': syncManager.syncEnrichment(); break
      case 'meshtastic': syncManager.syncMeshtastic(); break
      default: return { error: `Unknown sync type: ${params.type}` }
    }
    return { started: true }
  })

  ipcMain.handle('sync:runAll', async () => {
    log.info('Sync: manual sync all')
    syncManager.syncAll() // Don't await — runs in background
    return { started: true }
  })

  ipcMain.handle('sync:isRunning', () => syncManager.isAnyRunning())

  log.info('Sync bridge registered')
}
