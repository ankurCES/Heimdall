// comparisonBridge — v1.9.0 IPC for the comparative-analysis surface
// + v1.9.1 hypothesis tracker IPC.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { comparativeAnalysisService, type EntitySubject, type TimeWindowSubject } from '../services/analysis/ComparativeAnalysisService'
import { hypothesisService, type Verdict } from '../services/analysis/HypothesisService'
import { chronologyService, type ChronologyEvent } from '../services/analysis/ChronologyService'
import { critiqueService, type CritiqueParentKind } from '../services/analysis/CritiqueService'
import { kacService, type KacParentKind, type KacItemStatus } from '../services/analysis/KacService'

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

  // v1.9.3 — red-team critique IPC.
  ipcMain.handle('critique:list', (_evt, args?: { limit?: number }) =>
    critiqueService.list(args?.limit ?? 100)
  )
  ipcMain.handle('critique:list_for_parent', (_evt, args: { parent_kind: CritiqueParentKind; parent_id: string }) =>
    critiqueService.listForParent(args.parent_kind, args.parent_id)
  )
  ipcMain.handle('critique:get', (_evt, id: string) => critiqueService.get(id))
  ipcMain.handle('critique:delete', (_evt, id: string) => {
    critiqueService.remove(id); return { ok: true }
  })
  ipcMain.handle('critique:create_for_parent', async (_evt, args: { parent_kind: Exclude<CritiqueParentKind, 'free'>; parent_id: string }) =>
    await critiqueService.createForParent(args)
  )
  ipcMain.handle('critique:create_freeform', async (_evt, args: { topic: string; label?: string }) =>
    await critiqueService.createFreeform(args)
  )

  // v1.9.4 — Key Assumptions Check IPC.
  ipcMain.handle('kac:list', () => kacService.list())
  ipcMain.handle('kac:list_for_parent', (_evt, args: { parent_kind: NonNullable<KacParentKind>; parent_id: string }) =>
    kacService.listForParent(args.parent_kind, args.parent_id)
  )
  ipcMain.handle('kac:get', (_evt, id: string) => kacService.get(id))
  ipcMain.handle('kac:create', (_evt, args: { name: string; context?: string | null; parent_kind?: KacParentKind; parent_id?: string | null }) =>
    kacService.create(args)
  )
  ipcMain.handle('kac:update', (_evt, args: { id: string; patch: { name?: string; context?: string | null } }) =>
    kacService.update(args.id, args.patch)
  )
  ipcMain.handle('kac:delete', (_evt, id: string) => { kacService.remove(id); return { ok: true } })
  ipcMain.handle('kac:add_item', (_evt, args: { checkId: string; assumption_text: string; status?: KacItemStatus; rationale?: string | null }) =>
    kacService.addItem(args.checkId, { assumption_text: args.assumption_text, status: args.status, rationale: args.rationale })
  )
  ipcMain.handle('kac:update_item', (_evt, args: { itemId: string; patch: { assumption_text?: string; status?: KacItemStatus; rationale?: string | null } }) =>
    kacService.updateItem(args.itemId, args.patch)
  )
  ipcMain.handle('kac:remove_item', (_evt, itemId: string) => { kacService.removeItem(itemId); return { ok: true } })
  ipcMain.handle('kac:reorder_items', (_evt, args: { checkId: string; orderedIds: string[] }) => {
    kacService.reorderItems(args.checkId, args.orderedIds); return { ok: true }
  })
  ipcMain.handle('kac:extract_from_parent', async (_evt, checkId: string) =>
    await kacService.extractFromParent(checkId)
  )

  log.info('comparison bridge registered')
}

// Re-export for the bridge index
export type { EntitySubject, TimeWindowSubject }
