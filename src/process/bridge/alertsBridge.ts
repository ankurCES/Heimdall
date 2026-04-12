import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { alertEngine } from '../services/alerts/AlertEngine'
import type { AlertRule } from '@common/types/alerts'
import log from 'electron-log'

export function registerAlertsBridge(): void {
  ipcMain.handle(IPC_CHANNELS.ALERTS_GET_HISTORY, (_event, params: { offset: number; limit: number }) => {
    return alertEngine.getHistory(params.offset, params.limit)
  })

  ipcMain.handle(IPC_CHANNELS.ALERTS_SEND_MANUAL, async (_event, params: { reportId: string; channel: string }) => {
    const { getDatabase } = await import('../services/database')
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM intel_reports WHERE id = ?').get(params.reportId) as Record<string, unknown> | undefined
    if (!row) throw new Error(`Report not found: ${params.reportId}`)

    const report = {
      id: row.id as string,
      discipline: row.discipline,
      title: row.title as string,
      content: row.content as string,
      summary: row.summary as string | null,
      severity: row.severity,
      sourceId: row.source_id as string,
      sourceUrl: row.source_url as string | null,
      sourceName: row.source_name as string,
      contentHash: row.content_hash as string,
      latitude: row.latitude as number | null,
      longitude: row.longitude as number | null,
      verificationScore: row.verification_score as number,
      reviewed: (row.reviewed as number) === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }

    // Dispatch directly
    const { EmailDispatcher } = await import('../services/alerts/dispatchers/EmailDispatcher')
    const { TelegramDispatcher } = await import('../services/alerts/dispatchers/TelegramDispatcher')
    const { MeshtasticDispatcher } = await import('../services/alerts/dispatchers/MeshtasticDispatcher')

    switch (params.channel) {
      case 'email': await new EmailDispatcher().send(report as any); break
      case 'telegram': await new TelegramDispatcher().send(report as any); break
      case 'meshtastic': await new MeshtasticDispatcher().send(report as any); break
      default: throw new Error(`Unknown channel: ${params.channel}`)
    }
  })

  ipcMain.handle('alerts:getRules', () => {
    return alertEngine.getRules()
  })

  ipcMain.handle('alerts:saveRules', (_event, params: { rules: AlertRule[] }) => {
    alertEngine.saveRules(params.rules)
  })

  log.info('Alerts bridge registered')
}
