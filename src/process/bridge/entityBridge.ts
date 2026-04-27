import { ipcMain } from 'electron'
import log from 'electron-log'
import { entityResolutionService } from '../services/entity/EntityResolutionService'
import { patternOfLifeService } from '../services/entity/PatternOfLifeService'
import { entityTimelineService } from '../services/entity/EntityTimelineService'
import { entityCoMentionService } from '../services/entity/EntityCoMentionService'
import { entityGeoService } from '../services/entity/EntityGeoService'

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

  log.info('entity bridge registered')
}
