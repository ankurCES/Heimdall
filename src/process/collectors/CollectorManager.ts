import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '@common/adapter/ipcBridge'
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
    let delay = 5000 // Start after 5s to let UI render first
    for (const sourceId of sourceIds) {
      setTimeout(() => {
        this.runCollector(sourceId).catch((err) => {
          log.warn(`Initial collection failed for ${sourceId}: ${err}`)
        })
      }, delay)
      delay += 500 // 500ms stagger instead of 2000ms
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

  async runCollector(sourceId: string): Promise<void> {
    const collector = this.collectors.get(sourceId)
    if (!collector) {
      throw new Error(`Collector not found: ${sourceId}`)
    }

    this.emitStatus(sourceId, 'running')

    try {
      const rawReports = await collector.collect()
      const reports = (rawReports || []).filter((r) => r && r.title?.trim() && r.content?.trim())
      const stored = intelStorageService.store(reports)

      // Update source metadata
      const db = getDatabase()
      db.prepare(
        'UPDATE sources SET last_collected_at = ?, last_error = NULL, error_count = 0, updated_at = ? WHERE id = ?'
      ).run(timestamp(), timestamp(), sourceId)

      // Check new reports against enabled watch terms
      if (stored.length > 0) {
        this.matchWatchTerms(stored)
      }

      log.info(`Collector ${sourceId}: collected ${reports.length} reports, stored ${stored.length} new`)
      this.emitStatus(sourceId, 'idle')
    } catch (err) {
      log.error(`Collector ${sourceId} failed:`, err)

      const db = getDatabase()
      db.prepare(
        'UPDATE sources SET last_error = ?, error_count = error_count + 1, updated_at = ? WHERE id = ?'
      ).run(String(err), timestamp(), sourceId)

      this.emitStatus(sourceId, 'error', String(err))
    }
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
        // Notify UI
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('watch:hits', { count: totalHits })
        }
      }
    } catch (err) {
      log.warn('WatchTerms matching failed:', err)
    }
  }

  private emitStatus(sourceId: string, status: 'running' | 'idle' | 'error', error?: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_EVENTS.COLLECTOR_STATUS_CHANGED, { sourceId, status, error })
    }
  }
}

export const collectorManager = new CollectorManager()
