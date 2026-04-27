// Case File service — investigation grouping for reports, intel, entities,
// IOCs, and sources. Backed by case_files + case_file_items tables from
// migration 042.
//
// Conceptual model:
//   A case file is a long-running investigation ("Operation Bluefin") that
//   ties together heterogeneous artifacts: published reports + raw intel
//   reports + extracted entities + IOCs + sources. Items are referenced by
//   (item_type, item_id) — we don't physically duplicate the data.
//
// Lifecycle:
//   open    — active investigation, accepts new items
//   dormant — paused, but not closed
//   closed  — concluded; items still queryable but no new additions
//
// Multi-analyst support is deferred to v1.2 (RBAC). For now, every action
// is attributed to a generic 'analyst' string.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

export type CaseFileStatus = 'open' | 'dormant' | 'closed'

export type CaseFileItemType = 'report' | 'intel_report' | 'entity' | 'ioc' | 'source'

export interface CaseFile {
  id: string
  name: string
  description: string | null
  status: CaseFileStatus
  classification: string | null
  leadAnalyst: string | null
  tags: string[]
  createdAt: number
  updatedAt: number
  // Computed
  itemCount: number
  reportCount: number
}

export interface CaseFileItem {
  id: string
  caseFileId: string
  itemType: CaseFileItemType
  itemId: string
  addedBy: string | null
  addedAt: number
  notes: string | null
  // Optional denormalized summary (resolved at read time)
  summary?: string
  title?: string
}

export interface CreateCaseInput {
  name: string
  description?: string
  classification?: string
  leadAnalyst?: string
  tags?: string[]
  status?: CaseFileStatus
}

interface CaseRow {
  id: string
  name: string
  description: string | null
  status: string
  classification: string | null
  lead_analyst: string | null
  tags_json: string
  created_at: number
  updated_at: number
}

interface ItemRow {
  id: string
  case_file_id: string
  item_type: string
  item_id: string
  added_by: string | null
  added_at: number
  notes: string | null
}

