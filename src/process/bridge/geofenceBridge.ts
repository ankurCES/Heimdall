import { ipcMain } from 'electron'
import log from 'electron-log'
import { geofenceService, type GeofenceInput } from '../services/geofence/GeofenceService'

export function registerGeofenceBridge(): void {
  ipcMain.handle('geofence:list', () => geofenceService.list())
  ipcMain.handle('geofence:create', (_evt, input: GeofenceInput) => geofenceService.create(input))
  ipcMain.handle('geofence:update', (_evt, args: { id: string; patch: Partial<GeofenceInput> & { enabled?: boolean } }) =>
    geofenceService.update(args.id, args.patch)
  )
  ipcMain.handle('geofence:delete', (_evt, id: string) => { geofenceService.remove(id); return { ok: true } })
  ipcMain.handle('geofence:scan', () => geofenceService.scanCorpus())
  ipcMain.handle('geofence:alerts', (_evt, args?: { limit?: number; geofence_id?: string }) =>
    geofenceService.recentAlerts(args?.limit ?? 100, args?.geofence_id)
  )
  ipcMain.handle('geofence:latest', () => geofenceService.latestRun())
  ipcMain.handle('geofence:stats', () => geofenceService.stats())

  log.info('geofence bridge registered')
}
