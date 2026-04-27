// First-class report library — CRUD + FTS5 search over report_products.
//
// Reports flow into this table via two paths:
//   1. Manual promotion ("Promote to Library" button on a chat assistant
//      message that contains a generated report).
//   2. One-shot startup migration on first boot of v1.1 — see
//      ReportPromotionService.runStartupMigration().
//
// The status lifecycle:
//   draft     → initial state on promotion (analyst can still tweak)
//   published → analyst has explicitly published
//   revised   → a newer version exists (parent_report_id chain)
//   superseded → marked obsolete by a later report
//
// FTS5 indexing is automatic via triggers in migration 042. We expose a
// ranked search() method that uses BM25 scoring with a deterministic LIKE
// fallback when the FTS query parser rejects the input.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

export type ReportFormat = 'nie' | 'pdb' | 'iir' | 'assessment'
export type ReportStatus = 'draft' | 'published' | 'revised' | 'superseded'

export interface ReportProduct {
  id: string
  sessionId: string | null
  workflowRunId: string | null
  parentReportId: string | null
  version: number
  title: string
  format: ReportFormat
  classification: string
  query: string | null
  bodyMarkdown: string
  tradecraftScore: number | null
  tradecraftDeficiencies: string[]
  wasRegenerated: boolean
  modelUsed: string | null
  llmConnection: string | null
  sourceFindingsSha: string | null
  generatedAt: number
  status: ReportStatus
  supersededById: string | null
  tags: string[]
  regionTags: string[]
  createdAt: number
  updatedAt: number
}

export interface CreateReportInput {
  sessionId?: string | null
  workflowRunId?: string | null
  parentReportId?: string | null
  title: string
  format: ReportFormat
  classification?: string
  query?: string
  bodyMarkdown: string
  tradecraftScore?: number | null
  tradecraftDeficiencies?: string[]
  wasRegenerated?: boolean
  modelUsed?: string
  llmConnection?: string
  sourceFindingsSha?: string
  generatedAt?: number
  status?: ReportStatus
  tags?: string[]
  regionTags?: string[]
}

export interface ReportListFilters {
  status?: ReportStatus | ReportStatus[]
  format?: ReportFormat | ReportFormat[]
  minScore?: number
  fromDate?: number
  toDate?: number
  tag?: string
  region?: string
  limit?: number
  offset?: number
  orderBy?: 'recent' | 'score' | 'title'
}

export interface ReportSearchResult {
  reports: ReportProduct[]
  total: number
  query?: string
}

interface DbRow {
  id: string
  session_id: string | null
  workflow_run_id: string | null
  parent_report_id: string | null
  version: number
  title: string
  format: string
  classification: string
  query: string | null
  body_markdown: string
  tradecraft_score: number | null
  tradecraft_deficiencies_json: string | null
  was_regenerated: number
  model_used: string | null
  llm_connection: string | null
  source_findings_sha: string | null
  generated_at: number
  status: string
  superseded_by_id: string | null
  tags_json: string
  region_tags_json: string
  created_at: number
  updated_at: number
}

