import { useEffect, useState, useMemo } from 'react'
import { useDashboardStore } from '@renderer/stores/dashboardStore'
import { useSourceStore } from '@renderer/stores/sourceStore'
import { MapContainer, TileLayer, CircleMarker, Tooltip as LeafletTooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Shield, AlertTriangle, AlertCircle, Info, TrendingUp, TrendingDown,
  Activity, Database, Globe, Zap, FileText, Network, Tag,
  ArrowUp, ArrowDown, MapPin, Eye
} from 'lucide-react'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import { formatRelativeTime, cn } from '@renderer/lib/utils'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, PointElement, LineElement,
  Title, Tooltip, Legend, ArcElement, Filler
} from 'chart.js'
import { Bar, Line, Doughnut } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, Title, Tooltip, Legend, ArcElement, Filler)

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', info: '#6b7280'
}

const DISCIPLINE_COLORS: Record<string, string> = {
  osint: '#3b82f6', cybint: '#ef4444', finint: '#10b981', socmint: '#8b5cf6',
  geoint: '#f59e0b', sigint: '#06b6d4', rumint: '#f97316', ci: '#ec4899', agency: '#6366f1', imint: '#14b8a6'
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  threat_actor: 'Threat Actor', malware: 'Malware', country: 'Country', organization: 'Org', cve: 'CVE'
}

interface DashExtras {
  hourlyTrend: Array<{ hour: number; critical: number; high: number; medium: number; low: number; info: number }>
  geoPoints: Array<{ id: string; latitude: number; longitude: number; severity: string; title: string; source_name: string }>
  topEntities: Array<{ entity_type: string; entity_value: string; mentions: number }>
  topSources: Array<{ source_name: string; discipline: string; reports: number }>
  marketSummary: Array<{ ticker: string; name: string; price: number; change_pct: number; category: string }>
  timeline: Array<{ id: string; title: string; severity: string; discipline: string; source_name: string; created_at: number }>
  sourceHealth: { total: number; enabled_count: number; error_count: number; active_24h: number }
  knowledgeGraph: { entities: number; tags: number; links: number }
  trend: { last7d: number; prev7d: number; pct: number }
}

