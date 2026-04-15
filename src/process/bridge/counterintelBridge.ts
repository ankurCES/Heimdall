import { ipcMain } from 'electron'
import log from 'electron-log'
import { deceptionService } from '../services/counterintel/DeceptionService'

/**
 * Theme 6.1 + 6.3 — counter-intelligence IPC.
 */
export function registerCounterintelBridge(): void {
  ipcMain.handle('ci:analyze', (_evt, args?: { rescore_all?: boolean }) => {
    return deceptionService.batchAnalyze(args?.rescore_all ?? false)
  })

  ipcMain.handle('ci:latest', () => deceptionService.latestRun())

  ipcMain.handle('ci:top', (_evt, args?: { limit?: number }) => {
    return deceptionService.topSuspicious(args?.limit ?? 50)
  })

  ipcMain.handle('ci:for_report', (_evt, reportId: string) => {
    return deceptionService.forReport(reportId)
  })

  ipcMain.handle('ci:state_media', (_evt, args?: { limit?: number }) => {
    return deceptionService.stateMediaReports(args?.limit ?? 100)
  })

  ipcMain.handle('ci:bias_list', () => deceptionService.listSourceBias())

  log.info('counterintel bridge registered')
}
