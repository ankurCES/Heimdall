import { ipcMain, BrowserWindow } from 'electron'
import log from 'electron-log'
import { getDatabase } from '../services/database'
import { toolRegistry } from '../services/tools/ToolRegistry'
import { torService } from '../services/darkweb/TorService'

/**
 * Dark-web intel bridge.
 *
 * Channels:
 *   - `darkweb:list`           → paginated list of [DARKWEB] intel reports
 *                                 with their tags and any siblings (other
 *                                 reports from the same hostname).
 *   - `darkweb:hosts`          → distinct .onion hostnames + report counts.
 *   - `darkweb:refresh_all`    → fire-and-forget refresh of every unique
 *                                 .onion URL referenced in intel. Streams
 *                                 progress via `darkweb:refresh_progress`
 *                                 and ends with `darkweb:refresh_complete`.
 *   - `darkweb:refresh_status` → poll for the current refresh job (so the
 *                                 UI can resume the live view after
 *                                 navigating away).
 *   - `darkweb:tor_status`     → quick passthrough of TorService.getState()
 *                                 so the page can show a "Tor connected"
 *                                 indicator without importing the tor bridge.
 *
 * Refresh job semantics:
 *   - One concurrent job at a time. Subsequent calls return the existing
 *     job id so the UI can attach to it.
 *   - 4-way parallelism, 30 s per fetch (matches onion_fetch tool defaults).
 *   - Each successful fetch is INSERTed via the same path as
 *     onion_fetch — content_hash dedupe means identical bodies are
 *     skipped silently, so refreshing a static page doesn't bloat intel.
 *   - Onion hosts that are dead are tracked separately and reported back
 *     so the analyst can decide whether to delete the stale rows.
 */

interface DarkWebReport {
  id: string
  title: string
  source_url: string | null
  source_name: string
  hostname: string | null
  body_chars: number
  verification_score: number
  created_at: number
  updated_at: number
  tags: string[]
}

interface RefreshJob {
  id: string
  startedAt: number
  finishedAt: number | null
  total: number
  done: number
  succeeded: number
  failed: number
  skippedDuplicate: number
  status: 'running' | 'completed' | 'cancelled' | 'error'
  lastError: string | null
}

let activeJob: RefreshJob | null = null

function safeBroadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* ignored */ }
  }
}

function extractHostname(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.hostname.endsWith('.onion') ? u.hostname : null
  } catch {
    return null
  }
}

