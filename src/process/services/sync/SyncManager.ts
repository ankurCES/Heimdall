import { BrowserWindow } from 'electron'
import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export interface SyncJob {
  id: string
  type: string
  label: string
  status: 'idle' | 'running' | 'completed' | 'error'
  progress: number // 0-100
  current: number
  total: number
  lastSyncAt: number | null
  lastError: string | null
  itemsSynced: number
}

export class SyncManager {
  private jobs = new Map<string, SyncJob>()
  private syncLog = new Map<string, Set<string>>() // type → set of synced content hashes

  constructor() {
    // Register all sync job types
    const types = [
      { type: 'obsidian-push', label: 'Push to Obsidian Vault' },
      { type: 'obsidian-pull', label: 'Pull from Obsidian Vault' },
      { type: 'vector-db', label: 'Vector DB Ingestion' },
      { type: 'local-memory', label: 'Local Memory Files' },
      { type: 'enrichment', label: 'Intel Enrichment (Tags/Entities)' },
      { type: 'meshtastic', label: 'Meshtastic Node Sync' },
      { type: 'collectors', label: 'Source Collectors' }
    ]

    for (const t of types) {
      this.jobs.set(t.type, {
        id: t.type, type: t.type, label: t.label,
        status: 'idle', progress: 0, current: 0, total: 0,
        lastSyncAt: null, lastError: null, itemsSynced: 0
      })
    }

    // Load sync log from DB
    this.loadSyncLog()
  }

