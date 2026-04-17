import { ipcMain, BrowserWindow } from 'electron'
import log from 'electron-log'
import { getDatabase } from '../services/database'
import { darkWebSeedService } from '../services/darkweb/DarkWebSeedService'
import { darkWebEnrichmentService } from '../services/darkweb/DarkWebEnrichmentService'
import { onionCrawlerService } from '../services/darkweb/OnionCrawlerService'
import { matchesCsamDenylist } from '../services/darkweb/DefaultDarkWebSeeds'
import { toolRegistry } from '../services/tools/ToolRegistry'
import { torService } from '../services/darkweb/TorService'

/**
 * IPC bridge for the Dark Web Explorer page.
 *
 * Channels:
 *   - `darkweb:seeds_list`         → list of all seeds (filterable by category)
 *   - `darkweb:seeds_categories`   → distinct categories with counts
 *   - `darkweb:seeds_toggle`       → enable / disable a seed
 *   - `darkweb:seeds_add_custom`   → analyst-defined seed (CSAM-denylist scanned)
 *   - `darkweb:seeds_delete`
 *   - `darkweb:seeds_run`          → run a single seed
 *   - `darkweb:seeds_run_all`      → run every enabled seed (one job at a time)
 *   - `darkweb:seeds_cancel`       → request cancellation of the active job
 *   - `darkweb:seeds_status`       → current job state
 *
 *   - `darkweb:explorer_search`    → manual Ahmia search (no auto-store; the
 *                                    UI presents cards with "Add to intel" buttons)
 *   - `darkweb:add_from_search`    → fetch one onion URL + store + enrich
 *   - `darkweb:add_batch_from_search` → batched version
 *
 *   - `darkweb:enrich_all`         → enqueue every unenriched darkweb report
 *   - `darkweb:enrich_status`      → queue/inflight counters
 *   - `darkweb:enrich_one`         → manually enrich a single report
 *
 *   - `darkweb:hosts_health`       → list per-host fetch reliability
 *   - `darkweb:hosts_unquarantine` → un-quarantine a host
 *
 *   - `darkweb:tags_for_picker`    → top tags grouped by prefix (chat filter)
 *   - `darkweb:enrichment_summary` → IOC counts, top actors, etc. (Enrichment tab)
 *
 * Events (broadcast to renderer):
 *   - `darkweb:seed_progress`      → during seeds_run_all
 *   - `darkweb:enrich_progress`    → during enrichment queue drain
 */

function safeBroadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* */ }
  }
}

