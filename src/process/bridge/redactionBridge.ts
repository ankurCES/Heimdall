import { ipcMain } from 'electron'
import log from 'electron-log'
import { redactionService } from '../services/security/RedactionService'

export function registerRedactionBridge(): void {
  ipcMain.handle('redaction:scan', (_e, args: { text: string }) => redactionService.scan(args.text))
  ipcMain.handle('redaction:flag_report', (_e, reportId: string) => redactionService.flagReport(reportId))
  ipcMain.handle('redaction:apply', (_e, reportId: string) => redactionService.applyRedaction(reportId))
  ipcMain.handle('redaction:dismiss', (_e, eventId: string) => { redactionService.dismiss(eventId); return { ok: true } })
  ipcMain.handle('redaction:pending', (_e, args?: { limit?: number }) => redactionService.pending(args?.limit ?? 100))
  ipcMain.handle('redaction:scan_corpus', (_e, args?: { rescore_all?: boolean }) => redactionService.scanCorpus(args?.rescore_all ?? false))

  log.info('redaction bridge registered')
}
