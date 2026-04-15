import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import type { WidgetConfig, WidgetType, DataSource, Metric, GroupBy, FilterSpec, FilterOp, TimeRange, GlobalFilterState } from '@common/analytics/types'
import { WidgetRenderer } from './WidgetRenderer'

const WIDGET_TYPES: Array<{ value: WidgetType; label: string }> = [
  { value: 'kpi', label: 'KPI / Big Number' },
  { value: 'bar', label: 'Bar Chart' },
  { value: 'line', label: 'Line Chart' },
  { value: 'pie', label: 'Pie Chart' },
  { value: 'doughnut', label: 'Doughnut Chart' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'heatmap', label: 'DoW × Hour Heatmap' },
  { value: 'table', label: 'Table' },
  { value: 'text', label: 'Markdown / Text' }
]

const DATA_SOURCES: Array<{ value: DataSource; label: string }> = [
  { value: 'intel', label: 'Intel Reports' },
  { value: 'entities', label: 'Entities' },
  { value: 'tags', label: 'Tags' },
  { value: 'sources', label: 'Sources' },
  { value: 'market_quotes', label: 'Market Quotes' },
  { value: 'watch_terms', label: 'Watch Terms' },
  { value: 'tokens', label: 'Token Usage' }
]

const METRICS: Array<{ value: Metric; label: string }> = [
  { value: 'count', label: 'Count' },
  { value: 'avg_verification', label: 'Avg verification score' },
  { value: 'distinct_sources', label: 'Distinct sources' },
  { value: 'avg_change_pct', label: 'Avg |% change|' },
  { value: 'sum_change_pct', label: 'Sum |% change|' },
  { value: 'latest_price', label: 'Latest price' },
  { value: 'reviewed_pct', label: 'Reviewed %' }
]

const GROUP_BYS: Array<{ value: GroupBy; label: string }> = [
  { value: 'none', label: '— no grouping —' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'severity', label: 'Severity' },
  { value: 'source', label: 'Source name' },
  { value: 'source_type', label: 'Source type' },
  { value: 'date', label: 'Date' },
  { value: 'hour', label: 'Hour of day' },
  { value: 'dow_hour', label: 'Day of week × Hour' },
  { value: 'entity_type', label: 'Entity type' },
  { value: 'entity_value', label: 'Entity value' },
  { value: 'tag', label: 'Tag' },
  { value: 'ticker', label: 'Ticker' },
  { value: 'category', label: 'Asset category' }
]

const TIME_RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: '3d', label: '3 days' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' }
]

const FILTER_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'in', label: 'in list' },
  { value: 'nin', label: 'not in list' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'contains', label: 'contains' }
]

interface Props {
  open: boolean
  initial: WidgetConfig | null   // null = new widget
  globalFilters?: GlobalFilterState
  onClose: () => void
  onSave: (config: WidgetConfig) => void
}

function genId(): string {
  return `w_${Math.random().toString(36).slice(2, 10)}`
}

