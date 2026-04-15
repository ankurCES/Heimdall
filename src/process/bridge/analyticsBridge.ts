/**
 * Analytics Bridge — powers the Power BI-style Explore page.
 *
 * Responsibilities:
 *   - CRUD for saved analytics reports (analytics_reports table)
 *   - Generic widget-query endpoint (analytics:queryWidget) that runs
 *     whitelisted aggregations against several data sources
 *
 * Security model:
 *   Every user-supplied field, operator, and dataSource is validated against
 *   a whitelist before it reaches SQL. Values are always bound via
 *   better-sqlite3 parameters, never string-concatenated.
 */
import { ipcMain } from 'electron'
import { getDatabase } from '../services/database'
import { generateId, timestamp } from '@common/utils/id'
import type {
  AnalyticsReport, ReportMeta, WidgetQuerySpec, WidgetQueryResult,
  FilterSpec, FilterOp, GlobalFilterState, GroupBy, Metric, DataSource, TimeRange
} from '@common/analytics/types'
import log from 'electron-log'

// --------------------- Whitelists ---------------------

type DataSourceSpec = {
  table: string
  columns: Record<string, string>       // logical field -> SQL column
  timeColumn: string
  defaultOrder?: string
}

const DATA_SOURCES: Record<DataSource, DataSourceSpec> = {
  intel: {
    table: 'intel_reports',
    columns: {
      discipline: 'discipline',
      severity: 'severity',
      source: 'source_name',
      source_name: 'source_name',
      source_id: 'source_id',
      title: 'title',
      verification: 'verification_score',
      reviewed: 'reviewed'
    },
    timeColumn: 'created_at'
  },
  entities: {
    table: 'intel_entities',
    columns: {
      entity_type: 'entity_type',
      entity_value: 'entity_value',
      confidence: 'confidence',
      report_id: 'report_id'
    },
    timeColumn: 'created_at'
  },
  tags: {
    table: 'intel_tags',
    columns: {
      tag: 'tag',
      confidence: 'confidence',
      source: 'source',
      report_id: 'report_id'
    },
    timeColumn: 'created_at'
  },
  sources: {
    table: 'sources',
    columns: {
      name: 'name',
      discipline: 'discipline',
      type: 'type',
      enabled: 'enabled'
    },
    timeColumn: 'created_at'
  },
  market_quotes: {
    table: 'market_quotes',
    columns: {
      ticker: 'ticker',
      name: 'name',
      category: 'category',
      price: 'price',
      change_pct: 'change_pct'
    },
    timeColumn: 'recorded_at'
  },
  watch_terms: {
    table: 'watch_terms',
    columns: {
      term: 'term',
      source: 'source',
      category: 'category',
      priority: 'priority',
      hits: 'hits',
      enabled: 'enabled'
    },
    timeColumn: 'created_at'
  },
  tokens: {
    table: 'token_usage',
    columns: {
      model: 'model',
      total_tokens: 'total_tokens',
      prompt_tokens: 'prompt_tokens',
      completion_tokens: 'completion_tokens'
    },
    timeColumn: 'created_at'
  }
}

const GROUPBY_EXPRESSIONS: Record<string, (ds: DataSourceSpec) => string | null> = {
  discipline: (ds) => ds.columns.discipline || null,
  severity: (ds) => ds.columns.severity || null,
  source: (ds) => ds.columns.source || ds.columns.source_name || ds.columns.name || null,
  source_type: (ds) => ds.columns.type || null,
  date: (ds) => `date(${ds.timeColumn}/1000, 'unixepoch')`,
  hour: (ds) => `strftime('%H', ${ds.timeColumn}/1000, 'unixepoch')`,
  dow_hour: (ds) => `strftime('%w-%H', ${ds.timeColumn}/1000, 'unixepoch')`,
  entity_type: (ds) => ds.columns.entity_type || null,
  entity_value: (ds) => ds.columns.entity_value || null,
  tag: (ds) => ds.columns.tag || null,
  ticker: (ds) => ds.columns.ticker || null,
  category: (ds) => ds.columns.category || null,
  none: () => null
}

