import { useEffect } from 'react'
import { useDashboardStore } from '@renderer/stores/dashboardStore'
import { useSourceStore } from '@renderer/stores/sourceStore'
import {
  Shield, AlertTriangle, AlertCircle, Info, TrendingUp,
  Activity, Database, Radio
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import { formatRelativeTime } from '@renderer/lib/utils'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement,
  Title, Tooltip, Legend, ArcElement
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement)

const severityConfig = {
  critical: { label: 'Critical', color: 'text-red-500 bg-red-500/10 border-red-500/20', icon: AlertTriangle, chartColor: '#ef4444' },
  high: { label: 'High', color: 'text-orange-500 bg-orange-500/10 border-orange-500/20', icon: AlertTriangle, chartColor: '#f97316' },
  medium: { label: 'Medium', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20', icon: AlertCircle, chartColor: '#eab308' },
  low: { label: 'Low', color: 'text-blue-500 bg-blue-500/10 border-blue-500/20', icon: Info, chartColor: '#3b82f6' }
}

const DISCIPLINE_COLORS: Record<string, string> = {
  osint: '#3b82f6', cybint: '#ef4444', finint: '#10b981', socmint: '#8b5cf6',
  geoint: '#f59e0b', sigint: '#06b6d4', rumint: '#f97316', ci: '#ec4899', agency: '#6366f1'
}

export function DashboardPage() {
  const { stats, loading, fetchStats } = useDashboardStore()
  const { sources, fetchSources } = useSourceStore()

  useEffect(() => {
    fetchStats()
    fetchSources()
    const interval = setInterval(fetchStats, 15000)
    return () => clearInterval(interval)
  }, [fetchStats, fetchSources])

  const severityChartData = {
    labels: Object.values(severityConfig).map((c) => c.label),
    datasets: [{
      data: Object.keys(severityConfig).map((k) => stats?.last24h[k as keyof typeof severityConfig] ?? 0),
      backgroundColor: Object.values(severityConfig).map((c) => c.chartColor),
      borderWidth: 0
    }]
  }

  const disciplineEntries = Object.entries(stats?.byDiscipline || {})
  const disciplineChartData = {
    labels: disciplineEntries.map(([d]) => DISCIPLINE_LABELS[d as keyof typeof DISCIPLINE_LABELS] || d),
    datasets: [{
      label: 'Reports',
      data: disciplineEntries.map(([, count]) => count),
      backgroundColor: disciplineEntries.map(([d]) => DISCIPLINE_COLORS[d] || '#6b7280'),
      borderWidth: 0,
      borderRadius: 4
    }]
  }

  const enabledSources = sources.filter((s) => s.enabled)
  const errorSources = sources.filter((s) => s.lastError)

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" />
            Heimdall Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Global threat overview — {stats?.totalReports ?? 0} total reports collected
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1">
            <Activity className="h-3 w-3" />
            {enabledSources.length} active sources
          </Badge>
          {errorSources.length > 0 && (
            <Badge variant="error" className="gap-1">
              {errorSources.length} errors
            </Badge>
          )}
        </div>
      </div>

      {/* Severity Cards */}
      <div className="grid grid-cols-4 gap-4">
        {(Object.entries(severityConfig) as Array<[keyof typeof severityConfig, typeof severityConfig[keyof typeof severityConfig]]>).map(
          ([key, config]) => {
            const count = stats?.last24h[key] ?? 0
            return (
              <Card key={key} className={`border ${config.color}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <config.icon className="h-5 w-5" />
                    <span className="text-3xl font-bold">{count}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium">{config.label}</p>
                  <p className="text-xs opacity-70">Last 24 hours</p>
                </CardContent>
              </Card>
            )
          }
        )}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-3 gap-4">
        {/* Severity Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Severity Distribution (24h)</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            <div className="w-48 h-48">
              <Doughnut
                data={severityChartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 10 } } } },
                  cutout: '60%'
                }}
              />
            </div>
          </CardContent>
        </Card>

        {/* By Discipline */}
        <Card className="col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Reports by Discipline</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <Bar
                data={disciplineChartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: {
                    x: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { display: false } },
                    y: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { color: '#1f2937' } }
                  }
                }}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Active Sources */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Active Sources ({enabledSources.length})</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-60 overflow-auto">
              {enabledSources.slice(0, 20).map((source) => (
                <div key={source.id} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`h-1.5 w-1.5 rounded-full ${source.lastError ? 'bg-red-500' : 'bg-green-500'}`} />
                    <span className="truncate">{source.name}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-[9px] py-0 px-1">{source.discipline}</Badge>
                    {source.lastCollectedAt && (
                      <span className="text-muted-foreground">{formatRelativeTime(source.lastCollectedAt)}</span>
                    )}
                  </div>
                </div>
              ))}
              {enabledSources.length === 0 && (
                <p className="text-muted-foreground text-xs">No sources configured yet</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recent Critical */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <CardTitle className="text-sm">Recent Critical & High</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-60 overflow-auto">
              {stats?.recentCritical && stats.recentCritical.length > 0 ? (
                stats.recentCritical.map((report) => (
                  <div key={report.id} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-1.5 w-1.5 rounded-full ${report.severity === 'critical' ? 'bg-red-500' : 'bg-orange-500'}`} />
                      <span className="truncate max-w-xs">{report.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-[9px] py-0 px-1">{report.discipline}</Badge>
                      <span className="text-muted-foreground">{formatRelativeTime(report.createdAt)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-xs">No critical items in the last 24 hours</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
