import { ipcMain, dialog, BrowserWindow } from 'electron'
import log from 'electron-log'
import { imageExifService } from '../services/image/ImageExifService'

export function registerImageBridge(): void {
  ipcMain.handle('image:ingest_file', async (_evt, args: { path: string; report_id?: string | null }) => {
    return await imageExifService.ingestFile(args.path, args.report_id ?? null)
  })

  ipcMain.handle('image:ingest_pick', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select image(s) to ingest',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'tif', 'tiff', 'webp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return []
    const results = []
    for (const p of res.filePaths) {
      try {
        results.push(await imageExifService.ingestFile(p))
      } catch (err) {
        log.warn(`image:ingest_pick skipping ${p}: ${(err as Error).message}`)
      }
    }
    return results
  })

  ipcMain.handle('image:list', (_evt, args?: { limit?: number; geo_only?: boolean }) =>
    imageExifService.list({ limit: args?.limit ?? 200, geo_only: !!args?.geo_only })
  )

  ipcMain.handle('image:get', (_evt, id: string) => imageExifService.get(id))

  ipcMain.handle('image:delete', (_evt, id: string) => {
    imageExifService.remove(id)
    return { ok: true }
  })

  log.info('image bridge registered')
}
