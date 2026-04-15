import { ipcMain } from 'electron'
import log from 'electron-log'
import { entityResolutionService } from '../services/entity/EntityResolutionService'

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

  log.info('entity bridge registered')
}
