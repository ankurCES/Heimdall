import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { toolRegistry } from '../tools/ToolRegistry'
import { torService } from '../darkweb/TorService'
import { auditService } from '../audit/AuditService'
import log from 'electron-log'

/**
 * Processes approved Telegram intel queue items through Heimdall's
 * ingestion pipeline:
 *
 *   - Text → create intel_report (discipline: humint)
 *   - URLs → web_fetch each → store as intel_report
 *   - .onion URLs → onion_fetch → store → enrich → crawl (full darkweb pipeline)
 *   - Images → store + queue IMINT analysis (if vision-capable LLM configured)
 *   - Documents → store metadata as intel_report
 *   - All created reports linked via intel_links (type: telegram_source)
 *
 * Rejection requires a mandatory reason (audit-logged).
 */

interface QueueItem {
  id: string
  telegram_message_id: number
  telegram_chat_id: number
  sender_id: number | null
  sender_username: string | null
  sender_name: string | null
  message_date: number
  message_type: string
  text_content: string | null
  media_file_id: string | null
  media_local_path: string | null
  media_mime_type: string | null
  urls: string | null
  onion_urls: string | null
  forward_from_name: string | null
  forward_from_chat_title: string | null
  raw_json: string | null
  status: string
  analyst_notes: string | null
}

export interface ProcessResult {
  ok: boolean
  reportIds: string[]
  errors: string[]
}

