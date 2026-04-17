import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { toolRegistry } from '../tools/ToolRegistry'
import { torService } from './TorService'
import { auditService } from '../audit/AuditService'
import { DEFAULT_DARKWEB_SEEDS, matchesCsamDenylist } from './DefaultDarkWebSeeds'
import log from 'electron-log'

/**
 * Manages the dark-web seed list (curated + custom queries) and runs them
 * against Ahmia → onion_fetch → store → enrich.
 *
 * Lifecycle:
 *   - On boot, idempotently seeds DEFAULT_DARKWEB_SEEDS if the table is empty.
 *   - listSeeds(category?)    → for the Explorer UI
 *   - runSeed(id, onProgress) → ahmia_search → onion_fetch each → store → enrich
 *   - runAllEnabled(onProgress) → loops every enabled seed sequentially
 *   - addCustom / toggle / delete
 *
 * Host-health tracking: every successful or failed onion fetch is recorded
 * in darkweb_host_health. After 5 consecutive failures the hostname is
 * quarantined and excluded from future seed runs (analyst can manually
 * un-quarantine via Explorer UI).
 */

export interface DarkWebSeed {
  id: string
  category: string
  query: string
  description: string | null
  enabled: boolean
  isCustom: boolean
  lastRunAt: number | null
  lastError: string | null
  hitCount: number
  createdAt: number
}

export interface SeedRunProgress {
  jobId: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  startedAt: number
  finishedAt: number | null
  totalSeeds: number
  doneSeeds: number
  currentSeed: { id: string; category: string; query: string } | null
  totalHits: number
  storedReports: number
  failedFetches: number
  skippedQuarantined: number
  lastError: string | null
}

export interface HostHealth {
  hostname: string
  consecutiveFailures: number
  totalFailures: number
  totalSuccesses: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  quarantined: boolean
  quarantinedAt: number | null
  updatedAt: number
}

const QUARANTINE_THRESHOLD = 5

class DarkWebSeedServiceImpl {
  private activeJob: SeedRunProgress | null = null
  private cancelRequested = false
  private progressListeners = new Set<(p: SeedRunProgress) => void>()

