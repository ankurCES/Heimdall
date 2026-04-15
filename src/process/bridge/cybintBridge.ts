import { ipcMain } from 'electron'
import log from 'electron-log'
import { cybintService } from '../services/cybint/CybintService'

export function registerCybintBridge(): void {
  ipcMain.handle('cybint:tactics', () => cybintService.tactics())
  ipcMain.handle('cybint:techniques', (_evt, args?: { tactic?: string | null }) => cybintService.techniques(args?.tactic ?? null))
  ipcMain.handle('cybint:tag_techniques', () => cybintService.tagTechniques())
  ipcMain.handle('cybint:top_techniques', (_evt, args?: { limit?: number }) => cybintService.topTechniques(args?.limit ?? 20))
  ipcMain.handle('cybint:reports_for_technique', (_evt, args: { id: string; limit?: number }) => cybintService.reportsForTechnique(args.id, args.limit ?? 50))
  ipcMain.handle('cybint:sync_kev', () => cybintService.syncKev())
  ipcMain.handle('cybint:kev_count', () => cybintService.kevCount())
  ipcMain.handle('cybint:kev_in_corpus', (_evt, args?: { limit?: number }) => cybintService.kevInCorpus(args?.limit ?? 100))
  ipcMain.handle('cybint:latest_run', (_evt, kind: string) => cybintService.latestRun(kind))

  log.info('cybint bridge registered')
}
