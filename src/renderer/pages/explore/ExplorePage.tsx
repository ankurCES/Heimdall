import { useState, useEffect, useCallback } from 'react'
import {
  BarChart3, RefreshCw, Filter, Clock, Loader2,
  TrendingUp, PieChart, Table2, Globe
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Label } from '@renderer/components/ui/label'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, PointElement,
  LineElement, ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Bar, Line, Pie, Doughnut, Scatter } from 'react-chartjs-2'
import { cn } from '@renderer/lib/utils'

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, ArcElement, Title, Tooltip, Legend, Filler)

type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'timeline' | 'table'

const METRICS = [
  { value: 'count', label: 'Count' },
  { value: 'avg_verification', label: 'Avg Verification Score' }
]

const GROUP_BY_OPTIONS = [
  { value: 'discipline', label: 'Discipline' },
  { value: 'severity', label: 'Severity' },
  { value: 'source', label: 'Source' },
  { value: 'date', label: 'Date' },
  { value: 'hour', label: 'Hour of Day' }
]

const TIME_RANGES = [
  { value: '1', label: 'Last Hour' },
  { value: '6', label: 'Last 6 Hours' },
  { value: '24', label: 'Last 24 Hours' },
  { value: '72', label: 'Last 3 Days' },
  { value: '168', label: 'Last Week' },
  { value: '720', label: 'Last 30 Days' },
  { value: '', label: 'All Time' }
]

const COLORS = ['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316','#6366f1','#14b8a6','#e11d48','#84cc16','#a855f7','#0ea5e9','#d946ef']

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', info: '#6b7280'
}

