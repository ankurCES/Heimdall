import { ipcMain } from 'electron'
import log from 'electron-log'
import { consolidationService } from '../services/memory/ConsolidationService'

export function registerConsolidationBridge(): void {
  ipcMain.handle('memory:consolidate', async (_evt, args?: { lookback_ms?: number }) =>
    await consolidationService.runOnce({ lookback_ms: args?.lookback_ms })
  )
  ipcMain.handle('memory:latest_run', () => consolidationService.latestRun())
  ipcMain.handle('memory:recent_runs', (_evt, args?: { limit?: number }) =>
    consolidationService.recentRuns(args?.limit ?? 20)
  )
  log.info('memory consolidation bridge registered')
}
