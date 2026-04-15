import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { getDatabase } from '../services/database'
import { collectorManager } from '../collectors/CollectorManager'
import { SOURCE_PRESETS } from '../services/sources/SourcePresets'
import { ApiEndpointCollector } from '../collectors/custom/ApiEndpointCollector'
import { TelegramSubscriberCollector } from '../collectors/custom/TelegramSubscriberCollector'
import { GitHubRepoCollector } from '../collectors/custom/GitHubRepoCollector'
import { RssCollector } from '../collectors/osint/RssCollector'
import { generateId, timestamp } from '@common/utils/id'
import type { Source } from '@common/types/intel'
import log from 'electron-log'

export function registerSourcesBridge(): void {
  ipcMain.handle(IPC_CHANNELS.SOURCES_GET_ALL, () => {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM sources ORDER BY discipline, name').all() as Array<Record<string, unknown>>
    return rows.map(mapSource)
  })

  ipcMain.handle(IPC_CHANNELS.SOURCES_CREATE, async (_event, params) => {
    const config = await collectorManager.createSource({
      name: params.name,
      discipline: params.discipline,
      type: params.type,
      config: params.config || {},
      schedule: params.schedule || null,
      enabled: params.enabled ?? true
    })
    return config
  })

  ipcMain.handle(IPC_CHANNELS.SOURCES_UPDATE, (_event, params: { id: string; data: Partial<Source> }) => {
    const db = getDatabase()
    const { id, data } = params
    const now = timestamp()

    const fields: string[] = []
    const values: unknown[] = []

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
    if (data.discipline !== undefined) { fields.push('discipline = ?'); values.push(data.discipline) }
    if (data.type !== undefined) { fields.push('type = ?'); values.push(data.type) }
    if (data.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(data.config)) }
    if (data.schedule !== undefined) { fields.push('schedule = ?'); values.push(data.schedule) }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }

    fields.push('updated_at = ?')
    values.push(now)
    values.push(id)

    db.prepare(`UPDATE sources SET ${fields.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as Record<string, unknown>
    return mapSource(updated)
  })

  ipcMain.handle(IPC_CHANNELS.SOURCES_DELETE, (_event, params: { id: string }) => {
    const db = getDatabase()
    db.prepare('DELETE FROM sources WHERE id = ?').run(params.id)
  })

  ipcMain.handle(IPC_CHANNELS.SOURCES_COLLECT_NOW, async (_event, params: { id: string }) => {
    log.info(`Manual collection triggered for source: ${params.id}`)
    await collectorManager.runCollector(params.id)
  })

  // Run all enabled collectors with stagger — returns per-source results
  ipcMain.handle('sources:syncAll', async () => {
    log.info('SyncAll triggered from UI')
    const result = await collectorManager.runAllCollectors()
    return result
  })

  // List source presets for the gallery UI
  ipcMain.handle('sources:listPresets', () => {
    return SOURCE_PRESETS
  })

  // Test a source config without saving — runs one collection cycle and returns sample reports
  ipcMain.handle('sources:test', async (_event, params: {
    type: string; config: Record<string, unknown>; name?: string
  }) => {
    try {
      let collector
      switch (params.type) {
        case 'api-endpoint':
          collector = new ApiEndpointCollector()
          break
        case 'telegram-subscriber':
          collector = new TelegramSubscriberCollector()
          break
        case 'github-repo':
          collector = new GitHubRepoCollector()
          break
        case 'rss':
          collector = new RssCollector()
          break
        default:
          return { success: false, message: `Unsupported type for testing: ${params.type}` }
      }

      // Initialize with a temp config (don't save to DB)
      await collector.initialize({
        id: 'test-' + Date.now(),
        name: params.name || 'Test Source',
        discipline: (params.config.discipline as Source['discipline']) || 'osint',
        type: params.type,
        config: params.config,
        schedule: null,
        enabled: true
      })

      const reports = await collector.collect()
      return {
        success: true,
        message: `Collected ${reports.length} reports`,
        sampleReports: reports.slice(0, 5).map((r) => ({
          title: r.title,
          severity: r.severity,
          discipline: r.discipline,
          contentSnippet: r.content.slice(0, 200),
          sourceUrl: r.sourceUrl,
          latitude: r.latitude,
          longitude: r.longitude
        }))
      }
    } catch (err) {
      log.warn(`Source test failed: ${err}`)
      return { success: false, message: String(err) }
    }
  })

  log.info('Sources bridge registered')
}

function mapSource(row: Record<string, unknown>): Source {
  return {
    id: row.id as string,
    name: row.name as string,
    discipline: row.discipline as Source['discipline'],
    type: row.type as string,
    config: JSON.parse((row.config as string) || '{}'),
    schedule: row.schedule as string | null,
    enabled: (row.enabled as number) === 1,
    lastCollectedAt: row.last_collected_at as number | null,
    lastError: row.last_error as string | null,
    errorCount: row.error_count as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  }
}
