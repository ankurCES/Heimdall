import { ipcMain } from 'electron'
import log from 'electron-log'
import { anomalyService } from '../services/anomaly/AnomalyService'
import { iwSuggestionService } from '../services/iw/IwSuggestionService'

export function registerAnomalyBridge(): void {
  ipcMain.handle('anomaly:detect', (_evt, args?: { window_days?: number }) =>
    anomalyService.detect(args?.window_days ?? 60)
  )
  ipcMain.handle('anomaly:recent', (_evt, args?: { limit?: number; severity?: 'low' | 'med' | 'high' }) =>
    anomalyService.recent(args?.limit ?? 100, args?.severity)
  )
  ipcMain.handle('anomaly:latest', () => anomalyService.latestRun())
  ipcMain.handle('anomaly:signals', () => anomalyService.signalSummary())

  // Theme I — AI-suggested I&W indicators.
  ipcMain.handle('iw:suggest_indicators', async (_evt, args: { name: string; description?: string | null; scenario_class?: string | null }) => {
    return await iwSuggestionService.suggest(args)
  })

  log.info('anomaly + iw-suggestion bridge registered')
}