export function DashboardPage() {
  const { stats, fetchStats } = useDashboardStore()
  const { sources, fetchSources } = useSourceStore()
  const [extras, setExtras] = useState<DashExtras | null>(null)

  useEffect(() => {
    const fetchAll = () => {
      fetchStats()
      fetchSources()
      void window.heimdall.invoke('intel:getDashboardExtras').then((d: unknown) => setExtras(d as DashExtras))
    }
    fetchAll()
    const interval = setInterval(fetchAll, 30000)
    return () => clearInterval(interval)
  }, [fetchStats, fetchSources])

  // Hourly trend chart
  const hourlyChart = useMemo(() => {
    if (!extras?.hourlyTrend) return null
    return {
      labels: extras.hourlyTrend.map((h) => new Date(h.hour).toLocaleTimeString([], { hour: '2-digit' })),
      datasets: [
        { label: 'Critical', data: extras.hourlyTrend.map((h) => h.critical), backgroundColor: SEVERITY_COLOR.critical, stack: 'sev' },
        { label: 'High', data: extras.hourlyTrend.map((h) => h.high), backgroundColor: SEVERITY_COLOR.high, stack: 'sev' },
        { label: 'Medium', data: extras.hourlyTrend.map((h) => h.medium), backgroundColor: SEVERITY_COLOR.medium, stack: 'sev' },
        { label: 'Low', data: extras.hourlyTrend.map((h) => h.low), backgroundColor: SEVERITY_COLOR.low, stack: 'sev' },
        { label: 'Info', data: extras.hourlyTrend.map((h) => h.info), backgroundColor: SEVERITY_COLOR.info, stack: 'sev' }
      ]
    }
  }, [extras])

  // Discipline distribution
  const disciplineChart = useMemo(() => {
    const entries = Object.entries(stats?.byDiscipline || {})
    return {
      labels: entries.map(([d]) => DISCIPLINE_LABELS[d as keyof typeof DISCIPLINE_LABELS] || d),
      datasets: [{
        data: entries.map(([, c]) => c),
        backgroundColor: entries.map(([d]) => DISCIPLINE_COLORS[d] || '#6b7280'),
        borderWidth: 0
      }]
    }
  }, [stats])

  const enabledCount = sources.filter((s) => s.enabled).length
  const errorCount = sources.filter((s) => s.lastError).length
  const total24h = (stats?.last24h?.critical || 0) + (stats?.last24h?.high || 0) + (stats?.last24h?.medium || 0) + (stats?.last24h?.low || 0) + (stats?.last24h?.info || 0)

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Heimdall Operations Center
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real-time intelligence overview · auto-refresh 30s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1 text-xs">
            <Activity className="h-3 w-3" />
            {enabledCount}/{sources.length} sources
          </Badge>
          {errorCount > 0 && <Badge variant="error" className="text-xs">{errorCount} errors</Badge>}
        </div>
      </div>

      {/* KPI Strip — 6 cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard
          icon={<FileText className="h-4 w-4" />}
          label="Total Reports"
          value={stats?.totalReports?.toLocaleString() || '0'}
          sublabel={`${total24h} in 24h`}
          color="text-primary"
        />
        <KpiCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Critical (24h)"
          value={String(stats?.last24h?.critical || 0)}
          sublabel={`${stats?.last24h?.high || 0} high`}
          color="text-red-500"
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Trend (7d)"
          value={`${extras?.trend?.last7d || 0}`}
          sublabel={extras?.trend ? (
            <span className={cn(extras.trend.pct >= 0 ? 'text-green-500' : 'text-red-500')}>
              {extras.trend.pct >= 0 ? '↑' : '↓'} {Math.abs(extras.trend.pct)}% vs prev
            </span>
          ) : '—'}
          color="text-primary"
        />
        <KpiCard
          icon={<Network className="h-4 w-4" />}
          label="Knowledge Graph"
          value={extras?.knowledgeGraph?.entities?.toLocaleString() || '0'}
          sublabel={`${extras?.knowledgeGraph?.links?.toLocaleString() || 0} links`}
          color="text-violet-500"
        />
        <KpiCard
          icon={<Zap className="h-4 w-4" />}
          label="Active 24h"
          value={String(extras?.sourceHealth?.active_24h || 0)}
          sublabel={`of ${extras?.sourceHealth?.enabled_count || 0} enabled`}
          color="text-green-500"
        />
        <KpiCard
          icon={<Tag className="h-4 w-4" />}
          label="Tags"
          value={extras?.knowledgeGraph?.tags?.toLocaleString() || '0'}
          sublabel="distinct"
          color="text-amber-500"
        />
      </div>

      {/* Row 1: Hourly trend + Discipline donut */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Activity Timeline (24h)</h3>
              <Badge variant="outline" className="text-[10px]">stacked by severity</Badge>
            </div>
            <div className="h-56">
              {hourlyChart ? (
                <Bar data={hourlyChart} options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: {
                    legend: { display: true, position: 'bottom', labels: { color: '#cbd5e1', font: { size: 10 }, boxWidth: 8, usePointStyle: true } },
                    tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#cbd5e1', bodyColor: '#cbd5e1' }
                  },
                  scales: {
                    x: { stacked: true, ticks: { color: '#94a3b8', font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
                    y: { stacked: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.2)' } }
                  }
                }} />
              ) : <SkeletonBox />}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3">By Discipline</h3>
            <div className="h-56 flex items-center justify-center">
              {Object.keys(stats?.byDiscipline || {}).length > 0 ? (
                <Doughnut data={disciplineChart} options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: { legend: { position: 'right', labels: { color: '#cbd5e1', font: { size: 10 }, boxWidth: 8 } } },
                  cutout: '65%'
                }} />
              ) : <SkeletonBox />}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Mini map + Top sources + Top entities */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Mini map */}
        <Card className="lg:col-span-2">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Geo Threat Heat (24h)</h3>
              </div>
              <Badge variant="outline" className="text-[10px]">{extras?.geoPoints?.length || 0} events</Badge>
            </div>
            <div className="h-72 rounded overflow-hidden border border-border">
              <MapContainer
                center={[20, 0]}
                zoom={1}
                style={{ height: '100%', width: '100%', background: '#0f172a' }}
                zoomControl={false}
                attributionControl={false}
                scrollWheelZoom={false}
              >
                <TileLayer
                  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                  attribution=""
                />
                {(extras?.geoPoints || []).map((p) => (
                  <CircleMarker
                    key={p.id}
                    center={[p.latitude, p.longitude]}
                    radius={p.severity === 'critical' ? 8 : p.severity === 'high' ? 6 : 4}
                    pathOptions={{
                      color: SEVERITY_COLOR[p.severity] || '#6b7280',
                      fillColor: SEVERITY_COLOR[p.severity] || '#6b7280',
                      fillOpacity: 0.5,
                      weight: 1
                    }}
                  >
                    <LeafletTooltip>
                      <span style={{ fontSize: 10 }}>
                        <strong>{p.severity.toUpperCase()}</strong>: {p.title.slice(0, 60)}
                      </span>
                    </LeafletTooltip>
                  </CircleMarker>
                ))}
              </MapContainer>
            </div>
          </CardContent>
        </Card>

        {/* Top entities */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-violet-500" />
                <h3 className="text-sm font-semibold">Top Entities (7d)</h3>
              </div>
              <Badge variant="outline" className="text-[10px]">{extras?.topEntities?.length || 0}</Badge>
            </div>
            <div className="space-y-1.5 max-h-72 overflow-auto">
              {extras?.topEntities?.length ? extras.topEntities.map((e, idx) => (
                <div key={`${e.entity_type}-${e.entity_value}-${idx}`} className="flex items-center justify-between gap-2 text-xs py-1 border-b border-border/40 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="text-[9px] py-0 px-1 shrink-0">{ENTITY_TYPE_LABELS[e.entity_type] || e.entity_type}</Badge>
                    <span className="truncate font-medium">{e.entity_value}</span>
                  </div>
                  <span className="font-mono text-muted-foreground shrink-0">{e.mentions}</span>
                </div>
              )) : <p className="text-xs text-muted-foreground italic">No entities tracked yet</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Top sources + Markets summary + Recent timeline */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Top sources by volume */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Top Sources (24h)</h3>
              </div>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-auto">
              {extras?.topSources?.length ? extras.topSources.map((s) => {
                const max = extras.topSources[0]?.reports || 1
                const pct = (s.reports / max) * 100
                return (
                  <div key={s.source_name} className="space-y-0.5">
                    <div className="flex items-center justify-between text-xs gap-2">
                      <span className="truncate">{s.source_name}</span>
                      <span className="font-mono text-muted-foreground">{s.reports}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: DISCIPLINE_COLORS[s.discipline] || '#6b7280' }}
                      />
                    </div>
                  </div>
                )
              }) : <p className="text-xs text-muted-foreground italic">No data yet</p>}
            </div>
          </CardContent>
        </Card>

        {/* Markets summary */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-500" />
                <h3 className="text-sm font-semibold">Top Movers</h3>
              </div>
              <Badge variant="outline" className="text-[10px]">|change|</Badge>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-auto">
              {extras?.marketSummary?.length ? extras.marketSummary.map((m) => {
                const isPositive = m.change_pct >= 0
                return (
                  <div key={m.ticker} className="flex items-center justify-between text-xs py-1 border-b border-border/40 last:border-0">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{m.name}</div>
                      <div className="text-[10px] text-muted-foreground">{m.category}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-xs">${m.price.toFixed(2)}</div>
                      <div className={cn('text-[10px] font-semibold flex items-center justify-end gap-0.5', isPositive ? 'text-green-500' : 'text-red-500')}>
                        {isPositive ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
                        {Math.abs(m.change_pct).toFixed(2)}%
                      </div>
                    </div>
                  </div>
                )
              }) : <p className="text-xs text-muted-foreground italic">Run Backfill on Markets page</p>}
            </div>
          </CardContent>
        </Card>

        {/* Recent timeline */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                <h3 className="text-sm font-semibold">Critical Activity</h3>
              </div>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-auto">
              {extras?.timeline?.length ? extras.timeline.slice(0, 12).map((t) => (
                <div key={t.id} className="flex items-start gap-2 text-xs py-1 border-b border-border/40 last:border-0">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full shrink-0" style={{ background: SEVERITY_COLOR[t.severity] }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{t.title}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
                      <Badge variant="outline" className="text-[9px] py-0 px-1">{t.discipline}</Badge>
                      <span>·</span>
                      <span>{formatRelativeTime(t.created_at)}</span>
                    </div>
                  </div>
                </div>
              )) : <p className="text-xs text-muted-foreground italic">No critical events</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function KpiCard({ icon, label, value, sublabel, color }: {
  icon: React.ReactNode; label: string; value: string; sublabel: React.ReactNode; color: string
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn(color)}>{icon}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</div>
      </CardContent>
    </Card>
  )
}

function SkeletonBox() {
  return <div className="w-full h-full bg-muted/30 rounded animate-pulse" />
}
