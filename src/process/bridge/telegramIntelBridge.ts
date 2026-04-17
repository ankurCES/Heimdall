import { ipcMain, BrowserWindow } from 'electron'
import log from 'electron-log'
import { getDatabase } from '../services/database'
import { telegramReceiverService } from '../services/telegram/TelegramReceiverService'
import { telegramIntelProcessor } from '../services/telegram/TelegramIntelProcessor'
import { settingsService } from '../services/settings/SettingsService'
import { readFileSync } from 'fs'

function safeBroadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* */ }
  }
}

export function registerTelegramIntelBridge(): void {
  // Wire live events.
  telegramReceiverService.onStatus((s) => safeBroadcast('telegram-intel:status_update', s))
  telegramReceiverService.onMessage((queueId) => safeBroadcast('telegram-intel:new_message', { queueId }))

  // ── Config ───────────────────────────────────────────────────────────
  ipcMain.handle('telegram-intel:get_config', () => {
    return {
      botToken: settingsService.get<string>('telegramIntel.botToken') || '',
      pollInterval: settingsService.get<number>('telegramIntel.pollInterval') || 5000,
      autoStart: settingsService.get<boolean>('telegramIntel.autoStart') ?? true
    }
  })

  ipcMain.handle('telegram-intel:set_config', (_e, params: { botToken?: string; pollInterval?: number; autoStart?: boolean }) => {
    if (params.botToken !== undefined) settingsService.set('telegramIntel.botToken', params.botToken)
    if (params.pollInterval !== undefined) settingsService.set('telegramIntel.pollInterval', Math.max(2000, Math.min(60000, params.pollInterval)))
    if (params.autoStart !== undefined) settingsService.set('telegramIntel.autoStart', params.autoStart)
    return { ok: true }
  })

  ipcMain.handle('telegram-intel:test_token', async (_e, params: { token: string }) => {
    return telegramReceiverService.testToken(params.token)
  })

  // ── Receiver control ─────────────────────────────────────────────────
  ipcMain.handle('telegram-intel:start', async () => telegramReceiverService.start())
  ipcMain.handle('telegram-intel:stop', () => { telegramReceiverService.stop(); return { ok: true } })
  ipcMain.handle('telegram-intel:status', () => telegramReceiverService.getStatus())

  // ── Queue management ─────────────────────────────────────────────────
  ipcMain.handle('telegram-intel:list', (_e, params: {
    status?: string
    sender?: string
    search?: string
    limit?: number
    offset?: number
  } = {}) => {
    const db = getDatabase()
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
    const offset = Math.max(params.offset ?? 0, 0)
    const conditions: string[] = []
    const args: unknown[] = []

    if (params.status && params.status !== 'all') {
      conditions.push('status = ?')
      args.push(params.status)
    }
    if (params.sender) {
      conditions.push('(sender_username LIKE ? OR sender_name LIKE ?)')
      args.push(`%${params.sender}%`, `%${params.sender}%`)
    }
    if (params.search) {
      conditions.push('(text_content LIKE ? OR forward_from_name LIKE ? OR forward_from_chat_title LIKE ?)')
      const s = `%${params.search}%`
      args.push(s, s, s)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM telegram_intel_queue ${where}`).get(...args) as { c: number }).c
    const items = db.prepare(`
      SELECT id, telegram_message_id, telegram_chat_id, sender_id, sender_username, sender_name,
             message_date, message_type, substr(text_content, 1, 200) AS text_preview,
             media_file_id, media_local_path, media_mime_type,
             urls, onion_urls, forward_from_name, forward_from_chat_title,
             status, rejection_reason, analyst_notes, ingested_report_ids,
             reviewed_at, created_at
      FROM telegram_intel_queue ${where}
      ORDER BY message_date DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset)

    return { total, items, limit, offset }
  })

  ipcMain.handle('telegram-intel:get', (_e, params: { id: string }) => {
    const db = getDatabase()
    const item = db.prepare('SELECT * FROM telegram_intel_queue WHERE id = ?').get(params.id)
    return item || null
  })

  // ── Approve / Reject ─────────────────────────────────────────────────
  ipcMain.handle('telegram-intel:approve', async (_e, params: { id: string; notes?: string }) => {
    return telegramIntelProcessor.approve(params.id, params.notes)
  })

  ipcMain.handle('telegram-intel:reject', (_e, params: { id: string; reason: string }) => {
    return telegramIntelProcessor.reject(params.id, params.reason)
  })

  ipcMain.handle('telegram-intel:bulk_approve', async (_e, params: { ids: string[]; notes?: string }) => {
    return telegramIntelProcessor.bulkApprove(params.ids, params.notes)
  })

  ipcMain.handle('telegram-intel:bulk_reject', (_e, params: { ids: string[]; reason: string }) => {
    return telegramIntelProcessor.bulkReject(params.ids, params.reason)
  })

  ipcMain.handle('telegram-intel:delete', (_e, params: { id: string }) => {
    const db = getDatabase()
    db.prepare('DELETE FROM telegram_intel_queue WHERE id = ?').run(params.id)
    return { ok: true }
  })

  // ── Media preview (serve downloaded files to the renderer) ───────────
  ipcMain.handle('telegram-intel:media_preview', (_e, params: { path: string }) => {
    try {
      const data = readFileSync(params.path)
      return { ok: true, data: data.toString('base64') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── Pending count (for sidebar badge) ────────────────────────────────
  ipcMain.handle('telegram-intel:pending_count', () => {
    try {
      const db = getDatabase()
      return (db.prepare("SELECT COUNT(*) AS c FROM telegram_intel_queue WHERE status = 'pending'").get() as { c: number }).c
    } catch { return 0 }
  })

  // ── Auto-start on boot if configured ─────────────────────────────────
  const autoStart = settingsService.get<boolean>('telegramIntel.autoStart') ?? true
  const hasToken = !!(settingsService.get<string>('telegramIntel.botToken'))
  if (autoStart && hasToken) {
    void telegramReceiverService.start()
      .then((r) => { if (r.ok) log.info('TelegramIntel: auto-started on boot') })
      .catch((err) => log.debug(`TelegramIntel: auto-start failed: ${err}`))
  }

  log.info('Telegram Intel bridge registered')
}