export function ExplorePage() {
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [groupBy, setGroupBy] = useState('discipline')
  const [metric, setMetric] = useState('count')
  const [timeRange, setTimeRange] = useState('24')
  const [filterDiscipline, setFilterDiscipline] = useState('')
  const [filterSeverity, setFilterSeverity] = useState('')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<Array<{ label: string; value: number }>>([])
  const [timeline, setTimeline] = useState<Array<{ date: string; count: number }>>([])
  const [sessionId, setSessionId] = useState('')
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const [sessionData, setSessionData] = useState<any>(null)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    fetchData()
    loadSessions()
  }, [])

  useEffect(() => { fetchData() }, [groupBy, metric, timeRange, filterDiscipline, filterSeverity])

  const loadSessions = async () => {
    try {
      const s = await invoke('chat:getSessions') as Array<{ id: string; title: string }>
      setSessions(s || [])
    } catch {}
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      const filters: Record<string, string> = {}
      if (filterDiscipline) filters.discipline = filterDiscipline
      if (filterSeverity) filters.severity = filterSeverity

      const result = await invoke('explore:getData', { groupBy, metric, filters, timeRange, limit: 50 }) as {
        data: Array<{ label: string; value: number }>
        timeline: Array<{ date: string; count: number }>
      }
      setData(result.data || [])
      setTimeline(result.timeline || [])
    } catch {}
    setLoading(false)
  }

  const loadSessionData = async (sid: string) => {
    setSessionId(sid)
    if (!sid) { setSessionData(null); return }
    try {
      const result = await invoke('chat:getSessionData', { sessionId: sid })
      setSessionData(result)
    } catch {}
  }

  // Build chart data
  const labels = data.map((d) => {
    if (groupBy === 'discipline') return DISCIPLINE_LABELS[d.label as keyof typeof DISCIPLINE_LABELS] || d.label
    return d.label || 'Unknown'
  })
  const values = data.map((d) => d.value)

  const chartColors = groupBy === 'severity'
    ? data.map((d) => SEVERITY_COLORS[d.label] || '#6b7280')
    : COLORS.slice(0, data.length)

  const chartData = {
    labels,
    datasets: [{
      label: METRICS.find((m) => m.value === metric)?.label || 'Count',
      data: values,
      backgroundColor: chartColors,
      borderColor: chartType === 'line' ? '#3b82f6' : chartColors,
      borderWidth: chartType === 'line' ? 2 : 0,
      borderRadius: chartType === 'bar' ? 4 : 0,
      fill: chartType === 'line' ? { target: 'origin', above: 'rgba(59,130,246,0.1)' } : false,
      tension: 0.3
    }]
  }

  const timelineData = {
    labels: timeline.map((t) => t.date),
    datasets: [{
      label: 'Reports',
      data: timeline.map((t) => t.count),
      backgroundColor: 'rgba(59,130,246,0.2)',
      borderColor: '#3b82f6',
      borderWidth: 2,
      fill: true,
      tension: 0.3
    }]
  }

  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: chartType === 'pie' || chartType === 'doughnut', labels: { color: '#9ca3af', font: { size: 11 } } },
      tooltip: { backgroundColor: '#1e293b', titleColor: '#e2e8f0', bodyColor: '#94a3b8' }
    },
    scales: chartType === 'pie' || chartType === 'doughnut' ? undefined : {
      x: { ticks: { color: '#9ca3af', font: { size: 10 }, maxRotation: 45 }, grid: { display: false } },
      y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } }
    }
  }

  const ChartComp = { bar: Bar, line: Line, pie: Pie, doughnut: Doughnut, scatter: Scatter }[chartType] || Bar

  return (
    <div className="flex h-full">
      {/* Control Panel (left) */}
      <div className="w-64 border-r border-border bg-card/50 p-4 space-y-5 overflow-auto">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <span className="text-sm font-bold">Explore</span>
        </div>

        {/* Chart Type */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Chart Type</Label>
          <div className="grid grid-cols-4 gap-1">
            {([
              { type: 'bar' as ChartType, icon: BarChart3 },
              { type: 'line' as ChartType, icon: TrendingUp },
              { type: 'pie' as ChartType, icon: PieChart },
              { type: 'doughnut' as ChartType, icon: PieChart },
              { type: 'timeline' as ChartType, icon: Clock },
              { type: 'table' as ChartType, icon: Table2 }
            ]).map(({ type, icon: Icon }) => (
              <button key={type} onClick={() => setChartType(type)}
                className={cn('flex flex-col items-center gap-0.5 p-1.5 rounded text-[9px] border transition-colors',
                  chartType === type ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground')}>
                <Icon className="h-3.5 w-3.5" />{type}
              </button>
            ))}
          </div>
        </div>

        {/* Metric */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Metric</Label>
          <Select value={metric} onValueChange={setMetric}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {/* Group By */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Group By</Label>
          <Select value={groupBy} onValueChange={setGroupBy}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{GROUP_BY_OPTIONS.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {/* Time Range */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Time Range</Label>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_RANGES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        {/* Filters */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1"><Filter className="h-3 w-3" />Filters</Label>
          <Select value={filterDiscipline || 'all'} onValueChange={(v) => setFilterDiscipline(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Discipline" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Disciplines</SelectItem>
              {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterSeverity || 'all'} onValueChange={(v) => setFilterSeverity(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              {['critical','high','medium','low','info'].map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Session Data */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Chat Session Context</Label>
          <Select value={sessionId || 'none'} onValueChange={(v) => loadSessionData(v === 'none' ? '' : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select session..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Global (all data)</SelectItem>
              {sessions.map((s) => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" size="sm" className="w-full" onClick={fetchData} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Run Query
        </Button>
      </div>

      {/* Chart Area (right) */}
      <div className="flex-1 p-6 overflow-auto space-y-4">
        {/* Main chart */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">
                {METRICS.find((m) => m.value === metric)?.label} by {GROUP_BY_OPTIONS.find((g) => g.value === groupBy)?.label}
              </CardTitle>
              <Badge variant="outline" className="text-xs">{data.length} groups</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : data.length > 0 ? (
              chartType === 'table' ? (
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-border">
                      <th className="text-left py-2 px-3 font-semibold">{GROUP_BY_OPTIONS.find((g) => g.value === groupBy)?.label}</th>
                      <th className="text-right py-2 px-3 font-semibold">{METRICS.find((m) => m.value === metric)?.label}</th>
                    </tr></thead>
                    <tbody>{data.map((d, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-accent/30">
                        <td className="py-1.5 px-3">{labels[i]}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{typeof d.value === 'number' ? d.value.toLocaleString() : d.value}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : chartType === 'timeline' ? (
                <div className="h-64"><Line data={timelineData} options={chartOpts as any} /></div>
              ) : (
                <div className="h-64"><ChartComp data={chartData} options={chartOpts as any} /></div>
              )
            ) : (
              <p className="text-sm text-muted-foreground text-center py-16">No data for current query. Adjust filters or time range.</p>
            )}
          </CardContent>
        </Card>

        {/* Timeline always shown below main chart if not timeline type */}
        {chartType !== 'timeline' && timeline.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Activity Timeline</CardTitle></CardHeader>
            <CardContent><div className="h-40"><Line data={timelineData} options={chartOpts as any} /></div></CardContent>
          </Card>
        )}

        {/* Session semantic data */}
        {sessionData && (
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Session: Disciplines</CardTitle></CardHeader>
              <CardContent>
                {sessionData.byDiscipline && Object.keys(sessionData.byDiscipline).length > 0 ? (
                  <div className="h-40">
                    <Doughnut data={{
                      labels: Object.keys(sessionData.byDiscipline).map((d: string) => DISCIPLINE_LABELS[d as keyof typeof DISCIPLINE_LABELS] || d),
                      datasets: [{ data: Object.values(sessionData.byDiscipline), backgroundColor: COLORS, borderWidth: 0 }]
                    }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#9ca3af', font: { size: 9 } } } } }} />
                  </div>
                ) : <p className="text-xs text-muted-foreground">No data</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Session: Severity</CardTitle></CardHeader>
              <CardContent>
                {sessionData.bySeverity && Object.keys(sessionData.bySeverity).length > 0 ? (
                  <div className="h-40">
                    <Bar data={{
                      labels: Object.keys(sessionData.bySeverity).map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)),
                      datasets: [{ data: Object.values(sessionData.bySeverity), backgroundColor: Object.keys(sessionData.bySeverity).map((s: string) => SEVERITY_COLORS[s] || '#6b7280'), borderWidth: 0, borderRadius: 4 }]
                    }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#9ca3af' }, grid: { display: false } }, y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } } } }} />
                  </div>
                ) : <p className="text-xs text-muted-foreground">No data</p>}
              </CardContent>
            </Card>
            <Card className="col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Session: Top Keywords</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {(sessionData.topKeywords || []).map((kw: string, i: number) => (
                    <Badge key={kw} variant="secondary" className="text-xs">{kw}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
