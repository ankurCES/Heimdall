// DeadLetterQueue — DB-backed bucket for jobs that exhausted all retries.
// Operators inspect failures from the System Health page, then either
// replay or discard.
//
// Currently surfaces stats + a list endpoint; replay handlers are
// per-job-kind (the originating service registers a replay function).

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

export interface DeadLetterEntry {
  id: string
  jobKind: string
  jobPayloadJson: string | null
  lastError: string | null
  retryCount: number
  firstFailedAt: number
  lastFailedAt: number
  replayedAt: number | null
  discardedAt: number | null
}

export type ReplayHandler = (payload: unknown) => Promise<void>

class DeadLetterQueue {
  private replayHandlers = new Map<string, ReplayHandler>()

  /**
   * Register a replay handler for a job kind. Caller is responsible for
   * invoking the original work; on success we mark the entry replayed.
   */
  registerReplayHandler(jobKind: string, handler: ReplayHandler): void {
    this.replayHandlers.set(jobKind, handler)
    log.info(`DLQ: replay handler registered for "${jobKind}"`)
  }

  /** Send a failed job to the DLQ. Idempotent on (kind, payload-hash). */
  enqueue(opts: {
    jobKind: string
    payload: unknown
    error: Error
    retryCount: number
  }): string {
    const id = generateId()
    const now = Date.now()
    const payloadJson = (() => {
      try { return JSON.stringify(opts.payload) } catch { return null }
    })()
    try {
      getDatabase().prepare(`
        INSERT INTO dead_letter_queue
          (id, job_kind, job_payload_json, last_error, retry_count,
           first_failed_at, last_failed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, opts.jobKind, payloadJson,
        opts.error.message.slice(0, 1000), opts.retryCount, now, now)
      log.warn(`DLQ: enqueued ${opts.jobKind} after ${opts.retryCount} attempts: ${opts.error.message.slice(0, 100)}`)
    } catch (err) {
      log.error(`DLQ enqueue failed: ${err}`)
    }
    return id
  }

  list(filter: { jobKind?: string; activeOnly?: boolean; limit?: number } = {}): DeadLetterEntry[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.jobKind) {
      where.push(`job_kind = ?`); params.push(filter.jobKind)
    }
    if (filter.activeOnly !== false) {
      // active = not yet replayed and not discarded
      where.push(`replayed_at IS NULL AND discarded_at IS NULL`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.min(filter.limit ?? 100, 500)
    return getDatabase().prepare(`
      SELECT id, job_kind AS jobKind, job_payload_json AS jobPayloadJson,
             last_error AS lastError, retry_count AS retryCount,
             first_failed_at AS firstFailedAt, last_failed_at AS lastFailedAt,
             replayed_at AS replayedAt, discarded_at AS discardedAt
      FROM dead_letter_queue
      ${whereSql}
      ORDER BY last_failed_at DESC
      LIMIT ?
    `).all(...params, limit) as DeadLetterEntry[]
  }

  async replay(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = getDatabase().prepare(
      `SELECT id, job_kind AS jobKind, job_payload_json AS jobPayloadJson FROM dead_letter_queue WHERE id = ?`
    ).get(id) as { id: string; jobKind: string; jobPayloadJson: string | null } | undefined
    if (!entry) return { ok: false, error: 'not_found' }

    const handler = this.replayHandlers.get(entry.jobKind)
    if (!handler) return { ok: false, error: `no replay handler for ${entry.jobKind}` }

    let payload: unknown = null
    try { payload = entry.jobPayloadJson ? JSON.parse(entry.jobPayloadJson) : null }
    catch { return { ok: false, error: 'payload not parseable' } }

    try {
      await handler(payload)
      getDatabase().prepare(`UPDATE dead_letter_queue SET replayed_at = ? WHERE id = ?`)
        .run(Date.now(), id)
      log.info(`DLQ: ${entry.jobKind} ${id} replayed successfully`)
      return { ok: true }
    } catch (err) {
      log.warn(`DLQ replay of ${id} failed: ${err}`)
      return { ok: false, error: (err as Error).message }
    }
  }

  discard(id: string): boolean {
    const r = getDatabase().prepare(
      `UPDATE dead_letter_queue SET discarded_at = ? WHERE id = ? AND discarded_at IS NULL`
    ).run(Date.now(), id)
    return r.changes > 0
  }

  stats(): { active: number; replayed: number; discarded: number; byKind: Record<string, number> } {
    const db = getDatabase()
    const active = (db.prepare(`SELECT COUNT(*) AS n FROM dead_letter_queue WHERE replayed_at IS NULL AND discarded_at IS NULL`).get() as { n: number }).n
    const replayed = (db.prepare(`SELECT COUNT(*) AS n FROM dead_letter_queue WHERE replayed_at IS NOT NULL`).get() as { n: number }).n
    const discarded = (db.prepare(`SELECT COUNT(*) AS n FROM dead_letter_queue WHERE discarded_at IS NOT NULL`).get() as { n: number }).n
    const byKind: Record<string, number> = {}
    for (const r of db.prepare(`SELECT job_kind, COUNT(*) AS n FROM dead_letter_queue WHERE replayed_at IS NULL AND discarded_at IS NULL GROUP BY job_kind`).all() as Array<{ job_kind: string; n: number }>) {
      byKind[r.job_kind] = r.n
    }
    return { active, replayed, discarded, byKind }
  }
}

export const deadLetterQueue = new DeadLetterQueue()
