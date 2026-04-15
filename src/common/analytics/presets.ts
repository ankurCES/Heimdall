/**
 * Preset analytics reports — seeded into the DB on first migration.
 * These IDs are stable (`preset:xxx`) and `INSERT OR IGNORE` prevents duplicates.
 *
 * The same configs double as a template library in the renderer's "New Report"
 * and "Clone Preset" flows.
 */
import type { AnalyticsReport } from './types'

function p(id: string, config: Omit<AnalyticsReport, 'id' | 'isPreset' | 'createdAt' | 'updatedAt'>): AnalyticsReport {
  return {
    id: `preset:${id}`,
    ...config,
    isPreset: true,
    createdAt: 0,
    updatedAt: 0
  }
}

export const PRESET_REPORTS: AnalyticsReport[] = [
  p('intel-overview', {
    name: 'Intel Overview',
    description: 'Global operational picture across all disciplines',
    icon: 'LayoutDashboard',
    globalFilters: { timeRange: '24h' },
    layout: [
      { i: 'k1', x: 0, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k2', x: 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k3', x: 6, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k4', x: 9, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'c1', x: 0, y: 2, w: 6, h: 5, minW: 3, minH: 3 },
      { i: 'c2', x: 6, y: 2, w: 6, h: 5, minW: 3, minH: 3 },
      { i: 'c3', x: 0, y: 7, w: 12, h: 4, minW: 4, minH: 3 },
      { i: 't1', x: 0, y: 11, w: 12, h: 5, minW: 4, minH: 3 }
    ],
    widgets: {
      k1: { id: 'k1', type: 'kpi', title: 'Total Reports', dataSource: 'intel', metric: 'count', timeRange: 'all', ignoreGlobalFilters: true, kpiOptions: { icon: 'FileText', accentColor: '#3b82f6', format: 'compact' } },
      k2: { id: 'k2', type: 'kpi', title: 'Critical (24h)', dataSource: 'intel', metric: 'count', timeRange: '24h', ignoreGlobalFilters: true, filters: [{ field: 'severity', op: 'eq', value: 'critical' }], kpiOptions: { icon: 'AlertTriangle', accentColor: '#ef4444', delta: true, format: 'compact' } },
      k3: { id: 'k3', type: 'kpi', title: 'Reviewed %', dataSource: 'intel', metric: 'reviewed_pct', timeRange: '7d', ignoreGlobalFilters: true, kpiOptions: { icon: 'CheckCircle2', accentColor: '#10b981', format: 'percent' } },
      k4: { id: 'k4', type: 'kpi', title: 'Active Sources (24h)', dataSource: 'intel', metric: 'distinct_sources', timeRange: '24h', ignoreGlobalFilters: true, kpiOptions: { icon: 'Database', accentColor: '#f59e0b', format: 'number' } },
      c1: { id: 'c1', type: 'doughnut', title: 'By Severity', dataSource: 'intel', metric: 'count', groupBy: 'severity', chartOptions: { colorScheme: 'severity', legend: 'right' } },
      c2: { id: 'c2', type: 'bar', title: 'By Discipline', dataSource: 'intel', metric: 'count', groupBy: 'discipline', chartOptions: { colorScheme: 'discipline', legend: 'hidden' } },
      c3: { id: 'c3', type: 'timeline', title: 'Activity Timeline', dataSource: 'intel', metric: 'count', bucketMinutes: 60, chartOptions: { smooth: true, legend: 'hidden' } },
      t1: { id: 't1', type: 'table', title: 'Top Sources', dataSource: 'intel', metric: 'count', groupBy: 'source', limit: 20 }
    }
  }),

  p('cyber-threat-watch', {
    name: 'Cyber Threat Watch',
    description: 'CVE trends, threat actors, malware, and cyber IOCs',
    icon: 'Shield',
    globalFilters: { timeRange: '7d', disciplines: ['cybint'] },
    layout: [
      { i: 'k1', x: 0, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k2', x: 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k3', x: 6, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k4', x: 9, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'b1', x: 0, y: 2, w: 6, h: 5, minW: 3, minH: 3 },
      { i: 'b2', x: 6, y: 2, w: 6, h: 5, minW: 3, minH: 3 },
      { i: 'tl', x: 0, y: 7, w: 12, h: 4, minW: 4, minH: 3 },
      { i: 't1', x: 0, y: 11, w: 12, h: 5, minW: 4, minH: 3 }
    ],
    widgets: {
      k1: { id: 'k1', type: 'kpi', title: 'Cyber Reports (7d)', dataSource: 'intel', metric: 'count', kpiOptions: { icon: 'Shield', accentColor: '#8b5cf6', format: 'compact', delta: true } },
      k2: { id: 'k2', type: 'kpi', title: 'Critical', dataSource: 'intel', metric: 'count', filters: [{ field: 'severity', op: 'eq', value: 'critical' }], kpiOptions: { icon: 'AlertOctagon', accentColor: '#ef4444', format: 'compact' } },
      k3: { id: 'k3', type: 'kpi', title: 'Distinct CVEs', dataSource: 'entities', metric: 'count', filters: [{ field: 'entity_type', op: 'eq', value: 'cve' }], ignoreGlobalFilters: true, timeRange: '30d', kpiOptions: { icon: 'Bug', accentColor: '#f59e0b', format: 'number' } },
      k4: { id: 'k4', type: 'kpi', title: 'Threat Actors', dataSource: 'entities', metric: 'count', filters: [{ field: 'entity_type', op: 'eq', value: 'threat_actor' }], ignoreGlobalFilters: true, timeRange: '30d', kpiOptions: { icon: 'UserX', accentColor: '#ec4899', format: 'number' } },
      b1: { id: 'b1', type: 'bar', title: 'Top Threat Actors', dataSource: 'entities', metric: 'count', groupBy: 'entity_value', filters: [{ field: 'entity_type', op: 'eq', value: 'threat_actor' }], ignoreGlobalFilters: true, timeRange: '30d', limit: 10, chartOptions: { colorScheme: 'default', legend: 'hidden' } },
      b2: { id: 'b2', type: 'bar', title: 'Top Malware', dataSource: 'entities', metric: 'count', groupBy: 'entity_value', filters: [{ field: 'entity_type', op: 'eq', value: 'malware' }], ignoreGlobalFilters: true, timeRange: '30d', limit: 10, chartOptions: { colorScheme: 'default', legend: 'hidden' } },
      tl: { id: 'tl', type: 'timeline', title: 'Cyber Report Timeline', dataSource: 'intel', metric: 'count', bucketMinutes: 360, chartOptions: { smooth: true, legend: 'hidden' } },
      t1: { id: 't1', type: 'table', title: 'Recent CVEs', dataSource: 'entities', metric: 'count', groupBy: 'entity_value', filters: [{ field: 'entity_type', op: 'eq', value: 'cve' }], ignoreGlobalFilters: true, timeRange: '30d', limit: 25 }
    }
  }),

  p('markets-pulse', {
    name: 'Markets Pulse',
    description: 'Commodities, stocks, and geopolitical financial signals',
    icon: 'TrendingUp',
    globalFilters: { timeRange: '24h' },
    layout: [
      { i: 'k1', x: 0, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k2', x: 3, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k3', x: 6, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'k4', x: 9, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: 'b1', x: 0, y: 2, w: 8, h: 5, minW: 4, minH: 3 },
      { i: 'p1', x: 8, y: 2, w: 4, h: 5, minW: 3, minH: 3 },
      { i: 't1', x: 0, y: 7, w: 12, h: 5, minW: 4, minH: 3 },
      { i: 'txt', x: 0, y: 12, w: 12, h: 2, minW: 4, minH: 2 }
    ],
    widgets: {
      k1: { id: 'k1', type: 'kpi', title: 'Tracked Tickers', dataSource: 'market_quotes', metric: 'count', groupBy: 'ticker', ignoreGlobalFilters: true, kpiOptions: { icon: 'Coins', accentColor: '#3b82f6', format: 'number' } },
      k2: { id: 'k2', type: 'kpi', title: 'Avg |% Change|', dataSource: 'market_quotes', metric: 'avg_change_pct', ignoreGlobalFilters: true, kpiOptions: { icon: 'Activity', accentColor: '#10b981', format: 'percent' } },
      k3: { id: 'k3', type: 'kpi', title: 'Finint Reports (24h)', dataSource: 'intel', metric: 'count', filters: [{ field: 'discipline', op: 'eq', value: 'finint' }], timeRange: '24h', ignoreGlobalFilters: true, kpiOptions: { icon: 'DollarSign', accentColor: '#f59e0b', format: 'compact' } },
      k4: { id: 'k4', type: 'kpi', title: 'Sanctions (7d)', dataSource: 'intel', metric: 'count', filters: [{ field: 'source_name', op: 'contains', value: 'Sanction' }], timeRange: '7d', ignoreGlobalFilters: true, kpiOptions: { icon: 'Ban', accentColor: '#ef4444', format: 'number' } },
      b1: { id: 'b1', type: 'bar', title: 'Top Movers (by |%|)', dataSource: 'market_quotes', metric: 'latest_price', groupBy: 'ticker', ignoreGlobalFilters: true, limit: 15, chartOptions: { colorScheme: 'default', legend: 'hidden' } },
      p1: { id: 'p1', type: 'doughnut', title: 'By Asset Class', dataSource: 'market_quotes', metric: 'count', groupBy: 'category', ignoreGlobalFilters: true, chartOptions: { legend: 'bottom' } },
      t1: { id: 't1', type: 'table', title: 'Recent Finint Reports', dataSource: 'intel', metric: 'count', groupBy: 'source', filters: [{ field: 'discipline', op: 'eq', value: 'finint' }], timeRange: '7d', ignoreGlobalFilters: true, limit: 20 },
      txt: { id: 'txt', type: 'text', title: 'Notes', staticContent: '### Markets Pulse\n\nThis dashboard aggregates all **FININT** sources including EDGAR filings, OFAC sanctions, commodity prices, equities and crypto from Alpaca, and Indian mutual funds from MFAPI. Use the **Markets** page for deeper time-series analysis.' }
    }
  })
]

/**
 * Return a fresh "New Report" template — an empty canvas with just a text widget.
 */
export function makeBlankReport(id: string, name: string): AnalyticsReport {
  const now = Date.now()
  return {
    id,
    name,
    description: '',
    icon: 'BarChart3',
    globalFilters: { timeRange: '24h' },
    layout: [{ i: 'welcome', x: 0, y: 0, w: 12, h: 3, minW: 4, minH: 2 }],
    widgets: {
      welcome: {
        id: 'welcome',
        type: 'text',
        title: 'Welcome',
        staticContent: '## New Report\n\nClick **+ Add Widget** to start building. Drag corners to resize, drag titles to reposition. Save when ready.'
      }
    },
    isPreset: false,
    createdAt: now,
    updatedAt: now
  }
}