  /** Seed the table with DEFAULT_DARKWEB_SEEDS if empty. Idempotent. */
  ensureSeeded(): void {
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) AS c FROM darkweb_seeds').get() as { c: number }).c
    if (count > 0) return
    const insert = db.prepare(
      'INSERT OR IGNORE INTO darkweb_seeds (id, category, query, description, enabled, is_custom, hit_count, created_at) VALUES (?, ?, ?, ?, 1, 0, 0, ?)'
    )
    const now = timestamp()
    const tx = db.transaction(() => {
      for (const s of DEFAULT_DARKWEB_SEEDS) {
        insert.run(generateId(), s.category, s.query, s.description, now)
      }
    })
    tx()
    log.info(`DarkWebSeedService: seeded ${DEFAULT_DARKWEB_SEEDS.length} default queries`)
  }

  listSeeds(category?: string): DarkWebSeed[] {
    const db = getDatabase()
    const sql = category
      ? 'SELECT * FROM darkweb_seeds WHERE category = ? ORDER BY enabled DESC, category, query'
      : 'SELECT * FROM darkweb_seeds ORDER BY enabled DESC, category, query'
    const rows = (category ? db.prepare(sql).all(category) : db.prepare(sql).all()) as Array<Record<string, unknown>>
    return rows.map(this.mapSeed)
  }

  listCategories(): Array<{ category: string; count: number; enabledCount: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT category, COUNT(*) AS count, SUM(enabled) AS enabledCount
      FROM darkweb_seeds GROUP BY category ORDER BY category
    `).all() as Array<{ category: string; count: number; enabledCount: number }>
  }

  toggle(id: string, enabled: boolean): void {
    const db = getDatabase()
    db.prepare('UPDATE darkweb_seeds SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  /**
   * Add a custom seed. Returns `{ ok, id?, reason? }`.
   *
   * Rejects:
   *   - Empty query/category
   *   - Query matching CSAM denylist (audit-logged)
   *   - Duplicate (category, query) — UNIQUE constraint
   */
  addCustom(input: { category: string; query: string; description?: string }): { ok: boolean; id?: string; reason?: string } {
    const category = (input.category || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)
    const query = (input.query || '').trim()
    if (!category || !query) return { ok: false, reason: 'empty_field' }
    if (query.length > 200) return { ok: false, reason: 'query_too_long' }

    if (matchesCsamDenylist(query)) {
      auditService.log('darkweb.seed.blocked_csam', { category, query })
      return { ok: false, reason: 'csam_denylist', message: 'Query rejected by CSAM safety policy.' } as { ok: false; reason: string }
    }

    const db = getDatabase()
    const id = generateId()
    try {
      db.prepare(
        'INSERT INTO darkweb_seeds (id, category, query, description, enabled, is_custom, hit_count, created_at) VALUES (?, ?, ?, ?, 1, 1, 0, ?)'
      ).run(id, category, query, input.description?.slice(0, 240) || null, timestamp())
      auditService.log('darkweb.seed.added', { category, query, id })
      return { ok: true, id }
    } catch (err) {
      if (String(err).includes('UNIQUE')) return { ok: false, reason: 'duplicate' }
      log.warn(`DarkWebSeedService.addCustom failed: ${err}`)
      return { ok: false, reason: 'db_error' }
    }
  }

  /** Delete a seed. Default seeds (is_custom=0) are deletable too — if the
   *  analyst regrets it, they can re-add via "+ Custom seed" with the same
   *  query (the entry just becomes is_custom=1). */
  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM darkweb_seeds WHERE id = ?').run(id)
  }

  /**
   * Subscribe to progress events for the active run job. Listener is
   * called for each progress update; auto-removed when job completes.
   */
  onProgress(listener: (p: SeedRunProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  getActiveJob(): SeedRunProgress | null {
    return this.activeJob ? { ...this.activeJob } : null
  }

  cancelActive(): boolean {
    if (this.activeJob && this.activeJob.status === 'running') {
      this.cancelRequested = true
      return true
    }
    return false
  }

  /**
   * Run a single seed end-to-end:
   *   1. ahmia_search(seed.query)
   *   2. For each returned onion URL not in a quarantined host, onion_fetch
   *   3. The onion_fetch tool's auto-store path persists each as [DARKWEB]
   *      intel; the enrichment service hook (registered separately) auto-
   *      enriches each new report.
   *   4. Update darkweb_seeds.hit_count + last_run_at, plus per-host health.
   */
  async runSeed(id: string): Promise<{ ok: boolean; hits: number; stored: number; failed: number; reason?: string }> {
    const db = getDatabase()
    const seed = (db.prepare('SELECT * FROM darkweb_seeds WHERE id = ?').get(id) as Record<string, unknown> | undefined)
    if (!seed) return { ok: false, hits: 0, stored: 0, failed: 0, reason: 'not_found' }
    if (!seed.enabled) return { ok: false, hits: 0, stored: 0, failed: 0, reason: 'disabled' }

    const torState = torService.getState()
    if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
      return { ok: false, hits: 0, stored: 0, failed: 0, reason: 'tor_not_connected' }
    }

    return this.executeOneSeed(this.mapSeed(seed))
  }

  /**
   * Run every enabled seed sequentially. Streams progress via the
   * `onProgress` listeners. One job at a time — concurrent calls return
   * a reference to the existing job rather than starting a new one.
   */
  async runAllEnabled(): Promise<{ ok: boolean; jobId?: string; reason?: string }> {
    if (this.activeJob && this.activeJob.status === 'running') {
      return { ok: false, reason: 'already_running', jobId: this.activeJob.jobId }
    }
    const torState = torService.getState()
    if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
      return { ok: false, reason: 'tor_not_connected' }
    }

    const db = getDatabase()
    const seeds = db.prepare('SELECT * FROM darkweb_seeds WHERE enabled = 1 ORDER BY category, query').all() as Array<Record<string, unknown>>
    if (seeds.length === 0) return { ok: false, reason: 'no_enabled_seeds' }

    const job: SeedRunProgress = {
      jobId: `seedrun-${Date.now()}`,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      totalSeeds: seeds.length,
      doneSeeds: 0,
      currentSeed: null,
      totalHits: 0,
      storedReports: 0,
      failedFetches: 0,
      skippedQuarantined: 0,
      lastError: null
    }
    this.activeJob = job
    this.cancelRequested = false
    this.emitProgress()

    auditService.log('darkweb.seedrun.start', { jobId: job.jobId, totalSeeds: seeds.length })

    void (async () => {
      try {
        for (const raw of seeds) {
          if (this.cancelRequested) break
          const seed = this.mapSeed(raw)
          job.currentSeed = { id: seed.id, category: seed.category, query: seed.query }
          this.emitProgress()

          const r = await this.executeOneSeed(seed)
          job.totalHits += r.hits
          job.storedReports += r.stored
          job.failedFetches += r.failed
          job.skippedQuarantined += r.quarantinedSkipped ?? 0
          if (r.reason && r.reason !== 'disabled') job.lastError = r.reason
          job.doneSeeds++
          this.emitProgress()
        }
        job.status = this.cancelRequested ? 'cancelled' : 'completed'
      } catch (err) {
        job.status = 'error'
        job.lastError = String(err).slice(0, 240)
      } finally {
        job.finishedAt = Date.now()
        job.currentSeed = null
        this.emitProgress()
        auditService.log('darkweb.seedrun.end', {
          jobId: job.jobId, status: job.status, doneSeeds: job.doneSeeds,
          totalHits: job.totalHits, storedReports: job.storedReports
        })
        log.info(`DarkWebSeedService: runAllEnabled ${job.status} — ${job.doneSeeds}/${job.totalSeeds} seeds, ${job.storedReports} reports stored, ${job.failedFetches} failed`)
      }
    })()

    return { ok: true, jobId: job.jobId }
  }

  private async executeOneSeed(seed: DarkWebSeed): Promise<{
    ok: boolean; hits: number; stored: number; failed: number; quarantinedSkipped?: number; reason?: string
  }> {
    const db = getDatabase()
    let hits = 0
    let stored = 0
    let failed = 0
    let quarantinedSkipped = 0

    // 1. Ahmia search
    const ahmia = await toolRegistry.execute('ahmia_search', { query: seed.query, limit: 12 })
    if (ahmia.error) {
      this.recordSeedRun(seed.id, 0, ahmia.error)
      return { ok: false, hits: 0, stored: 0, failed: 0, reason: ahmia.error }
    }
    const ahmiaHits = (Array.isArray(ahmia.data) ? ahmia.data : []) as Array<{ onionUrl?: string; title?: string }>
    hits = ahmiaHits.length

    // 2. Filter out quarantined hosts
    const quarantinedHosts = new Set(
      (db.prepare('SELECT hostname FROM darkweb_host_health WHERE quarantined = 1').all() as Array<{ hostname: string }>).map((r) => r.hostname)
    )
    const fetchTargets = ahmiaHits
      .map((h) => h.onionUrl)
      .filter((u): u is string => !!u && /^https?:\/\/[a-z2-7]{16,56}\.onion/i.test(u))
      .filter((u) => {
        try {
          const host = new URL(u).hostname
          if (quarantinedHosts.has(host)) { quarantinedSkipped++; return false }
          return true
        } catch { return false }
      })
      .slice(0, 5) // cap per seed

    // 3. Fetch + the onion_fetch tool's caller (orchestrator path) handles
    //    storage. For seed sweeps we replicate the storage + health-tracking
    //    inline so we can attribute reports to the seed.
    for (const url of fetchTargets) {
      const r = await toolRegistry.execute('onion_fetch', { url, max_chars: 4000 })
      const host = (() => { try { return new URL(url).hostname } catch { return null } })()
      if (!host) { failed++; continue }
      if (r.error) {
        failed++
        this.recordHostFailure(host, r.error)
        continue
      }
      this.recordHostSuccess(host)
      const data = r.data as { hostname?: string; text?: string } | undefined
      if (!data?.text) { failed++; continue }
      try {
        const reportId = await this.storeSeedHit(seed, url, data.hostname || host, data.text)
        if (reportId) stored++
      } catch (err) {
        failed++
        log.warn(`DarkWebSeedService: store failed for ${url}: ${err}`)
      }
    }

    this.recordSeedRun(seed.id, hits, null)
    return { ok: true, hits, stored, failed, quarantinedSkipped }
  }

  /** Insert a seed-discovered onion page as [DARKWEB] intel report.
   *  Tagged with `darkweb`, `category:<X>`, `seed:<id>` for provenance.
   *  Idempotent on content_hash. */
  private async storeSeedHit(seed: DarkWebSeed, url: string, hostname: string, text: string): Promise<string | null> {
    const { createHash } = await import('crypto')
    const db = getDatabase()
    const now = timestamp()
    const trimmed = text.slice(0, 8000)
    const hash = createHash('sha256').update(url + '|' + trimmed).digest('hex')
    const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
    if (existing) {
      db.prepare('UPDATE intel_reports SET updated_at = ? WHERE id = ?').run(now, existing.id)
      return null
    }
    const id = generateId()
    const title = `[DARKWEB] ${hostname}`.slice(0, 200)
    const summary = trimmed.slice(0, 240).replace(/\s+/g, ' ').trim()
    const content = `**Source**: seed sweep "${seed.query}" (category: ${seed.category})\n**Onion URL**: ${url}\n**Fetched at**: ${new Date(now).toISOString()}\n\n---\n\n${trimmed}`
    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'osint', title, content, summary, 'medium', 'darkweb-seed', `Onion: ${hostname}`, url, hash, 40, 0, now, now)

    const tags = ['darkweb', `category:${seed.category}`, `seed:${seed.id}`, 'onion-fetch']
    const tagStmt = db.prepare(
      'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const tag of tags) {
      try { tagStmt.run(id, tag, 1.0, 'darkweb-seed', now) } catch { /* */ }
    }

    // Trigger enrichment + crawl (fire-and-forget — queues handle back-pressure).
    void this.queuePostStore(id)
    return id
  }

  /** Lazily import + queue enrichment + crawl so we don't create a
   *  circular dependency at module load time. */
  private async queuePostStore(reportId: string): Promise<void> {
    try {
      const { darkWebEnrichmentService } = await import('./DarkWebEnrichmentService')
      darkWebEnrichmentService.enqueue(reportId)
    } catch (err) {
      log.debug(`DarkWebSeedService: enrichment queue failed for ${reportId}: ${err}`)
    }
    try {
      const { onionCrawlerService } = await import('./OnionCrawlerService')
      onionCrawlerService.enqueue(reportId)
    } catch (err) {
      log.debug(`DarkWebSeedService: crawler queue failed for ${reportId}: ${err}`)
    }
  }

  private recordSeedRun(seedId: string, hits: number, error: string | null): void {
    const db = getDatabase()
    db.prepare(
      'UPDATE darkweb_seeds SET last_run_at = ?, hit_count = hit_count + ?, last_error = ? WHERE id = ?'
    ).run(timestamp(), hits, error, seedId)
  }

  // ── Host health / quarantine ─────────────────────────────────────────
  recordHostSuccess(hostname: string): void {
    const db = getDatabase()
    const now = timestamp()
    db.prepare(`
      INSERT INTO darkweb_host_health (hostname, consecutive_failures, total_successes, last_success_at, updated_at)
      VALUES (?, 0, 1, ?, ?)
      ON CONFLICT(hostname) DO UPDATE SET
        consecutive_failures = 0,
        total_successes = total_successes + 1,
        last_success_at = excluded.last_success_at,
        updated_at = excluded.updated_at,
        quarantined = 0,
        quarantined_at = NULL
    `).run(hostname, now, now)
  }

  recordHostFailure(hostname: string, error: string): void {
    const db = getDatabase()
    const now = timestamp()
    db.prepare(`
      INSERT INTO darkweb_host_health (hostname, consecutive_failures, total_failures, last_failure_at, last_error, updated_at)
      VALUES (?, 1, 1, ?, ?, ?)
      ON CONFLICT(hostname) DO UPDATE SET
        consecutive_failures = consecutive_failures + 1,
        total_failures = total_failures + 1,
        last_failure_at = excluded.last_failure_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(hostname, now, error.slice(0, 240), now)

    // Quarantine if threshold reached.
    const row = db.prepare('SELECT consecutive_failures, quarantined FROM darkweb_host_health WHERE hostname = ?').get(hostname) as { consecutive_failures: number; quarantined: number } | undefined
    if (row && !row.quarantined && row.consecutive_failures >= QUARANTINE_THRESHOLD) {
      db.prepare('UPDATE darkweb_host_health SET quarantined = 1, quarantined_at = ? WHERE hostname = ?').run(now, hostname)
      auditService.log('darkweb.host.quarantined', { hostname, consecutiveFailures: row.consecutive_failures, lastError: error.slice(0, 240) })
      log.info(`DarkWebSeedService: quarantined ${hostname} after ${row.consecutive_failures} consecutive failures`)
    }
  }

  listHostHealth(opts: { quarantinedOnly?: boolean; limit?: number } = {}): HostHealth[] {
    const db = getDatabase()
    const limit = opts.limit ?? 200
    const where = opts.quarantinedOnly ? 'WHERE quarantined = 1' : ''
    const rows = db.prepare(`SELECT * FROM darkweb_host_health ${where} ORDER BY updated_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      hostname: r.hostname as string,
      consecutiveFailures: r.consecutive_failures as number,
      totalFailures: r.total_failures as number,
      totalSuccesses: r.total_successes as number,
      lastSuccessAt: r.last_success_at as number | null,
      lastFailureAt: r.last_failure_at as number | null,
      lastError: r.last_error as string | null,
      quarantined: (r.quarantined as number) === 1,
      quarantinedAt: r.quarantined_at as number | null,
      updatedAt: r.updated_at as number
    }))
  }

  unquarantineHost(hostname: string): void {
    const db = getDatabase()
    db.prepare('UPDATE darkweb_host_health SET quarantined = 0, consecutive_failures = 0, quarantined_at = NULL, updated_at = ? WHERE hostname = ?').run(timestamp(), hostname)
    auditService.log('darkweb.host.unquarantined', { hostname })
  }

  private emitProgress(): void {
    if (!this.activeJob) return
    const snapshot = { ...this.activeJob }
    for (const l of this.progressListeners) {
      try { l(snapshot) } catch { /* */ }
    }
  }

  private mapSeed(row: Record<string, unknown>): DarkWebSeed {
    return {
      id: row.id as string,
      category: row.category as string,
      query: row.query as string,
      description: (row.description as string) ?? null,
      enabled: (row.enabled as number) === 1,
      isCustom: (row.is_custom as number) === 1,
      lastRunAt: (row.last_run_at as number) ?? null,
      lastError: (row.last_error as string) ?? null,
      hitCount: (row.hit_count as number) ?? 0,
      createdAt: row.created_at as number
    }
  }
}

export const darkWebSeedService = new DarkWebSeedServiceImpl()
