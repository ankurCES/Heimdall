import { ipcMain } from 'electron'
import { iwService } from '../services/iw/IwService'
import { dpbService } from '../services/iw/DpbService'
import { getDatabase } from '../services/database'
import log from 'electron-log'

/**
 * IPC bridge for the Indicators & Warnings workbench (Themes 5.1, 5.2)
 * and the Daily President's Brief (Theme 9.1).
 */
export function registerIwBridge(): void {
  // ---- I&W Events ----
  ipcMain.handle('iw:events:list', (_e, params: { status?: 'active' | 'closed' } = {}) => {
    return iwService.listEvents(params)
  })
  ipcMain.handle('iw:events:get', (_e, params: { id: string }) => {
    return iwService.getEvent(params.id)
  })
  ipcMain.handle('iw:events:create', (_e, params: { name: string; description?: string; scenario_class?: string; classification?: string }) => {
    return iwService.createEvent(params)
  })
  ipcMain.handle('iw:events:update', (_e, params: { id: string; patch: Record<string, unknown> }) => {
    return iwService.updateEvent(params.id, params.patch)
  })
  ipcMain.handle('iw:events:delete', (_e, params: { id: string }) => {
    iwService.deleteEvent(params.id)
    return { ok: true }
  })

  // ---- Indicators ----
  ipcMain.handle('iw:indicators:add', (_e, params: {
    event_id: string; name: string; description?: string;
    query_type: 'intel_count' | 'entity_count'; query_params: Record<string, unknown>;
    red_threshold?: number; amber_threshold?: number; weight?: number;
  }) => {
    return iwService.addIndicator(params)
  })
  ipcMain.handle('iw:indicators:update', (_e, params: { id: string; patch: Record<string, unknown> }) => {
    return iwService.updateIndicator(params.id, params.patch)
  })
  ipcMain.handle('iw:indicators:delete', (_e, params: { id: string }) => {
    iwService.deleteIndicator(params.id)
    return { ok: true }
  })
  ipcMain.handle('iw:indicators:history', (_e, params: { id: string; limit?: number }) => {
    return iwService.history(params.id, params.limit)
  })

  // ---- Evaluation ----
  ipcMain.handle('iw:evaluate:indicator', (_e, params: { id: string }) => {
    return iwService.evaluateIndicator(params.id)
  })
  ipcMain.handle('iw:evaluate:event', (_e, params: { id: string }) => {
    return iwService.evaluateEvent(params.id)
  })
  ipcMain.handle('iw:evaluate:all', () => {
    return iwService.evaluateAll()
  })

  // ---- Daily President's Brief ----
  ipcMain.handle('dpb:generate', async (_e, params: { periodHours?: number; templateName?: string } = {}) => {
    // Read user's clearance from settings so we don't render above their level
    let clearance = 'UNCLASSIFIED'
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT value FROM settings WHERE key = 'security.clearance'").get() as { value: string } | undefined
      if (row?.value) {
        try { clearance = JSON.parse(row.value) as string } catch { clearance = row.value }
      }
    } catch {}
    return dpbService.generate({ ...params, clearance })
  })
  ipcMain.handle('dpb:latest', () => dpbService.getLatest())
  ipcMain.handle('dpb:list', (_e, params: { limit?: number } = {}) => dpbService.list(params.limit))
  ipcMain.handle('dpb:get', (_e, params: { id: string }) => dpbService.get(params.id))

  log.info('I&W + DPB bridge registered')
}
