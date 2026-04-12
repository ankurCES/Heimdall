import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { getDatabase } from '../services/database'
import { collectorManager } from '../collectors/CollectorManager'
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