export function registerDarkWebBridge(): void {
  // ── List dark-web reports ────────────────────────────────────────────
  ipcMain.handle('darkweb:list', (_event, params: {
    limit?: number
    offset?: number
    hostname?: string
    queryTag?: string
    search?: string
  } = {}) => {
    const db = getDatabase()
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500)
    const offset = Math.max(params.offset ?? 0, 0)

    const conditions: string[] = [
      // The defining marker — we store dark-web rows with the [DARKWEB] title
      // prefix from BOTH the cron AhmiaCollector and the chat-time
      // onion_fetch path. Matching on title is more reliable than a tag
      // join because cron-stored rows may not always carry the tag.
      "(r.title LIKE '[DARKWEB]%')"
    ]
    const args: unknown[] = []
    if (params.hostname) {
      conditions.push("(r.source_url LIKE ? OR r.title LIKE ?)")
      args.push(`%${params.hostname}%`, `%${params.hostname}%`)
    }
    if (params.queryTag) {
      conditions.push("EXISTS (SELECT 1 FROM intel_tags t WHERE t.report_id = r.id AND t.tag = ?)")
      args.push(params.queryTag.startsWith('query:') ? params.queryTag : `query:${params.queryTag}`)
    }
    if (params.search) {
      conditions.push("(LOWER(r.title) LIKE ? OR LOWER(r.content) LIKE ?)")
      const s = `%${params.search.toLowerCase()}%`
      args.push(s, s)
    }
    const where = conditions.join(' AND ')
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM intel_reports r WHERE ${where}`).get(...args) as { c: number }

    const rows = db.prepare(`
      SELECT r.id, r.title, r.source_url, r.source_name, length(r.content) AS body_chars,
             r.verification_score, r.created_at, r.updated_at
      FROM intel_reports r
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as Array<{
      id: string; title: string; source_url: string | null; source_name: string
      body_chars: number; verification_score: number; created_at: number; updated_at: number
    }>

    // Bulk-fetch tags for all returned reports in one query.
    const tagMap = new Map<string, string[]>()
    if (rows.length > 0) {
      const placeholders = rows.map(() => '?').join(',')
      const tagRows = db.prepare(
        `SELECT report_id, tag FROM intel_tags WHERE report_id IN (${placeholders})`
      ).all(...rows.map((r) => r.id)) as Array<{ report_id: string; tag: string }>
      for (const t of tagRows) {
        const arr = tagMap.get(t.report_id) ?? []
        arr.push(t.tag)
        tagMap.set(t.report_id, arr)
      }
    }

    const results: DarkWebReport[] = rows.map((r) => ({
      ...r,
      hostname: extractHostname(r.source_url),
      tags: tagMap.get(r.id) ?? []
    }))

    return { total: totalRow.c, items: results, limit, offset }
  })

  // ── Single report content (for the expand-row view) ──────────────────
  ipcMain.handle('darkweb:get_content', (_event, params: { id: string }) => {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT id, title, content, source_url, source_name, created_at, updated_at, verification_score FROM intel_reports WHERE id = ?'
    ).get(params.id) as Record<string, unknown> | undefined
    if (!row) return null
    const tags = (db.prepare('SELECT tag FROM intel_tags WHERE report_id = ?').all(params.id) as Array<{ tag: string }>).map((t) => t.tag)
    return { ...row, tags }
  })

  // ── Distinct onion hostnames + counts ────────────────────────────────
  ipcMain.handle('darkweb:hosts', () => {
    const db = getDatabase()
    // Hosts come from source_url. We also count rows so the UI can show
    // "4 reports from this hostname."
    const rows = db.prepare(`
      SELECT source_url, COUNT(*) AS report_count, MAX(created_at) AS last_seen
      FROM intel_reports
      WHERE title LIKE '[DARKWEB]%' AND source_url LIKE '%.onion%'
      GROUP BY source_url
      ORDER BY last_seen DESC
    `).all() as Array<{ source_url: string; report_count: number; last_seen: number }>

    // Aggregate by hostname (multiple URL paths share one hostname).
    const byHost = new Map<string, { hostname: string; urls: string[]; reportCount: number; lastSeen: number }>()
    for (const r of rows) {
      const host = extractHostname(r.source_url)
      if (!host) continue
      const existing = byHost.get(host)
      if (existing) {
        existing.urls.push(r.source_url)
        existing.reportCount += r.report_count
        if (r.last_seen > existing.lastSeen) existing.lastSeen = r.last_seen
      } else {
        byHost.set(host, { hostname: host, urls: [r.source_url], reportCount: r.report_count, lastSeen: r.last_seen })
      }
    }
    return Array.from(byHost.values()).sort((a, b) => b.lastSeen - a.lastSeen)
  })

  // ── Refresh all onion URLs ───────────────────────────────────────────
  ipcMain.handle('darkweb:refresh_all', async (_event, params: { hostnameFilter?: string } = {}) => {
    if (activeJob && activeJob.status === 'running') {
      return { ok: false, reason: 'already_running', job: activeJob }
    }
    const torState = torService.getState()
    if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
      return { ok: false, reason: 'tor_not_connected', message: `Tor not connected (status: ${torState.status}). Open Settings → Dark Web → "Connect to Tor" before refreshing.` }
    }

    const db = getDatabase()
    // Distinct onion URLs from every [DARKWEB] row. If a hostname filter is
    // supplied, restrict to URLs on that host.
    let rows: Array<{ source_url: string }>
    if (params.hostnameFilter) {
      rows = db.prepare(
        "SELECT DISTINCT source_url FROM intel_reports WHERE title LIKE '[DARKWEB]%' AND source_url LIKE ?"
      ).all(`%${params.hostnameFilter}%`) as Array<{ source_url: string }>
    } else {
      rows = db.prepare(
        "SELECT DISTINCT source_url FROM intel_reports WHERE title LIKE '[DARKWEB]%' AND source_url LIKE '%.onion%'"
      ).all() as Array<{ source_url: string }>
    }
    const urls = rows.map((r) => r.source_url).filter((u) => u && u.includes('.onion'))
    if (urls.length === 0) {
      return { ok: false, reason: 'no_urls', message: 'No .onion URLs found in stored intel to refresh.' }
    }

    const job: RefreshJob = {
      id: `refresh-${Date.now()}`,
      startedAt: Date.now(),
      finishedAt: null,
      total: urls.length,
      done: 0,
      succeeded: 0,
      failed: 0,
      skippedDuplicate: 0,
      status: 'running',
      lastError: null
    }
    activeJob = job
    safeBroadcast('darkweb:refresh_progress', { ...job })
    log.info(`darkweb: refresh_all started (${urls.length} URLs)`)

    // Fire-and-forget loop. Errors do not throw out of the IPC handler;
    // they're reported via the job state + progress events.
    void (async () => {
      const PARALLELISM = 4
      try {
        for (let i = 0; i < urls.length; i += PARALLELISM) {
          if (job.status === 'cancelled') break
          const batch = urls.slice(i, i + PARALLELISM)
          await Promise.allSettled(batch.map(async (url) => {
            try {
              const r = await toolRegistry.execute('onion_fetch', { url, max_chars: 4000 })
              if (r.error) {
                job.failed++
              } else {
                // The tool itself doesn't store — it only returns. Persist
                // here using the same shape onion_fetch's auto-storage path
                // uses. content_hash dedupe handles unchanged content.
                const stored = await persistOnionRefresh(url, r.data as { hostname: string; text: string } | undefined)
                if (stored === 'duplicate') job.skippedDuplicate++
                else if (stored) job.succeeded++
                else job.failed++
              }
            } catch (err) {
              job.failed++
              job.lastError = String(err).slice(0, 240)
            } finally {
              job.done++
              // Throttle progress emits to avoid flooding the renderer.
              if (job.done % 2 === 0 || job.done === job.total) {
                safeBroadcast('darkweb:refresh_progress', { ...job })
              }
            }
          }))
        }
        job.status = job.status === 'cancelled' ? 'cancelled' : 'completed'
      } catch (err) {
        job.status = 'error'
        job.lastError = String(err).slice(0, 240)
      } finally {
        job.finishedAt = Date.now()
        safeBroadcast('darkweb:refresh_progress', { ...job })
        safeBroadcast('darkweb:refresh_complete', { ...job })
        log.info(`darkweb: refresh_all ${job.status} — ${job.succeeded} new, ${job.skippedDuplicate} unchanged, ${job.failed} failed of ${job.total}`)
      }
    })()

    return { ok: true, job: { ...job } }
  })

  ipcMain.handle('darkweb:refresh_status', () => activeJob ? { ...activeJob } : null)

  ipcMain.handle('darkweb:cancel_refresh', () => {
    if (activeJob && activeJob.status === 'running') {
      activeJob.status = 'cancelled'
      return { ok: true }
    }
    return { ok: false, reason: 'no_active_job' }
  })

  ipcMain.handle('darkweb:tor_status', () => torService.getState())

  log.info('Dark-web bridge registered')
}