  private loadSyncLog(): void {
    try {
      const db = getDatabase()
      // Ensure sync_log table exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_log (
          type TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (type, content_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_type ON sync_log(type);
      `)

      const rows = db.prepare('SELECT type, content_hash FROM sync_log').all() as Array<{ type: string; content_hash: string }>
      for (const row of rows) {
        if (!this.syncLog.has(row.type)) this.syncLog.set(row.type, new Set())
        this.syncLog.get(row.type)!.add(row.content_hash)
      }
      log.info(`SyncManager: loaded ${rows.length} sync log entries`)
    } catch (err) {
      log.debug(`SyncManager: sync log load failed: ${err}`)
    }
  }

  // Check if an item was already synced
  isSynced(type: string, contentHash: string): boolean {
    return this.syncLog.get(type)?.has(contentHash) || false
  }

  // Mark an item as synced
  markSynced(type: string, contentHash: string): void {
    if (!this.syncLog.has(type)) this.syncLog.set(type, new Set())
    this.syncLog.get(type)!.add(contentHash)

    try {
      const db = getDatabase()
      db.prepare('INSERT OR IGNORE INTO sync_log (type, content_hash, synced_at) VALUES (?, ?, ?)').run(type, contentHash, timestamp())
    } catch {}
  }

  // Get count of synced items for a type
  getSyncedCount(type: string): number {
    return this.syncLog.get(type)?.size || 0
  }

  // Update job status and emit to renderer
  updateJob(type: string, updates: Partial<SyncJob>): void {
    const job = this.jobs.get(type)
    if (!job) return

    Object.assign(job, updates)
    if (updates.status === 'completed') {
      job.lastSyncAt = timestamp()
      job.progress = 100
    }
    if (updates.status === 'error') {
      job.lastError = updates.lastError || 'Unknown error'
    }

    this.emitProgress()
  }

  // Update progress incrementally
  incrementProgress(type: string, itemsSynced: number = 1): void {
    const job = this.jobs.get(type)
    if (!job) return

    job.current += itemsSynced
    job.itemsSynced += itemsSynced
    if (job.total > 0) job.progress = Math.min(100, Math.round((job.current / job.total) * 100))

    // Emit every 10 items to avoid flooding
    if (job.current % 10 === 0 || job.current === job.total) {
      this.emitProgress()
    }
  }

  getJobs(): SyncJob[] {
    return Array.from(this.jobs.values())
  }

  getJob(type: string): SyncJob | null {
    return this.jobs.get(type) || null
  }

  isAnyRunning(): boolean {
    return Array.from(this.jobs.values()).some((j) => j.status === 'running')
  }

  private emitProgress(): void {
    const jobs = this.getJobs()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sync:progress', jobs)
    }
  }

  // ── Sync operations ──────────────────────────────────────────────

  async syncObsidianPush(): Promise<void> {
    this.updateJob('obsidian-push', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const { obsidianService } = await import('../obsidian/ObsidianService')
      const testConn = await obsidianService.testConnection()
      if (!testConn.success) {
        this.updateJob('obsidian-push', { status: 'error', lastError: 'Obsidian not connected' })
        return
      }

      const { app } = await import('electron')
      const { join } = await import('path')
      const { readdirSync, readFileSync, statSync } = await import('fs')
      const { settingsService } = await import('../settings/SettingsService')

      const config = settingsService.get<any>('obsidian')
      const folder = config?.syncFolder || 'Heimdall'
      const memoryDir = join(app.getPath('home'), '.heimdall', 'memory')

      // Walk local files
      const filesToSync: Array<{ relPath: string; fullPath: string }> = []
      const walk = (dir: string, rel: string = ''): void => {
        let entries: string[]
        try { entries = readdirSync(dir) } catch { return }
        for (const entry of entries) {
          const fullPath = join(dir, entry)
          const relPath = rel ? `${rel}/${entry}` : entry
          try {
            if (statSync(fullPath).isDirectory()) { walk(fullPath, relPath); continue }
            if (!entry.endsWith('.md')) continue
            // Check sync log — skip already synced
            if (this.isSynced('obsidian-push', relPath)) continue
            filesToSync.push({ relPath, fullPath })
          } catch {}
        }
      }
      walk(memoryDir)

      this.updateJob('obsidian-push', { total: filesToSync.length })
      log.info(`SyncManager: Obsidian push — ${filesToSync.length} new files to sync`)

      // Push in parallel batches of 5
      for (let i = 0; i < filesToSync.length; i += 5) {
        const batch = filesToSync.slice(i, i + 5)
        await Promise.allSettled(batch.map(async ({ relPath, fullPath }) => {
          try {
            const content = readFileSync(fullPath, 'utf-8')
            if (content.length < 10) return
            await obsidianService.writeFile(`${folder}/${relPath}`, content)
            this.markSynced('obsidian-push', relPath)
            this.incrementProgress('obsidian-push')
          } catch {}
        }))
      }

      this.updateJob('obsidian-push', { status: 'completed' })
      log.info(`SyncManager: Obsidian push complete — ${this.jobs.get('obsidian-push')!.itemsSynced} files`)
    } catch (err) {
      this.updateJob('obsidian-push', { status: 'error', lastError: String(err) })
    }
  }

  async syncVectorDb(): Promise<void> {
    this.updateJob('vector-db', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const { intelPipeline } = await import('../vectordb/IntelPipeline')
      const db = getDatabase()
      const total = (db.prepare('SELECT COUNT(*) as c FROM intel_reports').get() as { c: number }).c
      this.updateJob('vector-db', { total })

      await intelPipeline.runIngestion()

      this.updateJob('vector-db', { status: 'completed', current: total, itemsSynced: total })
    } catch (err) {
      this.updateJob('vector-db', { status: 'error', lastError: String(err) })
    }
  }

  async syncEnrichment(): Promise<void> {
    this.updateJob('enrichment', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const { intelEnricher } = await import('../enrichment/IntelEnricher')
      const db = getDatabase()

      const unenriched = db.prepare(`
        SELECT r.id, r.discipline, r.title, r.content, r.severity, r.source_id, r.source_url,
               r.source_name, r.content_hash, r.latitude, r.longitude, r.verification_score,
               r.reviewed, r.created_at, r.updated_at, r.summary
        FROM intel_reports r
        LEFT JOIN intel_tags t ON r.id = t.report_id
        WHERE t.report_id IS NULL
        LIMIT 500
      `).all() as Array<Record<string, unknown>>

      this.updateJob('enrichment', { total: unenriched.length })

      for (const row of unenriched) {
        try {
          intelEnricher.enrichReport({
            id: row.id as string, discipline: row.discipline as any,
            title: row.title as string, content: row.content as string,
            summary: row.summary as string | null, severity: row.severity as any,
            sourceId: row.source_id as string, sourceUrl: row.source_url as string | null,
            sourceName: row.source_name as string, contentHash: row.content_hash as string,
            latitude: row.latitude as number | null, longitude: row.longitude as number | null,
            verificationScore: row.verification_score as number,
            reviewed: (row.reviewed as number) === 1,
            createdAt: row.created_at as number, updatedAt: row.updated_at as number
          })
          this.incrementProgress('enrichment')
        } catch {}
      }

      this.updateJob('enrichment', { status: 'completed' })
    } catch (err) {
      this.updateJob('enrichment', { status: 'error', lastError: String(err) })
    }
  }

  async syncMeshtastic(): Promise<void> {
    this.updateJob('meshtastic', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const { pullMeshtasticHttp } = await import('../../bridge/meshtasticBridge')
      const { settingsService } = await import('../settings/SettingsService')
      const config = settingsService.get<any>('meshtastic')

      if (!config?.address) {
        this.updateJob('meshtastic', { status: 'error', lastError: 'No device address configured' })
        return
      }

      let addr = config.address
      if (!addr.startsWith('http')) addr = `http://${addr}`

      const result = await pullMeshtasticHttp(addr)
      this.updateJob('meshtastic', {
        status: result.success ? 'completed' : 'error',
        itemsSynced: result.nodesFound || 0,
        lastError: result.success ? null : result.message
      })
    } catch (err) {
      this.updateJob('meshtastic', { status: 'error', lastError: String(err) })
    }
  }

  async syncAll(): Promise<void> {
    log.info('SyncManager: sync all started')
    await this.syncVectorDb()
    await this.syncEnrichment()
    await this.syncObsidianPush()
    await this.syncMeshtastic()
    log.info('SyncManager: sync all complete')
  }
}

export const syncManager = new SyncManager()
