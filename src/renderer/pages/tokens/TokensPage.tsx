import { useState, useEffect, useCallback } from 'react'
import { Coins, RefreshCw, TrendingUp } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Bar, Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement,
  ArcElement, Title, Tooltip, Legend
} from 'chart.js'
import { formatRelativeTime } from '@renderer/lib/utils'

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Title, Tooltip, Legend)

interface TokenStats {
  total: { prompt: number; completion: number; total: number }
  byModel: Array<{ model: string; total: number }>
  byMode: Array<{ mode: string; total: number }>
  recent: Array<{ model: string; mode: string; total: number; createdAt: number }>
}

const MODE_COLORS: Record<string, string> = {
  agentic: '#8b5cf6',
  direct: '#3b82f6',
  caveman: '#10b981'
}

export function TokensPage() {
  const [stats, setStats] = useState<TokenStats | null>(null)
  const [loading, setLoading] = useState(true)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadStats = async () => {
    setLoading(true)
    try {
      const result = await invoke('chat:getTokenStats') as TokenStats
      setStats(result)
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    loadStats()
    const interval = setInterval(loadStats, 30000)
    return () => clearInterval(interval)
  }, [])

  const modelChartData = stats ? {
    labels: stats.byModel.map((m) => m.model.slice(0, 20)),
    datasets: [{
      label: 'Tokens',
      data: stats.byModel.map((m) => m.total),
      backgroundColor: ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'],
      borderWidth: 0,
      borderRadius: 4
    }]
  } : null

  const modeChartData = stats ? {
    labels: stats.byMode.map((m) => m.mode.charAt(0).toUpperCase() + m.mode.slice(1)),
    datasets: [{
      data: stats.byMode.map((m) => m.total),
      backgroundColor: stats.byMode.map((m) => MODE_COLORS[m.mode] || '#6b7280'),
      borderWidth: 0
    }]
  } : null

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Coins className="h-6 w-6 text-muted-foreground" />
            Token Usage
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor LLM token consumption across all chat modes
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadStats} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Tokens</p>
            <p className="text-3xl font-bold mt-1">{(stats?.total.total || 0).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">
              ~${((stats?.total.total || 0) * 0.000002).toFixed(4)} est. cost
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Prompt Tokens</p>
            <p className="text-3xl font-bold mt-1 text-blue-500">{(stats?.total.prompt || 0).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">Input to LLM</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Completion Tokens</p>
            <p className="text-3xl font-bold mt-1 text-green-500">{(stats?.total.completion || 0).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">Output from LLM</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tokens by Model</CardTitle>
          </CardHeader>
          <CardContent>
            {modelChartData && modelChartData.labels.length > 0 ? (
              <div className="h-48">
                <Bar data={modelChartData} options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  scales: {
                    x: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { display: false } },
                    y: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } }
                  }
                }} />
              </div>
            ) : <p className="text-xs text-muted-foreground text-center py-8">No usage data yet</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tokens by Mode</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            {modeChartData && modeChartData.labels.length > 0 ? (
              <div className="w-48 h-48">
                <Doughnut data={modeChartData} options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 10 } } } },
                  cutout: '60%'
                }} />
              </div>
            ) : <p className="text-xs text-muted-foreground text-center py-8">No usage data yet</p>}
          </CardContent>
        </Card>
      </div>

      {/* Recent usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Token Usage</CardTitle>
          <CardDescription>{stats?.recent.length || 0} recent calls</CardDescription>
        </CardHeader>
        <CardContent>
          {stats?.recent && stats.recent.length > 0 ? (
            <div className="space-y-1 max-h-60 overflow-auto">
              {stats.recent.map((entry, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-border/50 last:border-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[9px] py-0 px-1.5 font-mono">{entry.model.slice(0, 20)}</Badge>
                    <Badge
                      className="text-[9px] py-0 px-1.5"
                      style={{ backgroundColor: MODE_COLORS[entry.mode] || '#6b7280', color: 'white' }}
                    >
                      {entry.mode}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono">{entry.total.toLocaleString()} tokens</span>
                    <span className="text-muted-foreground">{formatRelativeTime(entry.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No token usage recorded yet. Start a chat to track usage.</p>
          )}
        </CardContent>
      </Card>

      {/* Caveman mode savings tip */}
      <Card className="border-green-500/20 bg-green-500/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-4 w-4 text-green-500" />
            <span className="text-sm font-semibold text-green-500">Token Saving Tip</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Switch to <strong>Caveman mode</strong> in the chat to reduce token usage by ~40-60%.
            It compresses system prompts, strips formatting, and uses abbreviated language.
            Best for quick fact lookups. Use Agentic mode for complex multi-step analysis.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