function rowToReport(r: DbRow): ReportProduct {
  return {
    id: r.id,
    sessionId: r.session_id,
    workflowRunId: r.workflow_run_id,
    parentReportId: r.parent_report_id,
    version: r.version,
    title: r.title,
    format: r.format as ReportFormat,
    classification: r.classification,
    query: r.query,
    bodyMarkdown: r.body_markdown,
    tradecraftScore: r.tradecraft_score,
    tradecraftDeficiencies: r.tradecraft_deficiencies_json ? safeJson(r.tradecraft_deficiencies_json, []) : [],
    wasRegenerated: !!r.was_regenerated,
    modelUsed: r.model_used,
    llmConnection: r.llm_connection,
    sourceFindingsSha: r.source_findings_sha,
    generatedAt: r.generated_at,
    status: r.status as ReportStatus,
    supersededById: r.superseded_by_id,
    tags: safeJson(r.tags_json, []),
    regionTags: safeJson(r.region_tags_json, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

export class ReportLibraryService {
  /** Insert a new report. Auto-generates id if not provided. */
  create(input: CreateReportInput): ReportProduct {
    const now = Date.now()
    const id = generateId()
    const db = getDatabase()
    db.prepare(`
      INSERT INTO report_products (
        id, session_id, workflow_run_id, parent_report_id, version,
        title, format, classification, query, body_markdown,
        tradecraft_score, tradecraft_deficiencies_json, was_regenerated,
        model_used, llm_connection, source_findings_sha,
        generated_at, status, tags_json, region_tags_json,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 1,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      id,
      input.sessionId ?? null,
      input.workflowRunId ?? null,
      input.parentReportId ?? null,
      input.title,
      input.format,
      input.classification ?? 'UNCLASSIFIED//FOUO',
      input.query ?? null,
      input.bodyMarkdown,
      input.tradecraftScore ?? null,
      input.tradecraftDeficiencies ? JSON.stringify(input.tradecraftDeficiencies) : null,
      input.wasRegenerated ? 1 : 0,
      input.modelUsed ?? null,
      input.llmConnection ?? null,
      input.sourceFindingsSha ?? null,
      input.generatedAt ?? now,
      input.status ?? 'draft',
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.regionTags ?? []),
      now,
      now
    )
    return this.get(id)!
  }

  get(id: string): ReportProduct | null {
    const row = getDatabase().prepare(
      `SELECT * FROM report_products WHERE id = ?`
    ).get(id) as DbRow | undefined
    return row ? rowToReport(row) : null
  }

  list(filters: ReportListFilters = {}): ReportSearchResult {
    const where: string[] = []
    const params: unknown[] = []

    const statuses = Array.isArray(filters.status) ? filters.status
      : filters.status ? [filters.status] : null
    if (statuses && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`)
      params.push(...statuses)
    }

    const formats = Array.isArray(filters.format) ? filters.format
      : filters.format ? [filters.format] : null
    if (formats && formats.length > 0) {
      where.push(`format IN (${formats.map(() => '?').join(',')})`)
      params.push(...formats)
    }

    if (typeof filters.minScore === 'number') {
      where.push(`tradecraft_score >= ?`)
      params.push(filters.minScore)
    }
    if (filters.fromDate) {
      where.push(`generated_at >= ?`)
      params.push(filters.fromDate)
    }
    if (filters.toDate) {
      where.push(`generated_at <= ?`)
      params.push(filters.toDate)
    }
    if (filters.tag) {
      where.push(`tags_json LIKE ?`)
      params.push(`%${JSON.stringify(filters.tag).slice(1, -1)}%`)
    }
    if (filters.region) {
      where.push(`region_tags_json LIKE ?`)
      params.push(`%${JSON.stringify(filters.region).slice(1, -1)}%`)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const orderSql = filters.orderBy === 'score' ? 'tradecraft_score DESC NULLS LAST'
      : filters.orderBy === 'title' ? 'title COLLATE NOCASE'
      : 'generated_at DESC'

    const limit = Math.min(filters.limit ?? 50, 500)
    const offset = filters.offset ?? 0

    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM report_products ${whereSql}`)
      .get(...params) as { n: number }).n
    const rows = db.prepare(
      `SELECT * FROM report_products ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as DbRow[]

    return { reports: rows.map(rowToReport), total }
  }

  /**
   * Full-text search via FTS5. Falls back to LIKE when the query has
   * unbalanced quotes or other parser-hostile input.
   */
  search(query: string, limit: number = 50): ReportSearchResult {
    if (!query || query.trim().length < 2) return this.list({ limit })

    const safeQuery = this.toFtsQuery(query)
    const db = getDatabase()

    try {
      const rows = db.prepare(`
        SELECT rp.*, bm25(report_products_fts) AS rank
        FROM report_products_fts
        JOIN report_products rp ON rp.rowid = report_products_fts.rowid
        WHERE report_products_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(safeQuery, limit) as Array<DbRow & { rank: number }>
      return {
        reports: rows.map(rowToReport),
        total: rows.length,
        query
      }
    } catch (err) {
      log.debug(`FTS search failed (${err}), falling back to LIKE`)
      const like = `%${query.replace(/[%_]/g, (s) => '\\' + s)}%`
      const rows = db.prepare(`
        SELECT * FROM report_products
        WHERE title LIKE ? ESCAPE '\\' OR body_markdown LIKE ? ESCAPE '\\'
        ORDER BY generated_at DESC LIMIT ?
      `).all(like, like, limit) as DbRow[]
      return { reports: rows.map(rowToReport), total: rows.length, query }
    }
  }

  /** Build an FTS5 query: tokenize, drop bad chars, OR-join with prefix. */
  private toFtsQuery(raw: string): string {
    const tokens = raw
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 8)
    if (tokens.length === 0) return raw
    return tokens.map((t) => `${t}*`).join(' OR ')
  }

  update(id: string, patch: Partial<CreateReportInput>): ReportProduct | null {
    const existing = this.get(id)
    if (!existing) return null

    const fields: string[] = []
    const params: unknown[] = []

    const map: Record<string, string> = {
      title: 'title', format: 'format', classification: 'classification',
      query: 'query', bodyMarkdown: 'body_markdown',
      modelUsed: 'model_used', status: 'status'
    }
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        fields.push(`${col} = ?`)
        params.push((patch as Record<string, unknown>)[k])
      }
    }
    if (patch.tags) {
      fields.push('tags_json = ?'); params.push(JSON.stringify(patch.tags))
    }
    if (patch.regionTags) {
      fields.push('region_tags_json = ?'); params.push(JSON.stringify(patch.regionTags))
    }
    if (patch.tradecraftScore !== undefined) {
      fields.push('tradecraft_score = ?'); params.push(patch.tradecraftScore)
    }
    if (patch.tradecraftDeficiencies) {
      fields.push('tradecraft_deficiencies_json = ?'); params.push(JSON.stringify(patch.tradecraftDeficiencies))
    }

    if (fields.length === 0) return existing

    fields.push('updated_at = ?')
    params.push(Date.now())
    params.push(id)

    getDatabase().prepare(
      `UPDATE report_products SET ${fields.join(', ')} WHERE id = ?`
    ).run(...params)

    return this.get(id)
  }

  delete(id: string): boolean {
    // FUNCTIONAL FIX (v1.3.2 — finding E3): manual cascade. Heimdall's
    // schema doesn't carry FK ON DELETE CASCADE on these references, so
    // a bare DELETE leaves orphans in 6 tables that downstream services
    // continue scanning forever. Run the deletes in one transaction.
    const db = getDatabase()
    const tx = db.transaction(() => {
      // First find indicator ids belonging to this report (so we can
      // cascade to indicator_observations).
      const indicatorIds = db.prepare(
        `SELECT id FROM report_indicators WHERE report_id = ?`
      ).all(id) as Array<{ id: string }>
      for (const ind of indicatorIds) {
        db.prepare(`DELETE FROM indicator_observations WHERE indicator_id = ?`).run(ind.id)
      }
      db.prepare(`DELETE FROM report_indicators WHERE report_id = ?`).run(id)

      // Forecast claims + outcomes
      const claimIds = db.prepare(
        `SELECT id FROM forecast_claims WHERE report_id = ?`
      ).all(id) as Array<{ id: string }>
      for (const c of claimIds) {
        db.prepare(`DELETE FROM forecast_outcomes WHERE claim_id = ?`).run(c.id)
      }
      db.prepare(`DELETE FROM forecast_claims WHERE report_id = ?`).run(id)

      // Revisions, distributions, ethics flags, case-file refs, scores
      db.prepare(`DELETE FROM report_revisions WHERE report_id = ?`).run(id)
      db.prepare(`DELETE FROM report_distributions WHERE report_id = ?`).run(id)
      db.prepare(`DELETE FROM ethics_flags WHERE subject_type = 'report' AND subject_id = ?`).run(id)
      db.prepare(`DELETE FROM case_file_items WHERE item_type = 'report' AND item_id = ?`).run(id)
      try { db.prepare(`DELETE FROM report_quality_scores WHERE session_id = ?`).run(id) } catch { /* */ }

      // Finally the report itself
      db.prepare(`DELETE FROM report_products WHERE id = ?`).run(id)
    })

    try {
      tx()
      return true
    } catch (err) {
      log.warn(`ReportLibraryService.delete cascade failed: ${err}`)
      return false
    }
  }

  /** Mark as published; idempotent. */
  publish(id: string): ReportProduct | null {
    const r = this.get(id)
    if (!r) return null
    if (r.status === 'published') return r
    return this.update(id, { status: 'published' })
  }

  /**
   * Create a new version of an existing report. Sets parent_report_id,
   * increments version, marks the parent as 'revised'.
   */
  revise(parentId: string, newBody: string, opts: Partial<CreateReportInput> = {}): ReportProduct | null {
    const parent = this.get(parentId)
    if (!parent) return null
    // Carry forward the metadata fields that map cleanly to CreateReportInput.
    // We don't spread `parent` directly because ReportProduct has runtime-
    // managed fields (id, version, createdAt) that aren't CreateReportInput.
    const child = this.create({
      sessionId: parent.sessionId,
      workflowRunId: parent.workflowRunId,
      parentReportId: parentId,
      title: opts.title ?? parent.title,
      format: opts.format ?? parent.format,
      classification: opts.classification ?? parent.classification,
      query: opts.query ?? parent.query ?? undefined,
      bodyMarkdown: newBody,
      tradecraftScore: opts.tradecraftScore ?? null,
      tradecraftDeficiencies: opts.tradecraftDeficiencies ?? [],
      modelUsed: opts.modelUsed ?? parent.modelUsed ?? undefined,
      llmConnection: opts.llmConnection ?? parent.llmConnection ?? undefined,
      tags: opts.tags ?? parent.tags,
      regionTags: opts.regionTags ?? parent.regionTags,
      status: 'draft'
    })
    getDatabase().prepare(
      `UPDATE report_products SET version = ? WHERE id = ?`
    ).run(parent.version + 1, child.id)
    this.update(parentId, { status: 'revised' })
    return this.get(child.id)
  }

  /** Get all versions in a parent → child chain, oldest first. */
  versionChain(id: string): ReportProduct[] {
    const all: ReportProduct[] = []
    let current = this.get(id)
    if (!current) return []
    // Walk to root
    while (current && current.parentReportId) {
      const parent = this.get(current.parentReportId)
      if (!parent) break
      current = parent
    }
    // Walk forward
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      all.push(current)
      const next = getDatabase().prepare(
        `SELECT * FROM report_products WHERE parent_report_id = ? ORDER BY version DESC LIMIT 1`
      ).get(current.id) as DbRow | undefined
      current = next ? rowToReport(next) : null
    }
    return all
  }

  /** Quick stats for the Library page header. */
  stats(): {
    total: number
    drafts: number
    published: number
    revised: number
    avgScore: number | null
    byFormat: Record<string, number>
  } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM report_products`).get() as { n: number }).n
    const drafts = (db.prepare(`SELECT COUNT(*) AS n FROM report_products WHERE status='draft'`).get() as { n: number }).n
    const published = (db.prepare(`SELECT COUNT(*) AS n FROM report_products WHERE status='published'`).get() as { n: number }).n
    const revised = (db.prepare(`SELECT COUNT(*) AS n FROM report_products WHERE status='revised'`).get() as { n: number }).n
    const avgRow = db.prepare(`SELECT AVG(tradecraft_score) AS avg FROM report_products WHERE tradecraft_score IS NOT NULL`).get() as { avg: number | null }
    const byFormat: Record<string, number> = {}
    for (const r of db.prepare(`SELECT format, COUNT(*) AS n FROM report_products GROUP BY format`).all() as Array<{ format: string; n: number }>) {
      byFormat[r.format] = r.n
    }
    return {
      total, drafts, published, revised,
      avgScore: avgRow.avg !== null ? Math.round(avgRow.avg) : null,
      byFormat
    }
  }
}

export const reportLibraryService = new ReportLibraryService()