class TelegramIntelProcessorImpl {
  /**
   * Approve a queued message and process through the intel pipeline.
   * Sets status to 'processing' → runs pipeline → 'ingested' or 'failed'.
   */
  async approve(queueId: string, analystNotes?: string): Promise<ProcessResult> {
    const db = getDatabase()
    const now = timestamp()

    const item = db.prepare('SELECT * FROM telegram_intel_queue WHERE id = ?').get(queueId) as QueueItem | undefined
    if (!item) return { ok: false, reportIds: [], errors: ['Queue item not found'] }
    if (item.status !== 'pending') return { ok: false, reportIds: [], errors: [`Item status is '${item.status}', expected 'pending'`] }

    db.prepare("UPDATE telegram_intel_queue SET status = 'processing', analyst_notes = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .run(analystNotes || null, now, 'analyst', queueId)

    auditService.log('telegram-intel.approved', {
      queueId, telegramMessageId: item.telegram_message_id,
      sender: item.sender_name, messageType: item.message_type
    })

    const reportIds: string[] = []
    const errors: string[] = []

    try {
      // 1. Create a base intel report from the message text.
      if (item.text_content && item.text_content.trim().length > 10) {
        const id = this.createTextReport(item, analystNotes)
        reportIds.push(id)
      }

      // 2. Process clearnet URLs.
      const urls = item.urls ? JSON.parse(item.urls) as string[] : []
      const onionUrls = new Set(item.onion_urls ? JSON.parse(item.onion_urls) as string[] : [])
      const clearnetUrls = urls.filter((u) => !onionUrls.has(u))

      for (const url of clearnetUrls.slice(0, 10)) {
        try {
          const r = await toolRegistry.execute('web_fetch', { url })
          if (!r.error && r.output) {
            const id = this.createUrlReport(item, url, r.output, 'web', analystNotes)
            reportIds.push(id)
          } else {
            errors.push(`web_fetch ${url}: ${r.error || 'empty response'}`)
          }
        } catch (err) {
          errors.push(`web_fetch ${url}: ${(err as Error).message}`)
        }
      }

      // 3. Process .onion URLs (requires Tor).
      if (onionUrls.size > 0) {
        const torState = torService.getState()
        const torConnected = torState.status === 'connected_external' || torState.status === 'connected_managed'

        if (torConnected) {
          for (const url of Array.from(onionUrls).slice(0, 5)) {
            try {
              const r = await toolRegistry.execute('onion_fetch', { url, max_chars: 4000 })
              if (!r.error && r.data) {
                const data = r.data as { hostname?: string; text?: string }
                if (data.text) {
                  const id = await this.createOnionReport(item, url, data.hostname || 'unknown', data.text, analystNotes)
                  if (id) reportIds.push(id)
                }
              } else {
                errors.push(`onion_fetch ${url}: ${r.error || 'empty response'}`)
              }
            } catch (err) {
              errors.push(`onion_fetch ${url}: ${(err as Error).message}`)
            }
          }
        } else {
          errors.push(`Tor not connected — ${onionUrls.size} .onion URLs skipped. Connect Tor and re-approve to process them.`)
        }
      }

      // 4. Process image (IMINT).
      if (item.media_local_path && item.message_type === 'photo') {
        try {
          const id = await this.createImageReport(item, analystNotes)
          if (id) reportIds.push(id)
        } catch (err) {
          errors.push(`Image processing: ${(err as Error).message}`)
        }
      }

      // 5. Process document.
      if (item.media_local_path && item.message_type === 'document') {
        const id = this.createDocumentReport(item, analystNotes)
        reportIds.push(id)
      }

      // 6. Link all reports together (telegram_source).
      if (reportIds.length > 1) {
        this.linkReports(reportIds, queueId)
      }

      // Update queue status.
      const finalStatus = errors.length > 0 && reportIds.length === 0 ? 'failed' : 'ingested'
      db.prepare("UPDATE telegram_intel_queue SET status = ?, ingested_report_ids = ? WHERE id = ?")
        .run(finalStatus, JSON.stringify(reportIds), queueId)

      log.info(`TelegramIntelProcessor: ${queueId} → ${reportIds.length} reports created, ${errors.length} errors`)
      return { ok: true, reportIds, errors }
    } catch (err) {
      db.prepare("UPDATE telegram_intel_queue SET status = 'failed' WHERE id = ?").run(queueId)
      const msg = (err as Error).message
      log.error(`TelegramIntelProcessor: ${queueId} failed: ${msg}`)
      return { ok: false, reportIds, errors: [...errors, msg] }
    }
  }

  /** Reject a queued message with a mandatory reason. */
  reject(queueId: string, reason: string): { ok: boolean; error?: string } {
    if (!reason || !reason.trim()) return { ok: false, error: 'Rejection reason is mandatory' }
    const db = getDatabase()
    const now = timestamp()
    const item = db.prepare('SELECT status FROM telegram_intel_queue WHERE id = ?').get(queueId) as { status: string } | undefined
    if (!item) return { ok: false, error: 'Queue item not found' }
    if (item.status !== 'pending') return { ok: false, error: `Item status is '${item.status}', expected 'pending'` }

    db.prepare("UPDATE telegram_intel_queue SET status = 'rejected', rejection_reason = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
      .run(reason.trim(), now, 'analyst', queueId)
    auditService.log('telegram-intel.rejected', { queueId, reason: reason.trim() })
    return { ok: true }
  }

  /** Bulk approve. */
  async bulkApprove(queueIds: string[], analystNotes?: string): Promise<{ total: number; succeeded: number; failed: number }> {
    let succeeded = 0, failed = 0
    for (const id of queueIds) {
      const r = await this.approve(id, analystNotes)
      if (r.ok) succeeded++; else failed++
    }
    return { total: queueIds.length, succeeded, failed }
  }

  /** Bulk reject. */
  bulkReject(queueIds: string[], reason: string): { total: number; succeeded: number; failed: number } {
    let succeeded = 0, failed = 0
    for (const id of queueIds) {
      const r = this.reject(id, reason)
      if (r.ok) succeeded++; else failed++
    }
    return { total: queueIds.length, succeeded, failed }
  }

  // ── Report creation helpers ──────────────────────────────────────────

  private createTextReport(item: QueueItem, notes?: string | null): string {
    const db = getDatabase()
    const now = timestamp()
    const id = generateId()
    const senderLine = `**From**: ${item.sender_name || 'Unknown'}${item.sender_username ? ` (@${item.sender_username})` : ''}`
    const forwardLine = item.forward_from_name || item.forward_from_chat_title
      ? `**Forwarded from**: ${item.forward_from_name || ''} ${item.forward_from_chat_title ? `(${item.forward_from_chat_title})` : ''}`
      : ''
    const notesLine = notes ? `**Analyst notes**: ${notes}` : ''
    const content = [senderLine, forwardLine, notesLine, '', '---', '', item.text_content].filter(Boolean).join('\n')
    const title = `[TELEGRAM] ${item.sender_name || 'Unknown'}: ${(item.text_content || '').slice(0, 80)}`
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update(`tg:${item.telegram_chat_id}:${item.telegram_message_id}`).digest('hex')

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'humint', title.slice(0, 250), content, (item.text_content || '').slice(0, 240), 'medium',
      'telegram-intel', `Telegram: ${item.sender_name || 'Unknown'}`, null, hash, 50, 0, now, now)

    this.tagReport(id, ['telegram-intel', `sender:${(item.sender_username || item.sender_name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`], now)
    return id
  }

  private createUrlReport(item: QueueItem, url: string, content: string, source: string, notes?: string | null): string {
    const db = getDatabase()
    const now = timestamp()
    const id = generateId()
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update(url + '|' + content.slice(0, 4000)).digest('hex')
    const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
    if (existing) return existing.id

    const title = `[TELEGRAM-URL] ${new URL(url).hostname}`.slice(0, 250)
    const body = `**Source**: Telegram message from ${item.sender_name || 'Unknown'}\n**URL**: ${url}\n${notes ? `**Analyst notes**: ${notes}\n` : ''}\n---\n\n${content.slice(0, 6000)}`

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'osint', title, body, content.slice(0, 240), 'medium', 'telegram-intel', `Telegram URL: ${new URL(url).hostname}`, url, hash, 50, 0, now, now)

    this.tagReport(id, ['telegram-intel', 'telegram-url'], now)
    return id
  }

