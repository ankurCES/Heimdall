import { ipcMain } from 'electron'
import log from 'electron-log'
import { entityResolutionService } from '../services/entity/EntityResolutionService'
import { patternOfLifeService } from '../services/entity/PatternOfLifeService'
import { entityTimelineService } from '../services/entity/EntityTimelineService'
import { entityCoMentionService } from '../services/entity/EntityCoMentionService'
import { entityGeoService } from '../services/entity/EntityGeoService'
import { entityMergeService } from '../services/entity/EntityMergeService'
import { entityWatchlist } from '../services/entity/EntityWatchlistService'
import { graphCanvasService } from '../services/entity/GraphCanvasService'

/**
 * Theme 4.6 — entity resolution IPC.
 *
 * Channels:
 *   entity:resolve          → run the resolver; returns run summary
 *   entity:latest           → last successful run, or null
 *   entity:top({type?, limit?}) → top canonical entities by mention count
 *   entity:types            → [{ entity_type, count }, …]
 *   entity:aliases(id)      → raw aliases rolled up under a canonical id
 *   entity:reports(id)      → reports mentioning a canonical id
 */
export function registerEntityBridge(): void {
  ipcMain.handle('entity:resolve', () => entityResolutionService.resolve())
  ipcMain.handle('entity:latest', () => entityResolutionService.latestRun())

  ipcMain.handle('entity:top', (_evt, args?: { type?: string | null; limit?: number }) => {
    return entityResolutionService.top(args?.type ?? null, args?.limit ?? 50)
  })

  ipcMain.handle('entity:types', () => entityResolutionService.types())

  ipcMain.handle('entity:aliases', (_evt, canonicalId: string) => {
    return entityResolutionService.aliases(canonicalId)
  })

  ipcMain.handle('entity:reports', (_evt, args: { id: string; limit?: number }) => {
    return entityResolutionService.reports(args.id, args.limit ?? 50)
  })

  ipcMain.handle('entity:pol', (_evt, args: { id: string; window_days?: number }) => {
    return patternOfLifeService.forEntity(args.id, args.window_days ?? 90)
  })

  // v1.7.0 — cross-corpus entity timeline. Returns every mention of
  // the canonical entity (and its aliases) across intel + transcripts
  // + HUMINT + documents + briefings + images, sorted by timestamp.
  ipcMain.handle('entity:timeline', (_evt, args: { id: string; limitPerCorpus?: number }) => {
    return entityTimelineService.getTimeline(args.id, args.limitPerCorpus ?? 50)
  })

  // v1.7.1 — co-mention link analysis. Returns the top-N other
  // canonical entities that share at least one intel_report with the
  // source entity, ranked by shared-report count.
  ipcMain.handle('entity:co_mentions', (_evt, args: { id: string; limit?: number }) => {
    return entityCoMentionService.getCoMentions(args.id, args.limit ?? 25)
  })

  // v1.7.2 — geo pins for the map view on the entity timeline. Pulls
  // intel reports (exact join via canonical_id) + image evidence
  // (FTS5 MATCH on aliases) where lat/long are non-null.
  ipcMain.handle('entity:geo_pins', (_evt, args: { id: string; limitPerCorpus?: number }) => {
    return entityGeoService.getPins(args.id, args.limitPerCorpus ?? 200)
  })

  // v1.7.3 — analyst-driven canonical correction.
  ipcMain.handle('entity:merge', (_evt, args: { sourceIds: string[]; targetId: string }) => {
    return entityMergeService.merge(args.sourceIds, args.targetId)
  })
  ipcMain.handle('entity:split', (_evt, args: { sourceCanonicalId: string; splitValues: string[]; newCanonicalValue: string }) => {
    return entityMergeService.split(args)
  })

  // v1.7.4 — entity watchlist (anchored alerts).
  ipcMain.handle('entity:watch_add', (_evt, canonicalId: string) => entityWatchlist.add(canonicalId))
  ipcMain.handle('entity:watch_remove', (_evt, canonicalId: string) => {
    entityWatchlist.remove(canonicalId); return { ok: true }
  })
  ipcMain.handle('entity:watch_status', (_evt, canonicalId: string) => entityWatchlist.getByCanonicalId(canonicalId))
  ipcMain.handle('entity:watch_list', () => entityWatchlist.list())
  ipcMain.handle('entity:watch_set_enabled', (_evt, args: { canonicalId: string; enabled: boolean }) => {
    entityWatchlist.setEnabled(args.canonicalId, args.enabled); return { ok: true }
  })

  // v1.8.0 — Phase 9 graph canvas IPCs.
  ipcMain.handle('graph:list', () => graphCanvasService.list())
  ipcMain.handle('graph:get', (_evt, id: string) => graphCanvasService.get(id))
  ipcMain.handle('graph:create_from_entity', (_evt, args: { name: string; canonicalId: string; expandLimit?: number; description?: string }) =>
    graphCanvasService.createFromEntity(args)
  )
  ipcMain.handle('graph:expand', (_evt, args: { canvasId: string; canonicalId: string; expandLimit?: number }) =>
    graphCanvasService.expand(args)
  )
  ipcMain.handle('graph:save', (_evt, args: Parameters<typeof graphCanvasService.save>[0]) =>
    graphCanvasService.save(args)
  )
  ipcMain.handle('graph:delete', (_evt, id: string) => {
    graphCanvasService.remove(id); return { ok: true }
  })

  log.info('entity bridge registered')
}
