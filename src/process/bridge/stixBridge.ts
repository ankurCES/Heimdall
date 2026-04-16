import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import path from 'path'
import log from 'electron-log'
import { stixService } from '../services/stix/StixService'

export function registerStixBridge(): void {
  ipcMain.handle('stix:export', async (_evt, args: { since_ms?: number; discipline?: string | null; bundle_path?: string }) => {
    let bundlePath = args.bundle_path
    if (!bundlePath) {
      const win = BrowserWindow.getFocusedWindow()
      const res = await dialog.showSaveDialog(win ?? undefined!, {
        title: 'Save STIX 2.1 bundle',
        defaultPath: path.join(app.getPath('documents'), `heimdall-stix-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'STIX Bundle', extensions: ['json'] }]
      })
      if (res.canceled || !res.filePath) return null
      bundlePath = res.filePath
    }
    return stixService.export({
      since_ms: args.since_ms,
      discipline: args.discipline ?? null,
      bundle_path: bundlePath
    })
  })

  ipcMain.handle('stix:import_pick', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Open STIX 2.1 bundle',
      properties: ['openFile'],
      filters: [{ name: 'STIX Bundle', extensions: ['json'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return stixService.import(res.filePaths[0])
  })

  ipcMain.handle('stix:import', (_evt, bundlePath: string) => stixService.import(bundlePath))

  ipcMain.handle('stix:runs', (_evt, args?: { limit?: number }) => stixService.recentRuns(args?.limit ?? 50))

  log.info('stix bridge registered')
}