export function registerDarkWebExplorerBridge(): void {
  // Seed defaults are inserted on first boot (idempotent).
  try { darkWebSeedService.ensureSeeded() } catch (err) { log.warn(`darkweb seeder failed: ${err}`) }

  // ── Seeds management ─────────────────────────────────────────────────
  ipcMain.handle('darkweb:seeds_list', (_e, params: { category?: string } = {}) => {
    return darkWebSeedService.listSeeds(params.category)
  })
  ipcMain.handle('darkweb:seeds_categories', () => darkWebSeedService.listCategories())

  ipcMain.handle('darkweb:seeds_toggle', (_e, params: { id: string; enabled: boolean }) => {
    darkWebSeedService.toggle(params.id, params.enabled)
    return { ok: true }
  })

  ipcMain.handle('darkweb:seeds_add_custom', (_e, params: { category: string; query: string; description?: string }) => {
    return darkWebSeedService.addCustom(params)
  })

  ipcMain.handle('darkweb:seeds_delete', (_e, params: { id: string }) => {
    darkWebSeedService.delete(params.id)
    return { ok: true }
  })

  // ── Seed sweep job ───────────────────────────────────────────────────
  // Subscribe to progress + broadcast to renderer.
  darkWebSeedService.onProgress((p) => safeBroadcast('darkweb:seed_progress', p))

  ipcMain.handle('darkweb:seeds_run', async (_e, params: { id: string }) => {
    return darkWebSeedService.runSeed(params.id)
  })
  ipcMain.handle('darkweb:seeds_run_all', async () => darkWebSeedService.runAllEnabled())
  ipcMain.handle('darkweb:seeds_cancel', () => ({ ok: darkWebSeedService.cancelActive() }))
  ipcMain.handle('darkweb:seeds_status', () => darkWebSeedService.getActiveJob())

  // ── Custom search (no auto-store) ────────────────────────────────────
  ipcMain.handle('darkweb:explorer_search', async (_e, params: { query: string; limit?: number }) => {
    const query = (params.query || '').trim()
    if (!query) return { ok: false, reason: 'empty_query' }
    if (matchesCsamDenylist(query)) {
      return { ok: false, reason: 'csam_denylist', message: 'Query rejected by CSAM safety policy.' }
    }
    const r = await toolRegistry.execute('ahmia_search', { query, limit: params.limit ?? 15 })
    if (r.error) return { ok: false, reason: r.error, message: r.output }
    return { ok: true, hits: r.data ?? [], output: r.output }
  })

  ipcMain.handle('darkweb:add_from_search', async (_e, params: { url: string; sourceQuery?: string }) => {
    const torState = torService.getState()
    if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
      return { ok: false, reason: 'tor_not_connected' }
    }
    const r = await toolRegistry.execute('onion_fetch', { url: params.url, max_chars: 4000 })
    if (r.error) return { ok: false, reason: r.error, message: r.output }
    const data = r.data as { hostname?: string; text?: string } | undefined
    if (!data?.text) return { ok: false, reason: 'empty_response' }
    try {
      const reportId = await storeAddedFromSearch(params.url, data.hostname || extractHostname(params.url) || 'unknown', data.text, params.sourceQuery)
      if (reportId) {
        // Enqueue enrichment + crawl; don't block.
        darkWebEnrichmentService.enqueue(reportId)
        try {
          const { onionCrawlerService } = await import('../services/darkweb/OnionCrawlerService')
          onionCrawlerService.enqueue(reportId)
        } catch { /* */ }
      }
      return { ok: true, reportId }
    } catch (err) {
      return { ok: false, reason: 'store_failed', message: String(err) }
    }
  })

  ipcMain.handle('darkweb:add_batch_from_search', async (_e, params: { urls: string[]; sourceQuery?: string }) => {
    const torState = torService.getState()
    if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
      return { ok: false, reason: 'tor_not_connected' }
    }
    const results = await Promise.allSettled((params.urls || []).map(async (url) => {
      const r = await toolRegistry.execute('onion_fetch', { url, max_chars: 4000 })
      if (r.error) return { url, ok: false, reason: r.error }
      const data = r.data as { hostname?: string; text?: string } | undefined
      if (!data?.text) return { url, ok: false, reason: 'empty_response' }
      const reportId = await storeAddedFromSearch(url, data.hostname || extractHostname(url) || 'unknown', data.text, params.sourceQuery)
      if (reportId) darkWebEnrichmentService.enqueue(reportId)
      return { url, ok: !!reportId, reportId }
    }))
    const out = results.map((r) => r.status === 'fulfilled' ? r.value : { ok: false, reason: 'rejected' })
    const stored = out.filter((r) => r.ok).length
    const failed = out.length - stored
    return { ok: true, stored, failed, results: out }
  })

  // ── Enrichment management ────────────────────────────────────────────
  darkWebEnrichmentService.onStatus((s) => safeBroadcast('darkweb:enrich_progress', s))

  ipcMain.handle('darkweb:enrich_all', () => darkWebEnrichmentService.enqueueUnenriched())
  ipcMain.handle('darkweb:enrich_status', () => darkWebEnrichmentService.getStatus())
  ipcMain.handle('darkweb:enrich_one', async (_e, params: { reportId: string }) => {
    const r = await darkWebEnrichmentService.enrichOne(params.reportId)
    return { ok: !!r, result: r }
  })

  // ── Host health (stale-onion pruner) ─────────────────────────────────
  ipcMain.handle('darkweb:hosts_health', (_e, params: { quarantinedOnly?: boolean; limit?: number } = {}) => {
    return darkWebSeedService.listHostHealth(params)
  })
  ipcMain.handle('darkweb:hosts_unquarantine', (_e, params: { hostname: string }) => {
    darkWebSeedService.unquarantineHost(params.hostname)
    return { ok: true }
  })

  // ── Aggregates for Enrichment tab + chat picker ──────────────────────
  ipcMain.handle('darkweb:enrichment_summary', () => {
    return {
      counts: darkWebEnrichmentService.getCounts(),
      iocs: darkWebEnrichmentService.getIocSummary(),
      topActors: darkWebEnrichmentService.getTopTags({ prefix: 'actor:', limit: 30 }),
      topMarketplaces: darkWebEnrichmentService.getTopTags({ prefix: 'marketplace:', limit: 20 }),
      topVictims: darkWebEnrichmentService.getTopTags({ prefix: 'victim:', limit: 30 }),
      topActivities: darkWebEnrichmentService.getTopTags({ prefix: 'darkweb:', limit: 20 }),
      topTech: darkWebEnrichmentService.getTopTags({ prefix: 'tech:', limit: 30 })
    }
  })

  ipcMain.handle('darkweb:tags_for_picker', (_e, params: { prefix?: string; limit?: number } = {}) => {
    return darkWebEnrichmentService.getTopTags(params)
  })

  // ── Dark-web network graph data ───────────────────────────────────────
  ipcMain.handle('darkweb:graph_data', () => {
    const db = getDatabase()
    // Nodes: every [DARKWEB] report that is either a source or target
    // of an onion_crossref link, plus any that have a threat tag.
    const nodeRows = db.prepare(`
      SELECT DISTINCT r.id, r.title, r.source_url, r.source_name, r.severity,
             r.verification_score, r.created_at
      FROM intel_reports r
      WHERE r.title LIKE '[DARKWEB]%'
        AND (
          EXISTS (SELECT 1 FROM intel_links l WHERE l.source_report_id = r.id AND l.link_type = 'onion_crossref')
          OR EXISTS (SELECT 1 FROM intel_links l WHERE l.target_report_id = r.id AND l.link_type = 'onion_crossref')
        )
      LIMIT 500
    `).all() as Array<Record<string, unknown>>

    // Also include isolated [DARKWEB] nodes with threat >= 7 (high) even
    // if they have no crossref links — they're important standalone.
    const highThreatRows = db.prepare(`
      SELECT DISTINCT r.id, r.title, r.source_url, r.source_name, r.severity,
             r.verification_score, r.created_at
      FROM intel_reports r
      WHERE r.title LIKE '[DARKWEB]%'
        AND r.severity IN ('high', 'critical')
        AND r.id NOT IN (${nodeRows.map(() => '?').join(',') || "''"})
      LIMIT 100
    `).all(...nodeRows.map((n) => n.id)) as Array<Record<string, unknown>>

    const allNodeRows = [...nodeRows, ...highThreatRows]
    const nodeIds = new Set(allNodeRows.map((n) => n.id as string))

    // Fetch tags for all nodes in one query (threat score + actor tags).
    const tagMap = new Map<string, { threatScore: number | null; threatLabel: string | null; actors: string[]; activities: string[]; crawlDepth: number | null }>()
    if (nodeIds.size > 0) {
      const placeholders = Array.from(nodeIds).map(() => '?').join(',')
      const tagRows = db.prepare(
        `SELECT report_id, tag FROM intel_tags WHERE report_id IN (${placeholders}) AND source = 'darkweb-enrich'`
      ).all(...Array.from(nodeIds)) as Array<{ report_id: string; tag: string }>

      const crawlTags = db.prepare(
        `SELECT report_id, tag FROM intel_tags WHERE report_id IN (${placeholders}) AND tag LIKE 'crawl-depth:%'`
      ).all(...Array.from(nodeIds)) as Array<{ report_id: string; tag: string }>

      for (const id of nodeIds) {
        tagMap.set(id, { threatScore: null, threatLabel: null, actors: [], activities: [], crawlDepth: null })
      }
      for (const t of tagRows) {
        const entry = tagMap.get(t.report_id)
        if (!entry) continue
        const threatMatch = t.tag.match(/^threat:(\d+)-(\w+)$/)
        if (threatMatch) {
          entry.threatScore = parseInt(threatMatch[1], 10)
          entry.threatLabel = threatMatch[2]
        }
        if (t.tag.startsWith('actor:')) entry.actors.push(t.tag.replace('actor:', ''))
        if (t.tag.startsWith('darkweb:')) entry.activities.push(t.tag.replace('darkweb:', ''))
      }
      for (const t of crawlTags) {
        const entry = tagMap.get(t.report_id)
        if (entry) {
          const d = parseInt(t.tag.replace('crawl-depth:', ''), 10)
          if (!isNaN(d)) entry.crawlDepth = d
        }
      }
    }

    // Extract hostname from source_url for display.
    const hostname = (url: string | null): string => {
      if (!url) return 'unknown'
      try { return new URL(url).hostname } catch { return 'unknown' }
    }

    const nodes = allNodeRows.map((r) => {
      const meta = tagMap.get(r.id as string)
      return {
        id: r.id as string,
        label: hostname(r.source_url as string | null),
        title: (r.title as string).replace('[DARKWEB] ', ''),
        sourceUrl: r.source_url as string | null,
        severity: r.severity as string,
        threatScore: meta?.threatScore ?? null,
        threatLabel: meta?.threatLabel ?? null,
        actors: meta?.actors ?? [],
        activities: meta?.activities ?? [],
        crawlDepth: meta?.crawlDepth,
        createdAt: r.created_at as number
      }
    })

    // Edges: onion_crossref links between nodes in our set.
    const edges = nodeIds.size > 0
      ? (db.prepare(`
          SELECT id, source_report_id, target_report_id, strength, reason, created_at
          FROM intel_links
          WHERE link_type = 'onion_crossref'
            AND source_report_id IN (${Array.from(nodeIds).map(() => '?').join(',')})
          LIMIT 2000
        `).all(...Array.from(nodeIds)) as Array<Record<string, unknown>>)
          .filter((e) => nodeIds.has(e.target_report_id as string))
          .map((e) => ({
            id: e.id as string,
            source: e.source_report_id as string,
            target: e.target_report_id as string,
            strength: e.strength as number,
            reason: e.reason as string | null,
            createdAt: e.created_at as number
          }))
      : []

    return { nodes, edges }
  })

  // ── Onion link crawler ────────────────────────────────────────────────
  onionCrawlerService.onStatus((s) => safeBroadcast('darkweb:crawl_progress', s))

  ipcMain.handle('darkweb:crawler_status', () => onionCrawlerService.getStatus())
  ipcMain.handle('darkweb:crawler_toggle', (_e, params: { enabled: boolean }) => {
    onionCrawlerService.setEnabled(params.enabled)
    return { ok: true, enabled: params.enabled }
  })
  ipcMain.handle('darkweb:crawler_reset_visited', () => {
    onionCrawlerService.resetVisited()
    return { ok: true }
  })

  log.info('Dark-web Explorer bridge registered')
}

