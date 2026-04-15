import { ipcMain } from 'electron'
import log from 'electron-log'
import { injectionScreener } from '../services/security/InjectionScreener'

export function registerInjectionBridge(): void {
  ipcMain.handle('inj:screen_corpus', () => injectionScreener.screenCorpus())
  ipcMain.handle('inj:screen_report', (_evt, reportId: string) => injectionScreener.screenReport(reportId))
  ipcMain.handle('inj:release', (_evt, args: { report_id: string; released_by?: string }) => {
    injectionScreener.release(args.report_id, args.released_by ?? 'analyst')
    return { ok: true }
  })
  ipcMain.handle('inj:quarantined', (_evt, args?: { limit?: number }) =>
    injectionScreener.listQuarantined(args?.limit ?? 100)
  )
  ipcMain.handle('inj:flagged', (_evt, args?: { limit?: number }) =>
    injectionScreener.listFlagged(args?.limit ?? 100)
  )
  ipcMain.handle('inj:latest', () => injectionScreener.latestRun())
  ipcMain.handle('inj:rules', () => injectionScreener.listRules())

  log.info('injection bridge registered')
}