function rowToCase(r: CaseRow, counts: { items: number; reports: number }): CaseFile {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status as CaseFileStatus,
    classification: r.classification,
    leadAnalyst: r.lead_analyst,
    tags: safeJson(r.tags_json, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    itemCount: counts.items,
    reportCount: counts.reports
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

export class CaseFileService {
  /** Create a new case file. Returns the created row. */
  create(input: CreateCaseInput): CaseFile {
    const id = generateId()
    const now = Date.now()
    getDatabase().prepare(`
      INSERT INTO case_files
        (id, name, description, status, classification, lead_analyst, tags_json,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name.trim().slice(0, 200),
      input.description ?? null,
      input.status ?? 'open',
      input.classification ?? null,
      input.leadAnalyst ?? null,
      JSON.stringify(input.tags ?? []),
      now, now
    )
    return this.get(id)!
  }

  get(id: string): CaseFile | null {
    const db = getDatabase()
    const row = db.prepare(`SELECT * FROM case_files WHERE id = ?`).get(id) as CaseRow | undefined
    if (!row) return null
    const counts = this.counts(id)
    return rowToCase(row, counts)
  }

  list(filters: { status?: CaseFileStatus | CaseFileStatus[]; tag?: string } = {}): CaseFile[] {
    const where: string[] = []
    const params: unknown[] = []

    const statuses = Array.isArray(filters.status) ? filters.status
      : filters.status ? [filters.status] : null
    if (statuses && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`)
      params.push(...statuses)
    }
    if (filters.tag) {
      where.push(`tags_json LIKE ?`)
      params.push(`%${JSON.stringify(filters.tag).slice(1, -1)}%`)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = getDatabase().prepare(
      `SELECT * FROM case_files ${whereSql} ORDER BY updated_at DESC`
    ).all(...params) as CaseRow[]

    return rows.map((r) => rowToCase(r, this.counts(r.id)))
  }

  update(id: string, patch: Partial<CreateCaseInput> & { status?: CaseFileStatus }): CaseFile | null {
    if (!this.get(id)) return null
    const fields: string[] = []
    const params: unknown[] = []

    if ('name' in patch && patch.name) {
      fields.push('name = ?'); params.push(patch.name.trim().slice(0, 200))
    }
    if ('description' in patch) {
      fields.push('description = ?'); params.push(patch.description ?? null)
    }
    if ('status' in patch && patch.status) {
      fields.push('status = ?'); params.push(patch.status)
    }
    if ('classification' in patch) {
      fields.push('classification = ?'); params.push(patch.classification ?? null)
    }
    if ('leadAnalyst' in patch) {
      fields.push('lead_analyst = ?'); params.push(patch.leadAnalyst ?? null)
    }
    if (patch.tags) {
      fields.push('tags_json = ?'); params.push(JSON.stringify(patch.tags))
    }

    if (fields.length === 0) return this.get(id)
    fields.push('updated_at = ?'); params.push(Date.now())
    params.push(id)

    getDatabase().prepare(
      `UPDATE case_files SET ${fields.join(', ')} WHERE id = ?`
    ).run(...params)
    return this.get(id)
  }

  delete(id: string): boolean {
    const r = getDatabase().prepare(`DELETE FROM case_files WHERE id = ?`).run(id)
    return r.changes > 0
  }

  // ── Items ────────────────────────────────────────────────────────────

  addItem(
    caseFileId: string,
    itemType: CaseFileItemType,
    itemId: string,
    opts: { notes?: string; addedBy?: string } = {}
  ): { ok: boolean; itemId?: string; reason?: string } {
    if (!this.get(caseFileId)) return { ok: false, reason: 'case_not_found' }

    // Idempotent — UNIQUE constraint on (case_file_id, item_type, item_id)
    const existing = getDatabase().prepare(
      `SELECT id FROM case_file_items WHERE case_file_id = ? AND item_type = ? AND item_id = ?`
    ).get(caseFileId, itemType, itemId) as { id: string } | undefined
    if (existing) return { ok: true, itemId: existing.id }

    const id = generateId()
    const now = Date.now()
    try {
      getDatabase().prepare(`
        INSERT INTO case_file_items
          (id, case_file_id, item_type, item_id, added_by, added_at, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, caseFileId, itemType, itemId, opts.addedBy ?? 'analyst', now, opts.notes ?? null)
      // Bump case file's updated_at
      getDatabase().prepare(`UPDATE case_files SET updated_at = ? WHERE id = ?`)
        .run(now, caseFileId)
      return { ok: true, itemId: id }
    } catch (err) {
      log.warn(`addItem failed: ${err}`)
      return { ok: false, reason: String(err) }
    }
  }

  removeItem(itemId: string): boolean {
    const r = getDatabase().prepare(`DELETE FROM case_file_items WHERE id = ?`).run(itemId)
    return r.changes > 0
  }

  /** List all items in a case file, optionally filtered by type. */
  listItems(caseFileId: string, type?: CaseFileItemType): CaseFileItem[] {
    const where = type
      ? `WHERE case_file_id = ? AND item_type = ?`
      : `WHERE case_file_id = ?`
    const params: unknown[] = type ? [caseFileId, type] : [caseFileId]
    const rows = getDatabase().prepare(
      `SELECT * FROM case_file_items ${where} ORDER BY added_at DESC`
    ).all(...params) as ItemRow[]

    return rows.map((r) => {
      const item: CaseFileItem = {
        id: r.id,
        caseFileId: r.case_file_id,
        itemType: r.item_type as CaseFileItemType,
        itemId: r.item_id,
        addedBy: r.added_by,
        addedAt: r.added_at,
        notes: r.notes
      }
      // Resolve summary for known item types
      this.resolveItemSummary(item)
      return item
    })
  }

  /** Find all case files containing a specific item. */
  casesContaining(itemType: CaseFileItemType, itemId: string): CaseFile[] {
    const rows = getDatabase().prepare(`
      SELECT cf.* FROM case_files cf
      JOIN case_file_items cfi ON cfi.case_file_id = cf.id
      WHERE cfi.item_type = ? AND cfi.item_id = ?
      ORDER BY cf.updated_at DESC
    `).all(itemType, itemId) as CaseRow[]
    return rows.map((r) => rowToCase(r, this.counts(r.id)))
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private counts(caseFileId: string): { items: number; reports: number } {
    const db = getDatabase()
    const items = (db.prepare(
      `SELECT COUNT(*) AS n FROM case_file_items WHERE case_file_id = ?`
    ).get(caseFileId) as { n: number }).n
    const reports = (db.prepare(
      `SELECT COUNT(*) AS n FROM case_file_items WHERE case_file_id = ? AND item_type = 'report'`
    ).get(caseFileId) as { n: number }).n
    return { items, reports }
  }

  /**
   * Best-effort summary lookup. Doesn't fail if the referenced row
   * has been deleted — we keep the orphaned reference in the case file
   * with an [orphaned] hint, so the audit trail stays intact.
   */
  private resolveItemSummary(item: CaseFileItem): void {
    const db = getDatabase()
    try {
      switch (item.itemType) {
        case 'report': {
          const r = db.prepare(`SELECT title, format, status FROM report_products WHERE id = ?`)
            .get(item.itemId) as { title: string; format: string; status: string } | undefined
          if (r) {
            item.title = r.title
            item.summary = `${r.format.toUpperCase()} · ${r.status}`
          } else {
            item.title = '[orphaned report]'
          }
          break
        }
        case 'intel_report': {
          const r = db.prepare(`SELECT title, source_name FROM intel_reports WHERE id = ?`)
            .get(item.itemId) as { title: string; source_name: string } | undefined
          if (r) {
            item.title = r.title
            item.summary = `Intel · ${r.source_name}`
          } else {
            item.title = '[orphaned intel]'
          }
          break
        }
        case 'entity': {
          const r = db.prepare(`SELECT name, type FROM intel_entities WHERE id = ?`)
            .get(item.itemId) as { name: string; type: string } | undefined
          if (r) {
            item.title = r.name
            item.summary = `Entity · ${r.type}`
          } else {
            item.title = '[orphaned entity]'
          }
          break
        }
        case 'ioc':
          item.title = item.itemId
          item.summary = 'IOC'
          break
        case 'source':
          item.title = item.itemId
          item.summary = 'Source'
          break
      }
    } catch (err) {
      log.debug(`resolveItemSummary failed for ${item.id}: ${err}`)
    }
  }

  /** Stats for the Cases page header. */
  stats(): { total: number; open: number; dormant: number; closed: number; totalItems: number } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM case_files`).get() as { n: number }).n
    const open = (db.prepare(`SELECT COUNT(*) AS n FROM case_files WHERE status='open'`).get() as { n: number }).n
    const dormant = (db.prepare(`SELECT COUNT(*) AS n FROM case_files WHERE status='dormant'`).get() as { n: number }).n
    const closed = (db.prepare(`SELECT COUNT(*) AS n FROM case_files WHERE status='closed'`).get() as { n: number }).n
    const totalItems = (db.prepare(`SELECT COUNT(*) AS n FROM case_file_items`).get() as { n: number }).n
    return { total, open, dormant, closed, totalItems }
  }
}

export const caseFileService = new CaseFileService()
