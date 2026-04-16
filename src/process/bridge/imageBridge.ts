import { ipcMain, dialog, BrowserWindow } from 'electron'
import log from 'electron-log'
import path from 'path'
import { app } from 'electron'
import { imageExifService } from '../services/image/ImageExifService'
import { geoLocationAssistant } from '../services/llm/GeoLocationAssistant'
import fs from 'fs'

/** Validate a user-supplied path is within safe bounds (home dir). */
function validatePath(p: string): string {
  const resolved = path.resolve(p)
  const home = app.getPath('home')
  if (!resolved.startsWith(home)) {
    throw new Error(`Path traversal blocked: ${resolved} is outside ${home}`)
  }
  return resolved
}

export function registerImageBridge(): void {
  ipcMain.handle('image:ingest_file', async (_evt, args: { path: string; report_id?: string | null }) => {
    return await imageExifService.ingestFile(validatePath(args.path), args.report_id ?? null)
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

  // Theme 3.7 — OSINT geolocation via LLM vision.
  ipcMain.handle('image:geolocate', async (_evt, args: { image_id?: string; image_path?: string }) => {
    let dataUrl: string
    if (args.image_id) {
      const img = imageExifService.get(args.image_id)
      if (!img) throw new Error(`Image not found: ${args.image_id}`)
      const buf = fs.readFileSync(img.source_path)
      const mime = img.mime_type || 'image/jpeg'
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    } else if (args.image_path) {
      const safePath = validatePath(args.image_path)
      const buf = fs.readFileSync(safePath)
      const ext = safePath.toLowerCase()
      const mime = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    } else {
      throw new Error('Provide image_id or image_path')
    }
    return await geoLocationAssistant.analyze(dataUrl)
  })

  log.info('image bridge registered')
}
