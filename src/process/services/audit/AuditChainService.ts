import { createHash } from 'crypto'
import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

/**
 * Hash-chained tamper-evident audit log (Theme 10.4).
 *
 * Each row's hash chains over the previous row's hash:
 *
 *   this_hash = SHA256(prev_hash || sequence || action || actor || entity_type
 *                      || entity_id || classification || payload_json
 *                      || timestamp)
 *
 * Tampering with any historical row breaks the chain — verify() walks
 * sequentially and recomputes; the first mismatch identifies the tamper
 * point.
 *
 * The audit_log_chained table is created by migration 014.
 *
 * NOTE: This is separate from the existing AuditService (which logs
 * collector activity to a non-tamper-evident `audit_log` table). Use this
 * service for security-relevant events:
 *   - Classification changes (override up/down)
 *   - Exports (PDF / JSON / Obsidian sync of classified material)
 *   - Deletions (sources, sessions, reports)
 *   - Source rating changes (Admiralty A–F)
 *   - Settings changes that affect security posture (clearance, air-gap)
 */

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000'

export interface AuditChainEntry {
  id: string
  sequence: number
  action: string
  actor?: string
  entity_type?: string
  entity_id?: string
  classification?: string
  payload?: Record<string, unknown>
  timestamp: number
  prev_hash: string
  this_hash: string
}

export interface VerifyResult {
  ok: boolean
  totalRows: number
  firstMismatchSequence?: number
  firstMismatchEntry?: AuditChainEntry
  message: string
}

/** SHA256 over the canonical row payload. */
function computeHash(
  prev_hash: string,
  sequence: number,
  action: string,
  actor: string | undefined,
  entity_type: string | undefined,
  entity_id: string | undefined,
  classification: string | undefined,
  payload_json: string,
  timestamp: number
): string {
  const buf = [
    prev_hash,
    String(sequence),
    action,
    actor || '',
    entity_type || '',
    entity_id || '',
    classification || '',
    payload_json,
    String(timestamp)
  ].join('|')
  return createHash('sha256').update(buf).digest('hex')
}

interface RawRow {
  id: string
  sequence: number
  action: string
  actor: string | null
  entity_type: string | null
  entity_id: string | null
  classification: string | null
  payload: string | null
  timestamp: number
  prev_hash: string
  this_hash: string
}

function rowToEntry(r: RawRow): AuditChainEntry {
  let payload: Record<string, unknown> | undefined
  if (r.payload) {
    try { payload = JSON.parse(r.payload) } catch { payload = { _raw: r.payload } }
  }
  return {
    id: r.id,
    sequence: r.sequence,
    action: r.action,
    actor: r.actor || undefined,
    entity_type: r.entity_type || undefined,
    entity_id: r.entity_id || undefined,
    classification: r.classification || undefined,
    payload,
    timestamp: r.timestamp,
    prev_hash: r.prev_hash,
    this_hash: r.this_hash
  }
}

class AuditChainServiceImpl {
  /**
   * Append a new audit entry. Computes the hash + chains atomically. Safe to
   * call concurrently — wrapped in a transaction so sequence numbers stay
   * monotonic.
   *
   * Returns the newly-inserted entry (incl. computed hash) so callers can
   * surface it to the UI if needed.
   */
  append(
    action: string,
    opts: {
      actor?: string
      entityType?: string
      entityId?: string
      classification?: string
      payload?: Record<string, unknown>
    } = {}
  ): AuditChainEntry {
    const db = getDatabase()
    const ts = timestamp()
    const id = generateId()
    const payloadJson = opts.payload ? JSON.stringify(opts.payload) : ''

    let result!: AuditChainEntry
    db.transaction(() => {
      // Read tip
      const tip = db.prepare(
        'SELECT sequence, this_hash FROM audit_log_chained ORDER BY sequence DESC LIMIT 1'
      ).get() as { sequence: number; this_hash: string } | undefined

      const sequence = (tip?.sequence ?? 0) + 1
      const prev_hash = tip?.this_hash ?? GENESIS_HASH
      const this_hash = computeHash(
        prev_hash, sequence, action, opts.actor, opts.entityType,
        opts.entityId, opts.classification, payloadJson, ts
      )

      db.prepare(`
        INSERT INTO audit_log_chained
          (id, sequence, action, actor, entity_type, entity_id, classification, payload, timestamp, prev_hash, this_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, sequence, action,
        opts.actor || null, opts.entityType || null, opts.entityId || null,
        opts.classification || null, opts.payload ? payloadJson : null,
        ts, prev_hash, this_hash
      )

      result = {
        id, sequence, action,
        actor: opts.actor, entity_type: opts.entityType, entity_id: opts.entityId,
        classification: opts.classification, payload: opts.payload,
        timestamp: ts, prev_hash, this_hash
      }
    })()

    log.info(`AuditChain: ${action} (seq ${result.sequence}) ${opts.entityType ? `${opts.entityType}:${opts.entityId}` : ''}`)
    return result
  }

  /**
   * Read a page of audit entries (descending by sequence — newest first).
   */
  list(opts: { limit?: number; offset?: number; entityType?: string; entityId?: string } = {}): AuditChainEntry[] {
    const db = getDatabase()
    const limit = Math.min(opts.limit ?? 100, 500)
    const offset = opts.offset ?? 0

    let q = 'SELECT * FROM audit_log_chained'
    const where: string[] = []
    const vals: unknown[] = []
    if (opts.entityType) { where.push('entity_type = ?'); vals.push(opts.entityType) }
    if (opts.entityId)   { where.push('entity_id = ?');   vals.push(opts.entityId) }
    if (where.length) q += ' WHERE ' + where.join(' AND ')
    q += ' ORDER BY sequence DESC LIMIT ? OFFSET ?'
    vals.push(limit, offset)

    const rows = db.prepare(q).all(...vals) as RawRow[]
    return rows.map(rowToEntry)
  }

  count(): number {
    const db = getDatabase()
    return (db.prepare('SELECT COUNT(*) AS c FROM audit_log_chained').get() as { c: number }).c
  }

  /**
   * Walk the entire chain in ascending order and verify each hash. Returns
   * { ok: true } if untampered; otherwise reports the first mismatched
   * sequence number so an analyst can investigate.
   */
  verify(): VerifyResult {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM audit_log_chained ORDER BY sequence ASC').all() as RawRow[]
    if (rows.length === 0) return { ok: true, totalRows: 0, message: 'Audit chain is empty.' }

    let prevHash = GENESIS_HASH
    for (const r of rows) {
      // Check chain linkage
      if (r.prev_hash !== prevHash) {
        return {
          ok: false,
          totalRows: rows.length,
          firstMismatchSequence: r.sequence,
          firstMismatchEntry: rowToEntry(r),
          message: `Chain break at sequence ${r.sequence}: prev_hash does not match the previous row's this_hash. Possible insertion or deletion.`
        }
      }
      // Check this row's hash
      const expected = computeHash(
        r.prev_hash, r.sequence, r.action, r.actor || undefined,
        r.entity_type || undefined, r.entity_id || undefined,
        r.classification || undefined, r.payload || '', r.timestamp
      )
      if (expected !== r.this_hash) {
        return {
          ok: false,
          totalRows: rows.length,
          firstMismatchSequence: r.sequence,
          firstMismatchEntry: rowToEntry(r),
          message: `Hash mismatch at sequence ${r.sequence}: row contents have been modified after insertion.`
        }
      }
      prevHash = r.this_hash
    }
    return { ok: true, totalRows: rows.length, message: `Verified ${rows.length} entries — chain is intact.` }
  }
}

export const auditChainService = new AuditChainServiceImpl()
