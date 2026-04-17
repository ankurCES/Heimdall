import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { generateId, timestamp } from '@common/utils/id'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import log from 'electron-log'

/**
 * Telegram Intel Receiver — long-polls the Telegram Bot API for incoming
 * messages (DMs + group messages), extracts URLs / .onion URLs / media,
 * and queues each message for analyst review in telegram_intel_queue.
 *
 * Separate bot token from the alert-dispatcher bot. Polling-based (no
 * webhook needed — works behind NAT). Auto-starts on boot if configured.
 *
 * Media files (photos, documents) are downloaded immediately to
 * <userData>/telegram-intel/<date>/<fileId>.<ext>, capped at 20 MB each.
 */

const TELEGRAM_API = 'https://api.telegram.org/bot'
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const ONION_URL_RE = /https?:\/\/[a-z2-7]{16,56}\.onion(?:\/[^\s"'<>\])}]*)?/gi
const URL_RE = /https?:\/\/[^\s"'<>\])}]+/gi

interface TelegramMessage {
  message_id: number
  chat: { id: number; type: string; title?: string; username?: string }
  from?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean }
  date: number
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  forward_from?: { id: number; username?: string; first_name?: string; last_name?: string }
  forward_from_chat?: { id: number; title?: string; username?: string; type: string }
  forward_date?: number
  reply_to_message?: TelegramMessage
  entities?: Array<{ type: string; offset: number; length: number; url?: string }>
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  channel_post?: TelegramMessage
}

export interface ReceiverStatus {
  running: boolean
  botUsername: string | null
  lastPollAt: number | null
  totalReceived: number
  pendingCount: number
  lastError: string | null
  pollInterval: number
}

type StatusListener = (s: ReceiverStatus) => void
type MessageListener = (queueId: string) => void

class TelegramReceiverServiceImpl {
  private running = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpdateId = 0
  private botUsername: string | null = null
  private lastPollAt: number | null = null
  private totalReceived = 0
  private lastError: string | null = null
  private statusListeners = new Set<StatusListener>()
  private messageListeners = new Set<MessageListener>()

  /** Start polling. Idempotent — if already running, returns current status. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: true }

    const token = this.getToken()
    if (!token) return { ok: false, error: 'No Telegram Intel Receiver bot token configured. Set it in Settings → Telegram.' }

    // Verify token with getMe.
    try {
      const me = await this.apiCall<{ id: number; username: string }>(token, 'getMe')
      this.botUsername = me.username
      log.info(`TelegramReceiver: bot @${me.username} (id: ${me.id}) verified`)
    } catch (err) {
      this.lastError = `Token verification failed: ${(err as Error).message}`
      return { ok: false, error: this.lastError }
    }

    this.running = true
    this.lastError = null
    this.emitStatus()
    this.poll()
    log.info('TelegramReceiver: polling started')
    return { ok: true }
  }

  /** Stop polling. */
  stop(): void {
    this.running = false
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    this.emitStatus()
    log.info('TelegramReceiver: stopped')
  }

  isRunning(): boolean { return this.running }

  getStatus(): ReceiverStatus {
    return {
      running: this.running,
      botUsername: this.botUsername,
      lastPollAt: this.lastPollAt,
      totalReceived: this.totalReceived,
      pendingCount: this.getPendingCount(),
      lastError: this.lastError,
      pollInterval: this.getPollInterval()
    }
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Fired when a new message lands in the queue. Used for live badge. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Test a token without starting polling. */
  async testToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
    try {
      const me = await this.apiCall<{ id: number; username: string }>(token, 'getMe')
      return { ok: true, username: me.username }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────
  private getToken(): string | null {
    return settingsService.get<string>('telegramIntel.botToken') || null
  }

  private getPollInterval(): number {
    return settingsService.get<number>('telegramIntel.pollInterval') || 5000
  }

  private getPendingCount(): number {
    try {
      const db = getDatabase()
      return (db.prepare("SELECT COUNT(*) AS c FROM telegram_intel_queue WHERE status = 'pending'").get() as { c: number }).c
    } catch { return 0 }
  }

  private async poll(): Promise<void> {
    if (!this.running) return
    const token = this.getToken()
    if (!token) { this.stop(); return }

    try {
      const updates = await this.apiCall<TelegramUpdate[]>(token, 'getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message', 'channel_post']
      })

      this.lastPollAt = Date.now()
      this.lastError = null

      for (const update of updates) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id)
        const msg = update.message || update.channel_post
        if (msg) await this.processMessage(msg)
      }
    } catch (err) {
      this.lastError = (err as Error).message
      log.warn(`TelegramReceiver: poll error: ${this.lastError}`)
    }

    this.emitStatus()
    // Schedule next poll.
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.getPollInterval())
    }
  }

  private async processMessage(msg: TelegramMessage): Promise<void> {
    const db = getDatabase()
    const now = timestamp()

    // Skip bot's own messages.
    if (msg.from?.is_bot && msg.from.username === this.botUsername) return

    // Skip Telegram bot commands (e.g. /start, /help) — these are
    // lifecycle commands, not intel. Matches any message whose text
    // starts with "/" and is a single word (no payload after the command).
    const text = msg.text?.trim() || ''
    if (/^\/\w+$/.test(text)) return

    // Dedup check.
    const existing = db.prepare(
      'SELECT 1 FROM telegram_intel_queue WHERE telegram_chat_id = ? AND telegram_message_id = ? LIMIT 1'
    ).get(msg.chat.id, msg.message_id)
    if (existing) return

    // Determine message type.
    let messageType = 'text'
    if (msg.photo && msg.photo.length > 0) messageType = 'photo'
    else if (msg.document) messageType = 'document'
    if (msg.forward_from || msg.forward_from_chat) {
      if (messageType === 'text') messageType = 'forward'
    }

    // Extract text content.
    const textContent = msg.text || msg.caption || null

    // Extract URLs from text + entities.
    const allUrls = new Set<string>()
    const allOnionUrls = new Set<string>()

    if (textContent) {
      const matches = textContent.match(URL_RE) || []
      for (const u of matches) allUrls.add(u.replace(/[.,;:!?)}\]'"]+$/, ''))
      const onionMatches = textContent.match(ONION_URL_RE) || []
      for (const u of onionMatches) allOnionUrls.add(u.replace(/[.,;:!?)}\]'"]+$/, ''))
    }

    // Also check entity URLs (Telegram sometimes hides URLs in entities).
    if (msg.entities) {
      for (const e of msg.entities) {
        if (e.type === 'url' && textContent) {
          const url = textContent.slice(e.offset, e.offset + e.length)
          allUrls.add(url)
          if (/\.onion/i.test(url)) allOnionUrls.add(url)
        }
        if (e.type === 'text_link' && e.url) {
          allUrls.add(e.url)
          if (/\.onion/i.test(e.url)) allOnionUrls.add(e.url)
        }
      }
    }

    // Sender info.
    const sender = msg.from
    const senderName = sender
      ? [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || String(sender.id)
      : msg.chat.title || String(msg.chat.id)

    // Forward provenance.
    const forwardFromName = msg.forward_from
      ? [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ') || msg.forward_from.username || null
      : null
    const forwardFromChatTitle = msg.forward_from_chat?.title || null

    // Media handling — download immediately.
    let mediaFileId: string | null = null
    let mediaLocalPath: string | null = null
    let mediaMimeType: string | null = null

    if (msg.photo && msg.photo.length > 0) {
      // Pick the largest photo.
      const photo = msg.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
      mediaFileId = photo.file_id
      if (!photo.file_size || photo.file_size < MAX_FILE_SIZE) {
        mediaLocalPath = await this.downloadFile(photo.file_id, 'jpg')
      }
      mediaMimeType = 'image/jpeg'
    } else if (msg.document) {
      mediaFileId = msg.document.file_id
      mediaMimeType = msg.document.mime_type || 'application/octet-stream'
      if (!msg.document.file_size || msg.document.file_size < MAX_FILE_SIZE) {
        const ext = msg.document.file_name?.split('.').pop() || 'bin'
        mediaLocalPath = await this.downloadFile(msg.document.file_id, ext)
      }
    }

    // Build nested forward chain (recursive if reply_to_message has forwards).
    let rawJson: string
    try {
      rawJson = JSON.stringify(msg, null, 0)
    } catch {
      rawJson = '{}'
    }

    const id = generateId()
    db.prepare(`
      INSERT INTO telegram_intel_queue (
        id, telegram_message_id, telegram_chat_id, sender_id, sender_username, sender_name,
        message_date, message_type, text_content, media_file_id, media_local_path, media_mime_type,
        urls, onion_urls, forward_from_name, forward_from_chat_title, raw_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id, msg.message_id, msg.chat.id,
      sender?.id ?? null, sender?.username ?? null, senderName,
      msg.date * 1000, messageType, textContent,
      mediaFileId, mediaLocalPath, mediaMimeType,
      allUrls.size > 0 ? JSON.stringify(Array.from(allUrls)) : null,
      allOnionUrls.size > 0 ? JSON.stringify(Array.from(allOnionUrls)) : null,
      forwardFromName, forwardFromChatTitle,
      rawJson, now
    )

    this.totalReceived++
    log.info(`TelegramReceiver: queued message ${msg.message_id} from ${senderName} (${messageType}${allUrls.size > 0 ? `, ${allUrls.size} URLs` : ''}${allOnionUrls.size > 0 ? `, ${allOnionUrls.size} onion` : ''})`)

    // Notify listeners (live badge update).
    for (const l of this.messageListeners) {
      try { l(id) } catch { /* */ }
    }
  }

  /** Download a Telegram file to local storage. Returns the local path or null on failure. */
  private async downloadFile(fileId: string, ext: string): Promise<string | null> {
    const token = this.getToken()
    if (!token) return null

    try {
      const fileInfo = await this.apiCall<{ file_path: string }>(token, 'getFile', { file_id: fileId })
      if (!fileInfo.file_path) return null

      const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (!response.ok) return null

      const buffer = Buffer.from(await response.arrayBuffer())
      const date = new Date().toISOString().split('T')[0]
      const dir = join(app.getPath('userData'), 'telegram-intel', date)
      mkdirSync(dir, { recursive: true })
      const filename = `${fileId.slice(0, 20)}.${ext}`
      const localPath = join(dir, filename)
      writeFileSync(localPath, buffer)
      log.debug(`TelegramReceiver: downloaded ${localPath} (${buffer.length} bytes)`)
      return localPath
    } catch (err) {
      log.warn(`TelegramReceiver: file download failed for ${fileId}: ${(err as Error).message}`)
      return null
    }
  }

  /** Call the Telegram Bot API. */
  private async apiCall<T>(token: string, method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API}${token}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(35000)
    })
    const data = await response.json() as { ok: boolean; result: T; description?: string }
    if (!data.ok) throw new Error(data.description || `Telegram API ${method} failed`)
    return data.result
  }

  private emitStatus(): void {
    const s = this.getStatus()
    for (const l of this.statusListeners) {
      try { l(s) } catch { /* */ }
    }
  }
}

export const telegramReceiverService = new TelegramReceiverServiceImpl()