const FILTER_OPS: Record<FilterOp, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  in: 'IN',
  nin: 'NOT IN',
  contains: 'LIKE'
}

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000
}

// --------------------- Helpers ---------------------

function rangeMs(tr?: TimeRange): number | null {
  if (!tr || tr === 'all') return null
  return TIME_RANGE_MS[tr] ?? null
}

function buildFilterClause(ds: DataSourceSpec, filters: FilterSpec[] | undefined): { clause: string; values: unknown[] } {
  if (!filters || filters.length === 0) return { clause: '', values: [] }
  const parts: string[] = []
  const values: unknown[] = []
  for (const f of filters) {
    const col = ds.columns[f.field]
    if (!col) continue // silently skip unknown field — defensive
    const op = FILTER_OPS[f.op]
    if (!op) continue
    if (f.op === 'in' || f.op === 'nin') {
      const arr = Array.isArray(f.value) ? f.value : [f.value]
      if (arr.length === 0) continue
      parts.push(`${col} ${op} (${arr.map(() => '?').join(',')})`)
      values.push(...arr)
    } else if (f.op === 'contains') {
      parts.push(`${col} LIKE ?`)
      values.push(`%${String(f.value)}%`)
    } else {
      parts.push(`${col} ${op} ?`)
      values.push(f.value)
    }
  }
  return { clause: parts.length ? parts.join(' AND ') : '', values }
}

function buildMetricExpr(metric: Metric, ds: DataSourceSpec): string {
  switch (metric) {
    case 'count': return 'COUNT(*)'
    case 'avg_verification': return `ROUND(AVG(${ds.columns.verification || 'verification_score'}), 1)`
    case 'distinct_sources': {
      const col = ds.columns.source || ds.columns.source_name || ds.columns.name
      return col ? `COUNT(DISTINCT ${col})` : 'COUNT(*)'
    }
    case 'sum_change_pct': return 'SUM(ABS(change_pct))'
    case 'avg_change_pct': return 'ROUND(AVG(ABS(change_pct)), 2)'
    case 'latest_price': return 'MAX(price)'
    case 'reviewed_pct': return `ROUND(100.0 * SUM(CASE WHEN ${ds.columns.reviewed || 'reviewed'} = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1)`
    default: return 'COUNT(*)'
  }
}

function mergeGlobalFilters(widget: WidgetQuerySpec): { filters: FilterSpec[]; timeRange: TimeRange } {
  const out: FilterSpec[] = [...(widget.filters || [])]
  let tr: TimeRange = widget.timeRange || '24h'
  if (!widget.ignoreGlobalFilters && widget.globalFilters) {
    const g = widget.globalFilters
    if (g.timeRange && !widget.timeRange) tr = g.timeRange
    const ds = DATA_SOURCES[widget.dataSource]
    if (g.disciplines?.length && ds.columns.discipline) {
      out.push({ field: 'discipline', op: 'in', value: g.disciplines })
    }
    if (g.severities?.length && ds.columns.severity) {
      out.push({ field: 'severity', op: 'in', value: g.severities })
    }
    if (g.sources?.length && (ds.columns.source || ds.columns.source_name || ds.columns.name)) {
      const field = ds.columns.source ? 'source' : (ds.columns.source_name ? 'source_name' : 'name')
      out.push({ field, op: 'in', value: g.sources })
    }
  }
  return { filters: out, timeRange: tr }
}

// --------------------- Query executor ---------------------

