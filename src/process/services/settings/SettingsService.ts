import { EventEmitter } from 'events'
import { getDatabase } from '../database'
import { encrypt, decrypt, isSensitiveKey } from '../crypto'
import { timestamp } from '@common/utils/id'
import log from 'electron-log'

/**
 * v1.3.2 — extends EventEmitter so consumer services can subscribe to
 * settings changes and re-apply config without requiring an app restart.
 *
 * Events:
 *   'change'         — fires for every set() with { key, value }
 *   'change:<key>'   — fires only for the specific key
 *   'change:section:<section>'  — fires for set('<section>.something', ...)
 *
 * Listeners should be added during service init and removed in cleanup
 * to avoid leaks across re-init paths.
 */
export class SettingsService extends EventEmitter {
  get<T = unknown>(key: string): T | null {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined

    if (!row) return null

    try {
      const raw = isSensitiveKey(key) ? decrypt(row.value) : row.value
      return JSON.parse(raw) as T
    } catch {
      return row.value as unknown as T
    }
  }

  set(key: string, value: unknown): void {
    const db = getDatabase()
    const serialized = JSON.stringify(value)
    const stored = isSensitiveKey(key) ? encrypt(serialized) : serialized
    const now = timestamp()

    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?'
    ).run(key, stored, now, stored, now)

    // SECURITY (v1.3.2 — finding 7.1): downgrade key-name leak to debug.
    log.debug(`Settings updated: ${key}`)

    // FUNCTIONAL FIX (v1.3.2 — finding C3): emit so subscribed services
    // can re-apply config without an app restart.
    try {
      this.emit('change', { key, value })
      this.emit(`change:${key}`, value)
      const dotIdx = key.indexOf('.')
      if (dotIdx > 0) this.emit(`change:section:${key.slice(0, dotIdx)}`, { key, value })
    } catch (err) {
      log.debug(`SettingsService change emit failed: ${err}`)
    }
  }

  getSection(section: string): Record<string, unknown> {
    const db = getDatabase()
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ? || '.%'")
      .all(section) as Array<{ key: string; value: string }>

    const result: Record<string, unknown> = {}
    for (const row of rows) {
      const subKey = row.key.slice(section.length + 1)
      try {
        const raw = isSensitiveKey(row.key) ? decrypt(row.value) : row.value
        result[subKey] = JSON.parse(raw)
      } catch {
        result[subKey] = row.value
      }
    }
    return result
  }

  delete(key: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAll(): Record<string, unknown> {
    const db = getDatabase()
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: string
    }>

    const result: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        const raw = isSensitiveKey(row.key) ? decrypt(row.value) : row.value
        result[row.key] = JSON.parse(raw)
      } catch {
        result[row.key] = row.value
      }
    }
    return result
  }
}

export const settingsService = new SettingsService()
