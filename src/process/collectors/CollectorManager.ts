import { IPC_EVENTS } from '@common/adapter/ipcBridge'
import { emitToAll } from '../services/resource/WindowCache'
import { debugCollector, debugStore, isDevMode } from '../services/debug/DebugLogger'
import { BaseCollector, type SourceConfig } from './BaseCollector'
import { intelStorageService } from '../services/intel/IntelStorageService'
import { cronService } from '../services/cron/CronService'
import { watchTermsService } from '../services/watch/WatchTermsService'
import { getDatabase } from '../services/database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export class CollectorManager {
  private collectors = new Map<string, BaseCollector>()
  private collectorFactories = new Map<string, () => BaseCollector>()

  registerFactory(type: string, factory: () => BaseCollector): void {
    this.collectorFactories.set(type, factory)
    log.info(`Collector factory registered: ${type}`)
  }

  async loadFromDatabase(): Promise<void> {
    const db = getDatabase()
    const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1').all() as Array<{
      id: string
      name: string
      discipline: string
      type: string
      config: string
      schedule: string | null
      enabled: number
    }>

    for (const source of sources) {
      await this.registerCollector({
        id: source.id,
        name: source.name,
        discipline: source.discipline as SourceConfig['discipline'],
        type: source.type,
        config: JSON.parse(source.config),
        schedule: source.schedule,
        enabled: source.enabled === 1
      })
    }

    log.info(`Loaded ${sources.length} collectors from database`)

    // Run initial collection for all loaded collectors (staggered)
    if (sources.length > 0) {
      this.runInitialCollection(sources.map((s) => s.id))
    }
  }

  private runInitialCollection(sourceIds: string[]): void {
    log.info(`Scheduling initial collection for ${sourceIds.length} sources (background, 5s stagger)`)

    // Fire-and-forget with stagger — doesn't block startup
    let delay = 10000 // Start after 10s to let UI + services settle
    for (const sourceId of sourceIds) {
      setTimeout(() => {
        this.runCollector(sourceId).catch((err) => {
          log.warn(`Initial collection failed for ${sourceId}: ${err}`)
        })
      }, delay)
      delay += 2000 // 2s stagger — prevents memory pressure from 47 concurrent fetches
    }
  }

  async registerCollector(config: SourceConfig): Promise<void> {
    const factory = this.collectorFactories.get(config.type)
    if (!factory) {
      log.warn(`No factory for collector type: ${config.type}`)
      return
    }

    const collector = factory()
    await collector.initialize(config)
    this.collectors.set(config.id, collector)

    // Schedule if cron expression provided
    if (config.schedule) {
      cronService.schedule(
        `collector:${config.id}`,
        config.schedule,
        `${config.name} (${config.discipline})`,
        () => this.runCollector(config.id)
      )
    }
  }

  async runCollector(sourceId: string): Promise<{ collected: number; stored: number; error: string | null }> {
    const collector = this.collectors.get(sourceId)
    if (!collector) {
      throw new Error(`Collector not found: ${sourceId}`)
    }

    // Look up source name for friendly logs
    const db = getDatabase()
    const srcRow = db.prepare('SELECT name, type FROM sources WHERE id = ?').get(sourceId) as { name: string; type: string } | undefined
    const sourceName = srcRow?.name || sourceId.slice(0, 8)
    const sourceType = srcRow?.type || 'unknown'

    debugCollector(sourceName, `START [${sourceType}]`)
    this.emitStatus(sourceId, 'running')

    const startTime = Date.now()

    try {
      const rawReports = await collector.collect()
      const reports = (rawReports || []).filter((r) => r && r.title?.trim() && r.content?.trim())
      const dropped = (rawReports || []).length - reports.length
      const stored = intelStorageService.store(reports)
      const dupes = reports.length - stored.length
      const elapsedMs = Date.now() - startTime

      // Update source metadata
      db.prepare(
        'UPDATE sources SET last_collected_at = ?, last_error = NULL, error_count = 0, updated_at = ? WHERE id = ?'
      ).run(timestamp(), timestamp(), sourceId)

      // Check new reports against enabled watch terms
      if (stored.length > 0) {
        this.matchWatchTerms(stored)
      }

      // Always log result + debug-only granular details
      log.info(`Collector [${sourceName}] (${sourceType}): collected=${reports.length} stored=${stored.length} dupes=${dupes}${dropped > 0 ? ` dropped=${dropped}` : ''} (${elapsedMs}ms)`)
      debugStore(sourceName, reports.length, stored.length, dupes)
      if (isDevMode() && stored.length > 0) {
        debugCollector(sourceName, `DONE — sample title: "${stored[0].title.slice(0, 80)}"`)
      } else if (isDevMode() && reports.length === 0) {
        debugCollector(sourceName, `DONE — NO ITEMS RETURNED (check API endpoint, auth, robots.txt, or feed format)`)
      }
      this.emitStatus(sourceId, 'idle')
      return { collected: reports.length, stored: stored.length, error: null }
    } catch (err) {
      const errStr = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
      log.error(`Collector [${sourceName}] (${sourceType}) FAILED: ${errStr.slice(0, 500)}`)
      debugCollector(sourceName, `ERROR`, errStr.slice(0, 200))

      db.prepare(
        'UPDATE sources SET last_error = ?, error_count = error_count + 1, updated_at = ? WHERE id = ?'
      ).run(String(err).slice(0, 500), timestamp(), sourceId)

      this.emitStatus(sourceId, 'error', String(err))
      return { collected: 0, stored: 0, error: String(err) }
    }
  }

  // Run all enabled collectors with stagger to avoid overwhelming the system
  async runAllCollectors(): Promise<{ total: number; succeeded: number; failed: number; results: Array<{ sourceId: string; sourceName: string; collected: number; stored: number; error: string | null }> }> {
    const allIds = Array.from(this.collectors.keys())
    log.info(`SyncAll: running ${allIds.length} collectors with 500ms stagger`)
    debugCollector('SYNC_ALL', `Starting ${allIds.length} collectors`)

    const db = getDatabase()
    const results: Array<{ sourceId: string; sourceName: string; collected: number; stored: number; error: string | null }> = []
    let succeeded = 0
    let failed = 0

    for (let i = 0; i < allIds.length; i++) {
      const sourceId = allIds[i]
      const srcRow = db.prepare('SELECT name FROM sources WHERE id = ?').get(sourceId) as { name: string } | undefined
      const sourceName = srcRow?.name || sourceId

      try {
        const r = await this.runCollector(sourceId)
        results.push({ sourceId, sourceName, ...r })
        if (r.error) failed++; else succeeded++
      } catch (err) {
        results.push({ sourceId, sourceName, collected: 0, stored: 0, error: String(err) })
        failed++
      }

      // 500ms stagger between collectors so we don't slam memory/network
      if (i < allIds.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    const totalStored = results.reduce((s, r) => s + r.stored, 0)
    log.info(`SyncAll DONE: ${succeeded} succeeded, ${failed} failed, ${totalStored} total new reports`)
    debugCollector('SYNC_ALL', `Completed: ${succeeded}/${allIds.length} succeeded, ${totalStored} new reports`)
    return { total: allIds.length, succeeded, failed, results }
  }

  async createSource(config: Omit<SourceConfig, 'id'>): Promise<SourceConfig> {
    const id = generateId()
    const now = timestamp()
    const fullConfig: SourceConfig = { ...config, id }

    const db = getDatabase()
    db.prepare(`
      INSERT INTO sources (id, name, discipline, type, config, schedule, enabled, error_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, config.name, config.discipline, config.type, JSON.stringify(config.config), config.schedule, config.enabled ? 1 : 0, now, now)

    if (config.enabled) {
      await this.registerCollector(fullConfig)
    }

    return fullConfig
  }

  async shutdownAll(): Promise<void> {
    cronService.stopAll()
    for (const collector of this.collectors.values()) {
      await collector.shutdown()
    }
    this.collectors.clear()
    log.info('All collectors shut down')
  }

  getStatus(): Array<{ sourceId: string; type: string; running: boolean }> {
    return Array.from(this.collectors.entries()).map(([sourceId, collector]) => ({
      sourceId,
      type: collector.type,
      running: cronService.isRunning(`collector:${sourceId}`)
    }))
  }

  private matchWatchTerms(reports: Array<{ title: string; content: string }>): void {
    try {
      const terms = watchTermsService.getEnabled()
      if (terms.length === 0) return

      let totalHits = 0
      for (const term of terms) {
        const termLower = term.term.toLowerCase()
        for (const report of reports) {
          const text = `${report.title} ${report.content}`.toLowerCase()
          if (text.includes(termLower)) {
            watchTermsService.recordHit(term.id)
            totalHits++
            break // Count once per term per batch
          }
        }
      }

      if (totalHits > 0) {
        log.info(`WatchTerms: ${totalHits} terms matched in ${reports.length} new reports`)
        emitToAll('watch:hits', { count: totalHits })
      }
    } catch (err) {
      log.warn('WatchTerms matching failed:', err)
    }
  }

  private emitStatus(sourceId: string, status: 'running' | 'idle' | 'error', error?: string): void {
    emitToAll(IPC_EVENTS.COLLECTOR_STATUS_CHANGED, { sourceId, status, error })
  }
}

export const collectorManager = new CollectorManager()