function runWidgetQuery(spec: WidgetQuerySpec): WidgetQueryResult {
  const ds = DATA_SOURCES[spec.dataSource]
  if (!ds) throw new Error(`Unknown dataSource: ${spec.dataSource}`)

  const db = getDatabase()
  const { filters, timeRange } = mergeGlobalFilters(spec)
  const range = rangeMs(timeRange)
  const groupByExpr = GROUPBY_EXPRESSIONS[spec.groupBy || 'none']?.(ds) ?? null
  const metricExpr = buildMetricExpr(spec.metric, ds)
  const { clause: filterClause, values } = buildFilterClause(ds, filters)

  const whereParts: string[] = []
  if (filterClause) whereParts.push(filterClause)
  if (range !== null) {
    whereParts.push(`${ds.timeColumn} >= ?`)
    values.push(Date.now() - range)
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''

  const limit = Math.min(spec.limit ?? 50, 500)

  // If groupBy is 'none' → return a single aggregated value (used by KPI widgets)
  if (!groupByExpr) {
    const row = db.prepare(`SELECT ${metricExpr} AS v FROM ${ds.table} ${where}`).get(...values) as { v: number | null } | undefined
    const value = row?.v ?? 0

    // Compute delta vs previous period (equal-length window immediately prior)
    let delta: number | undefined
    if (range !== null) {
      const prevWhere = whereParts.slice()
      const prevValues = values.slice(0, -1)
      prevWhere[prevWhere.length - 1] = `${ds.timeColumn} >= ? AND ${ds.timeColumn} < ?`
      prevValues.push(Date.now() - 2 * range, Date.now() - range)
      const prevRow = db.prepare(`SELECT ${metricExpr} AS v FROM ${ds.table} WHERE ${prevWhere.join(' AND ')}`).get(...prevValues) as { v: number | null } | undefined
      const prev = prevRow?.v ?? 0
      if (prev > 0) delta = Math.round(((Number(value) - Number(prev)) / Number(prev)) * 100)
    }

    return {
      data: [{ label: 'total', value: Number(value) || 0 }],
      total: Number(value) || 0,
      delta,
      meta: { rangeMs: range ?? undefined }
    }
  }

  // Grouped query
  const rows = db.prepare(`
    SELECT ${groupByExpr} AS label, ${metricExpr} AS value
    FROM ${ds.table}
    ${where}
    GROUP BY ${groupByExpr}
    ORDER BY value DESC
    LIMIT ?
  `).all(...values, limit) as Array<{ label: string | number | null; value: number | null }>

  const data = rows.map((r) => ({
    label: r.label == null ? 'unknown' : String(r.label),
    value: Number(r.value) || 0
  }))

  // If bucketMinutes is set, also return a timeline as a second series
  let timeline: WidgetQueryResult['timeline']
  if (spec.bucketMinutes && spec.bucketMinutes > 0) {
    const bucket = spec.bucketMinutes * 60 * 1000
    const tlRows = db.prepare(`
      SELECT (${ds.timeColumn} / ?) * ? AS bucket, ${metricExpr} AS value
      FROM ${ds.table}
      ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(bucket, bucket, ...values) as Array<{ bucket: number; value: number }>
    timeline = tlRows.map((r) => ({ bucket: r.bucket, count: r.value }))
  }

  return {
    data,
    timeline,
    meta: { bucketCount: data.length, rangeMs: range ?? undefined }
  }
}

// --------------------- Row mappers ---------------------

interface ReportRow {
  id: string
  name: string
  description: string | null
  icon: string | null
  layout: string
  widgets: string
  global_filters: string | null
  is_preset: number
  created_at: number
  updated_at: number
}

function mapReport(row: ReportRow): AnalyticsReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    icon: row.icon || undefined,
    layout: JSON.parse(row.layout),
    widgets: JSON.parse(row.widgets),
    globalFilters: row.global_filters ? JSON.parse(row.global_filters) : { timeRange: '24h' },
    isPreset: row.is_preset === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapMeta(row: ReportRow): ReportMeta {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    icon: row.icon || undefined,
    isPreset: row.is_preset === 1,
    updatedAt: row.updated_at
  }
}

// --------------------- Bridge registration ---------------------

export function registerAnalyticsBridge(): void {
  ipcMain.handle('analytics:listReports', () => {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at
      FROM analytics_reports
      ORDER BY is_preset DESC, updated_at DESC
    `).all() as ReportRow[]
    return rows.map(mapMeta)
  })

  ipcMain.handle('analytics:getReport', (_evt, params: { id: string }) => {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at
      FROM analytics_reports
      WHERE id = ?
    `).get(params.id) as ReportRow | undefined
    return row ? mapReport(row) : null
  })

  ipcMain.handle('analytics:saveReport', (_evt, report: AnalyticsReport) => {
    const db = getDatabase()
    const now = timestamp()
    const id = report.id || `rep_${generateId()}`
    const existing = db.prepare('SELECT id, is_preset FROM analytics_reports WHERE id = ?').get(id) as { id: string; is_preset: number } | undefined

    // Writes to a preset create a copy instead of overwriting.
    if (existing?.is_preset === 1) {
      const newId = `rep_${generateId()}`
      db.prepare(`
        INSERT INTO analytics_reports
          (id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        newId,
        report.name + ' (copy)',
        report.description || null,
        report.icon || null,
        JSON.stringify(report.layout),
        JSON.stringify(report.widgets),
        JSON.stringify(report.globalFilters || {}),
        now,
        now
      )
      return { id: newId, forked: true }
    }

    if (existing) {
      db.prepare(`
        UPDATE analytics_reports
        SET name = ?, description = ?, icon = ?, layout = ?, widgets = ?, global_filters = ?, updated_at = ?
        WHERE id = ?
      `).run(
        report.name,
        report.description || null,
        report.icon || null,
        JSON.stringify(report.layout),
        JSON.stringify(report.widgets),
        JSON.stringify(report.globalFilters || {}),
        now,
        id
      )
    } else {
      db.prepare(`
        INSERT INTO analytics_reports
          (id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        id,
        report.name,
        report.description || null,
        report.icon || null,
        JSON.stringify(report.layout),
        JSON.stringify(report.widgets),
        JSON.stringify(report.globalFilters || {}),
        now,
        now
      )
    }
    return { id, forked: false }
  })

  ipcMain.handle('analytics:deleteReport', (_evt, params: { id: string }) => {
    const db = getDatabase()
    const row = db.prepare('SELECT is_preset FROM analytics_reports WHERE id = ?').get(params.id) as { is_preset: number } | undefined
    if (!row) return { ok: false, error: 'Report not found' }
    if (row.is_preset === 1) return { ok: false, error: 'Cannot delete preset reports' }
    db.prepare('DELETE FROM analytics_reports WHERE id = ?').run(params.id)
    return { ok: true }
  })

  ipcMain.handle('analytics:duplicateReport', (_evt, params: { id: string; name?: string }) => {
    const db = getDatabase()
    const src = db.prepare(`
      SELECT id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at
      FROM analytics_reports WHERE id = ?
    `).get(params.id) as ReportRow | undefined
    if (!src) throw new Error('Report not found')
    const newId = `rep_${generateId()}`
    const now = timestamp()
    db.prepare(`
      INSERT INTO analytics_reports
        (id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      newId,
      params.name || `${src.name} (copy)`,
      src.description,
      src.icon,
      src.layout,
      src.widgets,
      src.global_filters,
      now,
      now
    )
    return { id: newId }
  })

  ipcMain.handle('analytics:queryWidget', (_evt, spec: WidgetQuerySpec & { globalFilters?: GlobalFilterState }) => {
    try {
      return runWidgetQuery(spec)
    } catch (err) {
      log.warn(`analytics:queryWidget failed: ${(err as Error).message} spec=${JSON.stringify(spec)}`)
      return { data: [], meta: {} }
    }
  })

  log.info('Analytics bridge registered')
}
