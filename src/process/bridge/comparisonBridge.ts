// comparisonBridge — v1.9.0 IPC for the comparative-analysis surface.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { comparativeAnalysisService, type EntitySubject, type TimeWindowSubject } from '../services/analysis/ComparativeAnalysisService'

export function registerComparisonBridge(): void {
  ipcMain.handle('comparison:list', (_evt, args?: { limit?: number }) =>
    comparativeAnalysisService.list(args?.limit ?? 50)
  )
  ipcMain.handle('comparison:get', (_evt, id: string) =>
    comparativeAnalysisService.get(id)
  )
  ipcMain.handle('comparison:delete', (_evt, id: string) => {
    comparativeAnalysisService.remove(id); return { ok: true }
  })
  ipcMain.handle('comparison:generate_entities', async (_evt, args: { leftCanonicalId: string; rightCanonicalId: string; name?: string }) =>
    await comparativeAnalysisService.compareEntities(args)
  )
  ipcMain.handle('comparison:generate_time_windows', async (_evt, args: { leftWindow: TimeWindowSubject; rightWindow: TimeWindowSubject; name?: string }) =>
    await comparativeAnalysisService.compareTimeWindows(args)
  )

  log.info('comparison bridge registered')
}

// Re-export for the bridge index
export type { EntitySubject, TimeWindowSubject }
