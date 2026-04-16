import { ipcMain } from 'electron'
import log from 'electron-log'
import { tradecraftService } from '../services/tradecraft/TradecraftService'

export function registerTradecraftBridge(): void {
  ipcMain.handle('tradecraft:adjust_credibility', (_evt, args: { report_id: string; kind: 'corroborate' | 'contradict'; evidence_strength: number; source_report_id?: string | null }) =>
    tradecraftService.adjustCredibility(args)
  )
  ipcMain.handle('tradecraft:source_trust', () => tradecraftService.listSourceTrust())
  ipcMain.handle('tradecraft:manual_demote', (_evt, args: { source_id: string; to_grade: string; reason: string }) =>
    tradecraftService.manualDemote(args.source_id, args.to_grade, args.reason)
  )
  ipcMain.handle('tradecraft:credibility_events', (_evt, args: { report_id: string; limit?: number }) =>
    tradecraftService.recentEvents(args.report_id, args.limit ?? 20)
  )
  ipcMain.handle('tradecraft:ach_diagnosticity', (_evt, sessionId: string) =>
    tradecraftService.achDiagnosticity(sessionId)
  )
  log.info('tradecraft bridge registered')
}
