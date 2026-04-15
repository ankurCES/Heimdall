import { ipcMain } from 'electron'
import log from 'electron-log'
import { overnightService } from '../services/overnight/OvernightService'

export function registerOvernightBridge(): void {
  ipcMain.handle('overnight:run_now', async (_evt, args?: { periodHours?: number }) => {
    return await overnightService.runCycle({ periodHours: args?.periodHours ?? 24 })
  })
  ipcMain.handle('overnight:latest', () => overnightService.latestRun())
  ipcMain.handle('overnight:recent', (_evt, args?: { limit?: number }) =>
    overnightService.recentRuns(args?.limit ?? 20)
  )
  ipcMain.handle('overnight:prune_expired', () => overnightService.pruneExpiredTerms())

  log.info('overnight bridge registered')
}
