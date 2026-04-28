// comparisonBridge — v1.9.0 IPC for the comparative-analysis surface
// + v1.9.1 hypothesis tracker IPC.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { comparativeAnalysisService, type EntitySubject, type TimeWindowSubject } from '../services/analysis/ComparativeAnalysisService'
import { hypothesisService, type Verdict } from '../services/analysis/HypothesisService'

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

  // v1.9.1 — hypothesis tracker IPC.
  ipcMain.handle('hypothesis:list', () => hypothesisService.list())
  ipcMain.handle('hypothesis:get', (_evt, id: string) => hypothesisService.get(id))
  ipcMain.handle('hypothesis:create', (_evt, args: { name: string; statement: string; anchorCanonicalId?: string | null; scopeHint?: string | null }) =>
    hypothesisService.create(args)
  )
  ipcMain.handle('hypothesis:update', (_evt, args: { id: string; patch: Parameters<typeof hypothesisService.update>[1] }) =>
    hypothesisService.update(args.id, args.patch)
  )
  ipcMain.handle('hypothesis:delete', (_evt, id: string) => {
    hypothesisService.remove(id); return { ok: true }
  })
  ipcMain.handle('hypothesis:evidence', (_evt, args: { id: string; limit?: number }) =>
    hypothesisService.evidenceFor(args.id, args.limit ?? 100)
  )
  ipcMain.handle('hypothesis:set_override', (_evt, args: { evidenceId: string; verdict: Verdict | null }) => {
    hypothesisService.setAnalystOverride(args.evidenceId, args.verdict); return { ok: true }
  })
  ipcMain.handle('hypothesis:evaluate_pair', async (_evt, args: { hypothesisId: string; intelId: string; force?: boolean }) =>
    await hypothesisService.evaluatePair(args)
  )
  ipcMain.handle('hypothesis:run_now', async () => await hypothesisService.runOnce())

  log.info('comparison bridge registered')
}

// Re-export for the bridge index
export type { EntitySubject, TimeWindowSubject }
