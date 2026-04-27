// briefingDailyBridge — v1.6.0 IPC for the automated daily briefing.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { dailyBriefingService } from '../services/briefing/DailyBriefingService'

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

  log.info('briefing-daily bridge registered')
}