/**
 * Persist a refreshed onion fetch as an intel_report. Returns:
 *   - 'new'        — inserted a fresh row
 *   - 'duplicate'  — content_hash collided with an existing row, skipped
 *   - false/null   — couldn't store (missing data)
 */
async function persistOnionRefresh(
  url: string,
  data: { hostname: string; text: string } | undefined
): Promise<'new' | 'duplicate' | false> {
  if (!data || !data.text) return false
  const { getDatabase } = await import('../services/database')
  const { generateId, timestamp } = await import('@common/utils/id')
  const { createHash } = await import('crypto')
  const db = getDatabase()
  const now = timestamp()
  const trimmed = data.text.slice(0, 8000)
  const hash = createHash('sha256').update(url + '|' + trimmed).digest('hex')

  const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
  if (existing) {
    // Bump updated_at so the analyst can see "last refreshed at" — even
    // though we didn't write fresh content. Helps "stale host" detection.
    db.prepare('UPDATE intel_reports SET updated_at = ? WHERE id = ?').run(now, existing.id)
    return 'duplicate'
  }

  const id = generateId()
  const title = `[DARKWEB] ${data.hostname}`.slice(0, 200)
  const summary = trimmed.slice(0, 240).replace(/\s+/g, ' ').trim()
  const content = `**Source**: refresh sweep (darkweb:refresh_all)\n**Onion URL**: ${url}\n**Refreshed at**: ${new Date(now).toISOString()}\n\n---\n\n${trimmed}`

  db.prepare(
    'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'osint', title, content, summary, 'medium', 'darkweb-refresh', `Onion: ${data.hostname}`, url, hash, 40, 0, now, now)

  const tags = ['darkweb', 'onion-fetch', 'darkweb-refresh']
  const tagStmt = db.prepare(
    'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  for (const tag of tags) {
    try { tagStmt.run(id, tag, 1.0, 'darkweb-refresh', now) } catch { /* tag schema may differ — degrade gracefully */ }
  }
  // Fire-and-forget enrichment + crawl.
  try {
    const { darkWebEnrichmentService } = await import('../services/darkweb/DarkWebEnrichmentService')
    darkWebEnrichmentService.enqueue(id)
  } catch (err) {
    log.debug(`darkwebBridge: enrichment queue failed for ${id}: ${err}`)
  }
  try {
    const { onionCrawlerService } = await import('../services/darkweb/OnionCrawlerService')
    onionCrawlerService.enqueue(id)
  } catch (err) {
    log.debug(`darkwebBridge: crawler queue failed for ${id}: ${err}`)
  }
  return 'new'
}
