import { getDatabase } from '../database'
import { encrypt, decrypt, isSensitiveKey } from '../crypto'
import { timestamp } from '@common/utils/id'
import log from 'electron-log'

export class SettingsService {
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

    log.info(`Settings updated: ${key}`)
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
