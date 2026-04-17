import { ipcMain } from 'electron'
import log from 'electron-log'
import { torService } from '../services/darkweb/TorService'

/**
 * IPC bridge for the Tor on-demand connection.
 *
 * Channels:
 *   - `tor:status`     → current TorState (status, host/port, bootstrap %, last error)
 *   - `tor:connect`    → attach to existing Tor or spawn managed instance
 *   - `tor:disconnect` → unbind SafeFetcher and kill managed child
 *   - `tor:health`     → boolean live SOCKS5 probe
 */
export function registerTorBridge(): void {
  ipcMain.handle('tor:status', () => torService.getState())
  ipcMain.handle('tor:connect', async () => torService.connect())
  ipcMain.handle('tor:disconnect', async () => torService.disconnect())
  ipcMain.handle('tor:health', async () => torService.healthCheck())
  log.info('Tor bridge registered')
}