export function WidgetEditor({ open, initial, globalFilters, onClose, onSave }: Props) {
  const [config, setConfig] = useState<WidgetConfig>(() => initial ?? {
    id: genId(),
    type: 'bar',
    title: 'New Widget',
    dataSource: 'intel',
    metric: 'count',
    groupBy: 'discipline'
  })

  useEffect(() => {
    if (open) {
      setConfig(initial ?? {
        id: genId(),
        type: 'bar',
        title: 'New Widget',
        dataSource: 'intel',
        metric: 'count',
        groupBy: 'discipline'
      })
    }
  }, [open, initial])

  const updateFilter = (idx: number, patch: Partial<FilterSpec>) => {
    const next = [...(config.filters || [])]
    next[idx] = { ...next[idx], ...patch } as FilterSpec
    setConfig({ ...config, filters: next })
  }

  const addFilter = () => {
    setConfig({ ...config, filters: [...(config.filters || []), { field: 'discipline', op: 'eq', value: '' }] })
  }

  const removeFilter = (idx: number) => {
    const next = [...(config.filters || [])]
    next.splice(idx, 1)
    setConfig({ ...config, filters: next })
  }

  const needsData = useMemo(() => config.type !== 'text', [config.type])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit Widget' : 'Add Widget'}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_420px] gap-4 flex-1 overflow-hidden">
          {/* Left — config tabs */}
          <Tabs defaultValue="basic" className="flex flex-col overflow-hidden">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="basic">Basic</TabsTrigger>
              {needsData && <TabsTrigger value="data">Data</TabsTrigger>}
              <TabsTrigger value="display">Display</TabsTrigger>
              {needsData && <TabsTrigger value="filters">Filters</TabsTrigger>}
              {config.type === 'text' && <TabsTrigger value="content">Content</TabsTrigger>}
            </TabsList>

            <div className="flex-1 overflow-y-auto">
              <TabsContent value="basic" className="space-y-3 p-1">
                <div>
                  <Label>Title</Label>
                  <Input value={config.title} onChange={(e) => setConfig({ ...config, title: e.target.value })} />
                </div>
                <div>
                  <Label>Widget Type</Label>
                  <Select value={config.type} onValueChange={(v) => setConfig({ ...config, type: v as WidgetType })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {WIDGET_TYPES.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Subtitle (optional)</Label>
                  <Input value={config.subtitle || ''} onChange={(e) => setConfig({ ...config, subtitle: e.target.value })} />
                </div>
              </TabsContent>

              {needsData && (
                <TabsContent value="data" className="space-y-3 p-1">
                  <div>
                    <Label>Data source</Label>
                    <Select value={config.dataSource || 'intel'} onValueChange={(v) => setConfig({ ...config, dataSource: v as DataSource })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {DATA_SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Metric</Label>
                    <Select value={config.metric || 'count'} onValueChange={(v) => setConfig({ ...config, metric: v as Metric })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {config.type !== 'kpi' && (
                    <div>
                      <Label>Group by</Label>
                      <Select value={config.groupBy || 'none'} onValueChange={(v) => setConfig({ ...config, groupBy: v as GroupBy })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {GROUP_BYS.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div>
                    <Label>Time range override (optional)</Label>
                    <Select value={config.timeRange || 'global'} onValueChange={(v) => setConfig({ ...config, timeRange: v === 'global' ? undefined : (v as TimeRange) })}>
                      <SelectTrigger><SelectValue placeholder="Use global" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="global">Use global</SelectItem>
                        {TIME_RANGES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {config.type !== 'kpi' && (
                    <div>
                      <Label>Limit (top N rows)</Label>
                      <Input type="number" min={1} max={500} value={config.limit || 50}
                        onChange={(e) => setConfig({ ...config, limit: parseInt(e.target.value, 10) || 50 })} />
                    </div>
                  )}
                  {config.type === 'timeline' && (
                    <div>
                      <Label>Bucket minutes</Label>
                      <Input type="number" min={1} value={config.bucketMinutes || 60}
                        onChange={(e) => setConfig({ ...config, bucketMinutes: parseInt(e.target.value, 10) || 60 })} />
                    </div>
                  )}
                </TabsContent>
              )}

              <TabsContent value="display" className="space-y-3 p-1">
                {(config.type === 'bar' || config.type === 'line' || config.type === 'pie' || config.type === 'doughnut' || config.type === 'timeline') && (
                  <>
                    <div>
                      <Label>Color scheme</Label>
                      <Select value={config.chartOptions?.colorScheme || 'default'} onValueChange={(v) => setConfig({ ...config, chartOptions: { ...config.chartOptions, colorScheme: v as 'default' | 'severity' | 'discipline' | 'viridis' } })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default palette</SelectItem>
                          <SelectItem value="severity">Severity</SelectItem>
                          <SelectItem value="discipline">Discipline</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Legend</Label>
                      <Select value={config.chartOptions?.legend || 'top'} onValueChange={(v) => setConfig({ ...config, chartOptions: { ...config.chartOptions, legend: v as 'top' | 'right' | 'bottom' | 'hidden' } })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="hidden">Hidden</SelectItem>
                          <SelectItem value="top">Top</SelectItem>
                          <SelectItem value="right">Right</SelectItem>
                          <SelectItem value="bottom">Bottom</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {(config.type === 'bar') && (
                      <label className="flex items-center gap-2"><Switch checked={!!config.chartOptions?.stacked} onCheckedChange={(v) => setConfig({ ...config, chartOptions: { ...config.chartOptions, stacked: v } })} /><span className="text-sm">Stacked</span></label>
                    )}
                    {(config.type === 'line' || config.type === 'timeline') && (
                      <label className="flex items-center gap-2"><Switch checked={!!config.chartOptions?.smooth} onCheckedChange={(v) => setConfig({ ...config, chartOptions: { ...config.chartOptions, smooth: v } })} /><span className="text-sm">Smooth curve</span></label>
                    )}
                  </>
                )}
                {config.type === 'kpi' && (
                  <>
                    <div>
                      <Label>Icon (lucide name)</Label>
                      <Input value={config.kpiOptions?.icon || ''} placeholder="e.g. AlertTriangle"
                        onChange={(e) => setConfig({ ...config, kpiOptions: { ...config.kpiOptions, icon: e.target.value } })} />
                    </div>
                    <div>
                      <Label>Accent color</Label>
                      <Input value={config.kpiOptions?.accentColor || '#3b82f6'}
                        onChange={(e) => setConfig({ ...config, kpiOptions: { ...config.kpiOptions, accentColor: e.target.value } })} />
                    </div>
                    <div>
                      <Label>Format</Label>
                      <Select value={config.kpiOptions?.format || 'number'} onValueChange={(v) => setConfig({ ...config, kpiOptions: { ...config.kpiOptions, format: v as 'number' | 'percent' | 'currency' | 'compact' } })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="number">Number</SelectItem>
                          <SelectItem value="compact">Compact (1.2k)</SelectItem>
                          <SelectItem value="percent">Percent</SelectItem>
                          <SelectItem value="currency">Currency</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <label className="flex items-center gap-2"><Switch checked={!!config.kpiOptions?.delta} onCheckedChange={(v) => setConfig({ ...config, kpiOptions: { ...config.kpiOptions, delta: v } })} /><span className="text-sm">Show delta vs previous period</span></label>
                  </>
                )}
              </TabsContent>

              {needsData && (
                <TabsContent value="filters" className="space-y-3 p-1">
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={!!config.ignoreGlobalFilters}
                      onCheckedChange={(v) => setConfig({ ...config, ignoreGlobalFilters: v })}
                    />
                    <span className="text-sm">Ignore global filters</span>
                  </label>
                  <div className="space-y-2">
                    {(config.filters || []).map((f, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input className="w-32" placeholder="field" value={f.field}
                          onChange={(e) => updateFilter(i, { field: e.target.value })} />
                        <Select value={f.op} onValueChange={(v) => updateFilter(i, { op: v as FilterOp })}>
                          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {FILTER_OPS.map((op) => <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Input className="flex-1" placeholder="value" value={String(f.value)}
                          onChange={(e) => updateFilter(i, { value: e.target.value })} />
                        <Button size="sm" variant="ghost" onClick={() => removeFilter(i)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button size="sm" variant="outline" onClick={addFilter}>
                    <Plus className="h-3.5 w-3.5 mr-1" />Add filter
                  </Button>
                </TabsContent>
              )}

              {config.type === 'text' && (
                <TabsContent value="content" className="space-y-3 p-1">
                  <Label>Markdown content</Label>
                  <textarea
                    value={config.staticContent || ''}
                    onChange={(e) => setConfig({ ...config, staticContent: e.target.value })}
                    className="w-full min-h-[260px] rounded-md border border-input bg-transparent p-3 text-sm font-mono"
                  />
                </TabsContent>
              )}
            </div>
          </Tabs>

          {/* Right — live preview */}
          <div className="border border-border rounded-md overflow-hidden flex flex-col bg-card/30">
            <div className="px-3 py-2 border-b border-border bg-card/50 flex items-center justify-between">
              <span className="text-xs font-semibold">Preview</span>
              <span className="text-[10px] text-muted-foreground">{config.type}</span>
            </div>
            <div className="flex-1 min-h-[300px]">
              <WidgetRenderer config={config} globalFilters={globalFilters} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(config)}>Save Widget</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
