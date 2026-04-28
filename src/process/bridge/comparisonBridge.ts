// comparisonBridge — v1.9.0 IPC for the comparative-analysis surface
// + v1.9.1 hypothesis tracker IPC.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { comparativeAnalysisService, type EntitySubject, type TimeWindowSubject } from '../services/analysis/ComparativeAnalysisService'
import { hypothesisService, type Verdict } from '../services/analysis/HypothesisService'
import { chronologyService, type ChronologyEvent } from '../services/analysis/ChronologyService'

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

  // v1.9.2 — chronology builder IPC.
  ipcMain.handle('chronology:list', () => chronologyService.list())
  ipcMain.handle('chronology:get', (_evt, id: string) => chronologyService.get(id))
  ipcMain.handle('chronology:create', (_evt, args: { name: string; description?: string | null }) =>
    chronologyService.create(args)
  )
  ipcMain.handle('chronology:update', (_evt, args: { id: string; patch: { name?: string; description?: string | null } }) =>
    chronologyService.update(args.id, args.patch)
  )
  ipcMain.handle('chronology:delete', (_evt, id: string) => {
    chronologyService.remove(id); return { ok: true }
  })
  ipcMain.handle('chronology:add_event', (_evt, args: { id: string; event: Omit<ChronologyEvent, 'id'> & { id?: string } }) =>
    chronologyService.addEvent(args.id, args.event)
  )
  ipcMain.handle('chronology:update_event', (_evt, args: { id: string; eventId: string; patch: Partial<Omit<ChronologyEvent, 'id'>> }) =>
    chronologyService.updateEvent(args.id, args.eventId, args.patch)
  )
  ipcMain.handle('chronology:remove_event', (_evt, args: { id: string; eventId: string }) =>
    chronologyService.removeEvent(args.id, args.eventId)
  )
  ipcMain.handle('chronology:replace_events', (_evt, args: { id: string; events: ChronologyEvent[] }) =>
    chronologyService.replaceEvents(args.id, args.events)
  )
  ipcMain.handle('chronology:export_markdown', (_evt, id: string) =>
    chronologyService.exportMarkdown(id)
  )

  log.info('comparison bridge registered')
}

// Re-export for the bridge index
export type { EntitySubject, TimeWindowSubject }