function extractHostname(url: string): string | null {
  try { return new URL(url).hostname } catch { return null }
}

/** Insert an added-from-search onion page as [DARKWEB] intel report.
 *  Tagged with `darkweb`, `chat-discovery`, and (if provided) the source
 *  query for pivot. Idempotent on content_hash. */
async function storeAddedFromSearch(
  url: string,
  hostname: string,
  text: string,
  sourceQuery?: string
): Promise<string | null> {
  const { getDatabase } = await import('../services/database')
  const { generateId, timestamp } = await import('@common/utils/id')
  const { createHash } = await import('crypto')
  const db = getDatabase()
  const now = timestamp()
  const trimmed = text.slice(0, 8000)
  const hash = createHash('sha256').update(url + '|' + trimmed).digest('hex')
  const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE intel_reports SET updated_at = ? WHERE id = ?').run(now, existing.id)
    return existing.id
  }
  const id = generateId()
  const title = `[DARKWEB] ${hostname}`.slice(0, 200)
  const summary = trimmed.slice(0, 240).replace(/\s+/g, ' ').trim()
  const sourceLine = sourceQuery ? `**Source query** (Explorer manual add): "${sourceQuery}"` : '**Source**: Explorer manual add'
  const content = `${sourceLine}\n**Onion URL**: ${url}\n**Fetched at**: ${new Date(now).toISOString()}\n\n---\n\n${trimmed}`
  db.prepare(
    'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'osint', title, content, summary, 'medium', 'darkweb-explorer', `Onion: ${hostname}`, url, hash, 40, 0, now, now)
  const tags = ['darkweb', 'onion-fetch', 'chat-discovery']
  if (sourceQuery) {
    const queryTag = 'query:' + sourceQuery.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '')
    if (queryTag.length > 6) tags.push(queryTag)
  }
  const tagStmt = db.prepare(
    'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  for (const t of tags) {
    try { tagStmt.run(id, t, 1.0, 'darkweb-explorer', now) } catch { /* */ }
  }
  return id
}
