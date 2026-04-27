// briefingDailyBridge — v1.6.0 IPC for the automated daily briefing
// + v1.6.1 export and email delivery.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'fs/promises'
import log from 'electron-log'
import { dailyBriefingService } from '../services/briefing/DailyBriefingService'
import { exportBriefing, emailBriefing, type BriefingExportFormat } from '../services/briefing/DailyBriefingExporter'

export function registerBriefingDailyBridge(): void {
  ipcMain.handle('briefing:daily_list', (_evt, args?: { limit?: number }) =>
    dailyBriefingService.list(args?.limit ?? 50)
  )
  ipcMain.handle('briefing:daily_get', (_evt, id: string) =>
    dailyBriefingService.get(id)
  )
  ipcMain.handle('briefing:daily_generate_now', async (_evt, args?: { lookbackHours?: number; classification?: string }) =>
    await dailyBriefingService.generate(args ?? {})
  )
  ipcMain.handle('briefing:daily_delete', (_evt, id: string) => {
    dailyBriefingService.remove(id)
    return { ok: true }
  })

  // v1.6.1 — export to PDF / DOCX with letterhead applied. Opens a
  // native Save dialog with a sensible default filename.
  ipcMain.handle('briefing:daily_export', async (_evt, args: {
    id: string
    format: BriefingExportFormat
    save?: boolean
  }) => {
    const exported = await exportBriefing(args.id, args.format)
    if (args.save !== false) {
      const win = BrowserWindow.getFocusedWindow()
      const dialogResult = await dialog.showSaveDialog(win ?? undefined!, {
        title: `Export briefing as ${args.format.toUpperCase()}`,
        defaultPath: exported.filename,
        filters: [{ name: args.format.toUpperCase(), extensions: [args.format] }]
      })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { ok: false, cancelled: true, filename: exported.filename, bytes: exported.bytes.byteLength }
      }
      await writeFile(dialogResult.filePath, exported.bytes)
      log.info(`briefing: exported ${args.id} as ${args.format} → ${dialogResult.filePath} (${exported.bytes.byteLength} B)`)
      return { ok: true, path: dialogResult.filePath, filename: exported.filename, bytes: exported.bytes.byteLength }
    }
    return { ok: true, filename: exported.filename, bytes: exported.bytes.byteLength }
  })

  // v1.6.1 — email delivery. Falls back to smtp.defaultRecipients
  // when the renderer doesn't supply an explicit list.
  ipcMain.handle('briefing:daily_email', async (_evt, args: {
    id: string
    recipients?: string[]
    format?: BriefingExportFormat
  }) => {
    return await emailBriefing(args.id, args.recipients ?? [], args.format ?? 'pdf')
  })

  log.info('briefing-daily bridge registered')
}