  private async createOnionReport(item: QueueItem, url: string, hostname: string, text: string, notes?: string | null): Promise<string | null> {
    const { createHash } = await import('crypto')
    const db = getDatabase()
    const now = timestamp()
    const trimmed = text.slice(0, 8000)
    const hash = createHash('sha256').update(url + '|' + trimmed).digest('hex')
    const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
    if (existing) return existing.id

    const id = generateId()
    const title = `[DARKWEB] ${hostname}`.slice(0, 200)
    const content = `**Source**: Telegram message from ${item.sender_name || 'Unknown'}\n**Onion URL**: ${url}\n${notes ? `**Analyst notes**: ${notes}\n` : ''}\n---\n\n${trimmed}`

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'osint', title, content, trimmed.slice(0, 240), 'medium', 'telegram-intel', `Onion: ${hostname}`, url, hash, 40, 0, now, now)

    this.tagReport(id, ['darkweb', 'telegram-intel', 'onion-fetch', 'telegram-onion'], now)

    // Trigger darkweb enrichment + crawl pipeline.
    try {
      const { darkWebEnrichmentService } = await import('../darkweb/DarkWebEnrichmentService')
      darkWebEnrichmentService.enqueue(id)
    } catch { /* */ }
    try {
      const { onionCrawlerService } = await import('../darkweb/OnionCrawlerService')
      onionCrawlerService.enqueue(id)
    } catch { /* */ }

    return id
  }

  private async createImageReport(item: QueueItem, notes?: string | null): Promise<string | null> {
    const db = getDatabase()
    const now = timestamp()
    const id = generateId()
    const { createHash } = await import('crypto')
    const hash = createHash('sha256').update(`tg-img:${item.media_file_id}`).digest('hex')

    // Try IMINT vision analysis if LLM is available.
    let visionAnalysis = ''
    try {
      const { readFileSync } = await import('fs')
      const imgBuf = readFileSync(item.media_local_path!)
      const b64 = `data:image/jpeg;base64,${imgBuf.toString('base64')}`
      const { llmService } = await import('../llm/LlmService')
      if (llmService.hasUsableConnection()) {
        visionAnalysis = await llmService.completeVision(
          'Analyze this image for intelligence value. Describe: subjects, location indicators, text/watermarks, potential threats, geolocation clues. Be specific.',
          [b64], { timeoutMs: 60000 }
        )
      }
    } catch (err) {
      log.debug(`TelegramIntelProcessor: vision analysis failed: ${(err as Error).message}`)
    }

    const title = `[TELEGRAM-IMG] From ${item.sender_name || 'Unknown'}`.slice(0, 250)
    const content = [
      `**Source**: Telegram image from ${item.sender_name || 'Unknown'}`,
      item.text_content ? `**Caption**: ${item.text_content}` : '',
      notes ? `**Analyst notes**: ${notes}` : '',
      item.media_local_path ? `**Local file**: ${item.media_local_path}` : '',
      '',
      '---',
      '',
      visionAnalysis ? `## Vision Analysis\n\n${visionAnalysis}` : '(No vision analysis — LLM not configured or analysis failed)'
    ].filter(Boolean).join('\n')

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'imint', title, content, (item.text_content || visionAnalysis || 'Telegram image').slice(0, 240), 'medium',
      'telegram-intel', `Telegram Image: ${item.sender_name || 'Unknown'}`, hash, 50, 0, now, now)

    this.tagReport(id, ['telegram-intel', 'telegram-image', 'imint'], now)
    return id
  }

  private createDocumentReport(item: QueueItem, notes?: string | null): string {
    const db = getDatabase()
    const now = timestamp()
    const id = generateId()
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update(`tg-doc:${item.media_file_id}`).digest('hex')

    const title = `[TELEGRAM-DOC] From ${item.sender_name || 'Unknown'}`.slice(0, 250)
    const content = [
      `**Source**: Telegram document from ${item.sender_name || 'Unknown'}`,
      `**MIME type**: ${item.media_mime_type || 'unknown'}`,
      item.media_local_path ? `**Local file**: ${item.media_local_path}` : '',
      item.text_content ? `**Caption**: ${item.text_content}` : '',
      notes ? `**Analyst notes**: ${notes}` : ''
    ].filter(Boolean).join('\n')

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'humint', title, content, (item.text_content || 'Telegram document').slice(0, 240), 'medium',
      'telegram-intel', `Telegram Doc: ${item.sender_name || 'Unknown'}`, hash, 45, 0, now, now)

    this.tagReport(id, ['telegram-intel', 'telegram-document'], now)
    return id
  }

  private tagReport(reportId: string, tags: string[], now: number): void {
    const db = getDatabase()
    const stmt = db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)')
    for (const tag of tags) {
      try { stmt.run(reportId, tag, 1.0, 'telegram-intel', now) } catch { /* */ }
    }
  }

  private linkReports(reportIds: string[], queueId: string): void {
    const db = getDatabase()
    const now = timestamp()
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    // Link first report (text base) to all others.
    const base = reportIds[0]
    for (let i = 1; i < reportIds.length; i++) {
      stmt.run(generateId(), base, reportIds[i], 'telegram_source', 0.6, `From Telegram message queue ${queueId.slice(0, 8)}`, now)
    }
  }
}

export const telegramIntelProcessor = new TelegramIntelProcessorImpl()
