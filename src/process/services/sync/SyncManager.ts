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
      { type: 'collectors', label: 'Source Collectors' },
      { type: 'humint-export', label: 'HUMINT Reports to Vault' },
      { type: 'prelim-export', label: 'Preliminary Reports to Vault' },
      { type: 'tool-calls', label: 'Tool Call Logs to Vault' }
    ]

    for (const t of types) {
      this.jobs.set(t.type, {
        id: t.type, type: t.type, label: t.label,
        status: 'idle', progress: 0, current: 0, total: 0,
        lastSyncAt: null, lastError: null, itemsSynced: 0
      })
    }

    // Don't load sync log in constructor — DB may not be ready yet
    // Will lazy-load on first access
  }

  private syncLogLoaded = false

  private ensureSyncLogLoaded(): void {
    if (this.syncLogLoaded) return
    this.loadSyncLog()
    this.syncLogLoaded = true
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
    this.ensureSyncLogLoaded()
    return this.syncLog.get(type)?.has(contentHash) || false
  }

  // Mark an item as synced
  markSynced(type: string, contentHash: string): void {
    this.ensureSyncLogLoaded()
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

  async syncHumintReports(): Promise<void> {
    this.updateJob('humint-export', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const db = getDatabase()
      const reports = db.prepare('SELECT * FROM humint_reports ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
      const unsynced = reports.filter((r) => !this.isSynced('humint-export', r.id as string))
      this.updateJob('humint-export', { total: unsynced.length })

      if (unsynced.length === 0) {
        this.updateJob('humint-export', { status: 'completed' })
        return
      }

      const { obsidianService } = await import('../obsidian/ObsidianService')
      const { settingsService } = await import('../settings/SettingsService')
      const config = settingsService.get<any>('obsidian')
      const folder = config?.syncFolder || 'Heimdall'

      // Also write to local memory dir
      const { app } = await import('electron')
      const { join } = await import('path')
      const { mkdirSync, writeFileSync } = await import('fs')
      const memoryDir = join(app.getPath('home'), '.heimdall', 'memory')

      for (const report of unsynced) {
        const date = new Date(report.created_at as number).toISOString()
        const dateStr = date.split('T')[0]
        const md = `---
type: humint
id: ${report.id}
confidence: ${report.confidence}
session: ${report.session_id}
source_intel: ${report.source_report_ids}
tools_used: ${report.tool_calls_used}
status: ${report.status}
created: ${date}
---

# HUMINT Report

## Analyst Notes

${report.analyst_notes || 'No notes'}

## Findings

${report.findings || 'No findings'}
`
        // Write locally
        const localDir = join(memoryDir, 'humint', dateStr)
        mkdirSync(localDir, { recursive: true })
        writeFileSync(join(localDir, `${(report.id as string).slice(0, 8)}-humint.md`), md, 'utf-8')

        // Sync to Obsidian
        try {
          await obsidianService.writeFile(`${folder}/humint/${dateStr}/${(report.id as string).slice(0, 8)}-humint.md`, md)
        } catch {}

        this.markSynced('humint-export', report.id as string)
        this.incrementProgress('humint-export')
      }

      this.updateJob('humint-export', { status: 'completed' })
      log.info(`SyncManager: HUMINT export — ${unsynced.length} reports synced`)
    } catch (err) {
      this.updateJob('humint-export', { status: 'error', lastError: String(err) })
    }
  }

  async syncPreliminaryReports(): Promise<void> {
    this.updateJob('prelim-export', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const db = getDatabase()
      const reports = db.prepare('SELECT * FROM preliminary_reports ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
      const unsynced = reports.filter((r) => !this.isSynced('prelim-export', r.id as string))
      this.updateJob('prelim-export', { total: unsynced.length })

      if (unsynced.length === 0) {
        this.updateJob('prelim-export', { status: 'completed' })
        return
      }

      const { obsidianService } = await import('../obsidian/ObsidianService')
      const { settingsService } = await import('../settings/SettingsService')
      const config = settingsService.get<any>('obsidian')
      const folder = config?.syncFolder || 'Heimdall'

      const { app } = await import('electron')
      const { join } = await import('path')
      const { mkdirSync, writeFileSync } = await import('fs')
      const memoryDir = join(app.getPath('home'), '.heimdall', 'memory')

      for (const report of unsynced) {
        const date = new Date(report.created_at as number).toISOString()
        const dateStr = date.split('T')[0]

        // Get related actions and gaps
        const actions = db.prepare('SELECT action, priority, status FROM recommended_actions WHERE preliminary_report_id = ?').all(report.id) as Array<Record<string, unknown>>
        const gaps = db.prepare('SELECT description, category, severity, status FROM intel_gaps WHERE preliminary_report_id = ?').all(report.id) as Array<Record<string, unknown>>

        const actionsSection = actions.length > 0
          ? `## Recommended Actions\n\n${actions.map((a) => `- **[${a.priority}]** ${a.action} _(${a.status})_`).join('\n')}\n`
          : ''
        const gapsSection = gaps.length > 0
          ? `## Information Gaps\n\n${gaps.map((g) => `- **[${g.severity}/${g.category}]** ${g.description} _(${g.status})_`).join('\n')}\n`
          : ''

        const md = `---
type: preliminary
id: ${report.id}
session: ${report.session_id}
status: ${report.status}
source_reports: ${report.source_report_ids || '[]'}
created: ${date}
---

# ${report.title || 'Preliminary Report'}

${report.content || ''}

${actionsSection}
${gapsSection}
`
        // Write locally
        const localDir = join(memoryDir, 'preliminary', dateStr)
        mkdirSync(localDir, { recursive: true })
        const slug = (report.title as string || 'report').slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
        const filename = `${(report.id as string).slice(0, 8)}-${slug}.md`
        writeFileSync(join(localDir, filename), md, 'utf-8')

        // Sync to Obsidian
        try {
          await obsidianService.writeFile(`${folder}/preliminary/${dateStr}/${filename}`, md)
        } catch {}

        this.markSynced('prelim-export', report.id as string)
        this.incrementProgress('prelim-export')
      }

      this.updateJob('prelim-export', { status: 'completed' })
      log.info(`SyncManager: Preliminary export — ${unsynced.length} reports synced`)
    } catch (err) {
      this.updateJob('prelim-export', { status: 'error', lastError: String(err) })
    }
  }

  async syncToolCallLogs(): Promise<void> {
    this.updateJob('tool-calls', { status: 'running', current: 0, progress: 0, itemsSynced: 0 })

    try {
      const db = getDatabase()

      // Group tool calls by session and date
      const sessions = db.prepare(`
        SELECT DISTINCT session_id, DATE(created_at / 1000, 'unixepoch') as date_str
        FROM tool_call_logs ORDER BY created_at DESC
      `).all() as Array<{ session_id: string; date_str: string }>

      const unsynced = sessions.filter((s) => !this.isSynced('tool-calls', `${s.session_id}:${s.date_str}`))
      this.updateJob('tool-calls', { total: unsynced.length })

      if (unsynced.length === 0) {
        this.updateJob('tool-calls', { status: 'completed' })
        return
      }

      const { obsidianService } = await import('../obsidian/ObsidianService')
      const { settingsService } = await import('../settings/SettingsService')
      const config = settingsService.get<any>('obsidian')
      const folder = config?.syncFolder || 'Heimdall'

      const { app } = await import('electron')
      const { join } = await import('path')
      const { mkdirSync, writeFileSync } = await import('fs')
      const memoryDir = join(app.getPath('home'), '.heimdall', 'memory')

      for (const session of unsynced) {
        const calls = db.prepare(
          'SELECT tool_name, params, result, execution_time_ms, created_at FROM tool_call_logs WHERE session_id = ? ORDER BY created_at ASC'
        ).all(session.session_id) as Array<Record<string, unknown>>

        if (calls.length === 0) continue

        // Get session title
        const sessionRow = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(session.session_id) as { title: string } | undefined
        const sessionTitle = sessionRow?.title || 'Unknown Session'

        let md = `---
type: tool-call-log
session: ${session.session_id}
session_title: "${sessionTitle}"
date: ${session.date_str}
tool_calls: ${calls.length}
---

# Tool Call Log: ${sessionTitle}

**Date**: ${session.date_str}
**Session**: ${session.session_id.slice(0, 8)}
**Total Calls**: ${calls.length}

---

`
        for (const call of calls) {
          const time = new Date(call.created_at as number).toISOString().split('T')[1].split('.')[0]
          md += `## ${time} — ${call.tool_name}\n\n`
          md += `**Parameters**:\n\`\`\`json\n${(call.params as string || '{}').slice(0, 500)}\n\`\`\`\n\n`
          md += `**Result**:\n\`\`\`\n${(call.result as string || '').slice(0, 1000)}\n\`\`\`\n\n---\n\n`
        }

        // Write locally
        const localDir = join(memoryDir, 'tool-calls', session.date_str)
        mkdirSync(localDir, { recursive: true })
        const filename = `${session.session_id.slice(0, 8)}-tools.md`
        writeFileSync(join(localDir, filename), md, 'utf-8')

        // Sync to Obsidian
        try {
          await obsidianService.writeFile(`${folder}/tool-calls/${session.date_str}/${filename}`, md)
        } catch {}

        this.markSynced('tool-calls', `${session.session_id}:${session.date_str}`)
        this.incrementProgress('tool-calls')
      }

      this.updateJob('tool-calls', { status: 'completed' })
      log.info(`SyncManager: Tool calls export — ${unsynced.length} session logs synced`)
    } catch (err) {
      this.updateJob('tool-calls', { status: 'error', lastError: String(err) })
    }
  }

  async syncAll(): Promise<void> {
    log.info('SyncManager: sync all started')
    await this.syncVectorDb()
    await this.syncEnrichment()
    await this.syncObsidianPush()
    await this.syncMeshtastic()
    await this.syncHumintReports()
    await this.syncPreliminaryReports()
    await this.syncToolCallLogs()
    log.info('SyncManager: sync all complete')
  }
}

export const syncManager = new SyncManager()
