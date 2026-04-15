import { ipcMain } from 'electron'
import { exportService, type ExportRequest } from '../services/export/ExportService'
import log from 'electron-log'

/**
 * IPC bridge for the multi-format export funnel (Theme 9.4).
 * One channel — `export:write` — handles every format. Renderer-side
 * dispatch picks the format and source type per artifact.
 */
export function registerExportBridge(): void {
  ipcMain.handle('export:write', async (_e, params: ExportRequest) => {
    return exportService.export(params)
  })

  log.info('Export bridge registered')
}
