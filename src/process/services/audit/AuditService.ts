import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export class AuditService {
  log(action: string, details?: Record<string, unknown>, sourceUrl?: string, httpStatus?: number): void {
    // Skip if action is missing/blank
    if (!action?.trim()) return

    // Skip if details is explicitly passed but empty/undefined
    if (details !== undefined && (details === null || Object.keys(details).length === 0)) return

    // Clean out undefined/null/blank values from details
    let cleanDetails: Record<string, unknown> | null = null
    if (details) {
      const cleaned: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(details)) {
        if (value !== undefined && value !== null && value !== '') {
          cleaned[key] = value
        }
      }
      cleanDetails = Object.keys(cleaned).length > 0 ? cleaned : null
    }

    // Skip if after cleaning there's nothing meaningful to log
    if (!cleanDetails && !sourceUrl?.trim() && httpStatus === undefined) return

    try {
      const db = getDatabase()
      db.prepare(
        'INSERT INTO audit_log (id, action, details, source_url, http_status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        generateId(),
        action.trim(),
        cleanDetails ? JSON.stringify(cleanDetails) : null,
        sourceUrl?.trim() || null,
        httpStatus ?? null,
        timestamp()
      )
    } catch (err) {
      log.error('Failed to write audit log:', err)
    }
  }

  getEntries(offset: number, limit: number, action?: string): { entries: Array<Record<string, unknown>>; total: number } {
    const db = getDatabase()

    let whereClause = ''
    const params: unknown[] = []

    if (action) {
      whereClause = 'WHERE action = ?'
      params.push(action)
    }

    const total = (
      db.prepare(`SELECT COUNT(*) as count FROM audit_log ${whereClause}`).get(...params) as { count: number }
    ).count

    const entries = db
      .prepare(`SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>

    return { entries, total }
  }
}

export const auditService = new AuditService()
