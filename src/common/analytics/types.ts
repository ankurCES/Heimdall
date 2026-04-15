/**
 * Shared analytics types — used by both main process (bridge + migrations)
 * and renderer (UI + zustand store).
 *
 * Keep this file free of renderer-only imports.
 */

export type WidgetType =
  | 'kpi'
  | 'bar'
  | 'line'
  | 'pie'
  | 'doughnut'
  | 'table'
  | 'timeline'
  | 'heatmap'
  | 'text'

export type DataSource =
  | 'intel'
  | 'entities'
  | 'tags'
  | 'sources'
  | 'market_quotes'
  | 'watch_terms'
  | 'tokens'

export type Metric =
  | 'count'
  | 'avg_verification'
  | 'distinct_sources'
  | 'sum_change_pct'
  | 'avg_change_pct'
  | 'latest_price'
  | 'reviewed_pct'

export type GroupBy =
  | 'discipline'
  | 'severity'
  | 'source'
  | 'source_type'
  | 'date'
  | 'hour'
  | 'dow_hour'
  | 'entity_type'
  | 'entity_value'
  | 'tag'
  | 'ticker'
  | 'category'
  | 'none'

export type TimeRange =
  | '1h' | '6h' | '24h' | '3d' | '7d' | '30d' | '90d' | 'all'

export type FilterOp = 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains'

export interface FilterSpec {
  field: string
  op: FilterOp
  value: string | number | boolean | Array<string | number>
}

export interface ChartOptions {
  stacked?: boolean
  normalized?: boolean
  legend?: 'top' | 'right' | 'bottom' | 'hidden'
  colorScheme?: 'default' | 'severity' | 'discipline' | 'viridis'
  showValues?: boolean
  smooth?: boolean
}

export interface KpiOptions {
  delta?: boolean            // show vs previous period
  format?: 'number' | 'percent' | 'currency' | 'compact'
  suffix?: string
  prefix?: string
  icon?: string              // lucide icon name
  accentColor?: string       // css color
}

export interface WidgetConfig {
  id: string
  type: WidgetType
  title: string
  subtitle?: string
  dataSource?: DataSource
  metric?: Metric
  groupBy?: GroupBy
  filters?: FilterSpec[]
  ignoreGlobalFilters?: boolean
  timeRange?: TimeRange
  limit?: number
  bucketMinutes?: number
  chartOptions?: ChartOptions
  kpiOptions?: KpiOptions
  staticContent?: string     // for markdown/text widgets
}

export interface LayoutItem {
  i: string    // widget id
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

export interface GlobalFilterState {
  timeRange: TimeRange
  disciplines?: string[]
  severities?: string[]
  sources?: string[]
  tags?: string[]
}

export interface AnalyticsReport {
  id: string
  name: string
  description?: string
  icon?: string
  layout: LayoutItem[]
  widgets: Record<string, WidgetConfig>
  globalFilters: GlobalFilterState
  isPreset: boolean
  createdAt: number
  updatedAt: number
}

export interface ReportMeta {
  id: string
  name: string
  description?: string
  icon?: string
  isPreset: boolean
  updatedAt: number
}

export interface WidgetQuerySpec {
  dataSource: DataSource
  metric: Metric
  groupBy?: GroupBy
  filters?: FilterSpec[]
  timeRange?: TimeRange
  limit?: number
  bucketMinutes?: number
  globalFilters?: GlobalFilterState
  ignoreGlobalFilters?: boolean
}

export interface WidgetQueryResult {
  data: Array<{ label: string; value: number; raw?: unknown }>
  timeline?: Array<{ bucket: number; count: number }>
  total?: number
  delta?: number     // percent change vs previous period (for kpi)
  meta?: { bucketCount?: number; rangeMs?: number }
}
