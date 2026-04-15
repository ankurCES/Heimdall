import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  TrendingUp, RefreshCw, Loader2, X, ExternalLink, AlertTriangle,
  FileText, Target, Activity, ArrowUp, ArrowDown, Database
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { SectorHeatmap } from '@renderer/components/markets/SectorHeatmap'
import { PriceSparkline } from '@renderer/components/markets/PriceSparkline'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

interface Quote {
  ticker: string
  name: string
  category: string
  price: number
  change_pct: number
  change_abs: number | null
  prev_close: number | null
  currency: string | null
  recorded_at: number
}

interface IntelItem {
  id: string
  title: string
  content?: string
  source_name?: string
  source_url?: string
  severity?: string
  created_at: number
}

const SEVERITY_BG: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400',
  high: 'bg-orange-500/15 text-orange-400',
  medium: 'bg-yellow-500/15 text-yellow-400',
  low: 'bg-blue-500/15 text-blue-400',
  info: 'bg-gray-500/15 text-gray-400'
}

const CHART_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
const RANGE_HOURS: Record<string, number> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
  '1y': 8760,
  '5y': 43800
}

export function MarketsPage() {
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [kpis, setKpis] = useState<{ kpiQuotes: Quote[]; topMover: Quote | null; sanctionsCount: number }>({ kpiQuotes: [], topMover: null, sanctionsCount: 0 })
  const [intel, setIntel] = useState<{ secFilings: IntelItem[]; sanctions: IntelItem[]; predictions: IntelItem[] }>({ secFilings: [], sanctions: [], predictions: [] })
  const [history, setHistory] = useState<Record<string, Array<{ t: number; price: number }>>>({})
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<'24h' | '7d' | '30d' | '90d' | '1y' | '5y'>('30d')
  const [selectedTickers, setSelectedTickers] = useState<string[]>(['GC=F', 'CL=F', 'BZ=F', 'DX-Y.NYB'])
  const [normalize, setNormalize] = useState(true)
  const [drawerTicker, setDrawerTicker] = useState<string | null>(null)
  const [drawerData, setDrawerData] = useState<{ history: Array<{ price: number; change_pct: number; recorded_at: number }>; significantMoves: Array<{ price: number; change_pct: number; recorded_at: number }>; relatedIntel: IntelItem[] } | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number; current: string; rows: number } | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [q, k, i] = await Promise.all([
        window.heimdall.invoke('markets:getLatestQuotes') as Promise<Quote[]>,
        window.heimdall.invoke('markets:getKpis') as Promise<typeof kpis>,
        window.heimdall.invoke('markets:getMarketIntel') as Promise<typeof intel>
      ])
      setQuotes(q || [])
      setKpis(k || { kpiQuotes: [], topMover: null, sanctionsCount: 0 })
      setIntel(i || { secFilings: [], sanctions: [], predictions: [] })
    } catch (err) {
      console.error('Markets fetch failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchHistory = useCallback(async (tickers: string[], rangeKey: keyof typeof RANGE_HOURS) => {
    if (tickers.length === 0) return
    try {
      const h = await window.heimdall.invoke('markets:getHistory', {
        tickers, rangeHours: RANGE_HOURS[rangeKey]
      }) as Record<string, Array<{ t: number; price: number }>>
      setHistory(h || {})
    } catch (err) {
      console.error('History fetch failed:', err)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    const interval = setInterval(fetchAll, 60000)
    return () => clearInterval(interval)
  }, [fetchAll])

  // Subscribe to backfill progress events
  useEffect(() => {
    let totalSeen = 0
    let doneCount = 0
    let totalRows = 0
    const unsub = window.heimdall.on('markets:backfillProgress', (event: unknown) => {
      const e = event as { source: string; ticker: string; status: string; rows?: number }
      totalSeen++
      if (e.status === 'done' || e.status === 'error') {
        doneCount++
        if (e.rows) totalRows += e.rows
      }
      setBackfillProgress({ done: doneCount, total: totalSeen, current: `${e.source}/${e.ticker}`, rows: totalRows })
    })
    // Check if backfill is in progress on mount
    void window.heimdall.invoke('markets:backfillStatus').then((s: unknown) => {
      const status = s as { running: boolean }
      setBackfilling(status.running)
    })
    return unsub
  }, [])

  const handleBackfill = async () => {
    if (!confirm('Backfill 5 years of historical data for all configured tickers? This may take 1-2 minutes and uses bandwidth.')) return
    setBackfilling(true)
    setBackfillProgress({ done: 0, total: 0, current: 'Starting...', rows: 0 })
    try {
      await window.heimdall.invoke('markets:backfillHistory', { years: 5 })
      // Backfill runs async — UI updates via progress events
      // After 30s, refresh + clear
      setTimeout(() => {
        setBackfilling(false)
        fetchAll()
        fetchHistory(selectedTickers, range)
      }, 90000)
    } catch (err) {
      alert(`Backfill failed: ${err}`)
      setBackfilling(false)
    }
  }

  useEffect(() => {
    fetchHistory(selectedTickers, range)
  }, [selectedTickers, range, fetchHistory])

  const openDrawer = async (ticker: string) => {
    const q = quotes.find((x) => x.ticker === ticker)
    if (!q) return
    setDrawerTicker(ticker)
    try {
      const d = await window.heimdall.invoke('markets:getCommodityDetail', { ticker, name: q.name }) as typeof drawerData
      setDrawerData(d)
    } catch (err) {
      console.error('Detail fetch failed:', err)
    }
  }

  const toggleTicker = (ticker: string) => {
    setSelectedTickers((prev) =>
      prev.includes(ticker) ? prev.filter((t) => t !== ticker) : [...prev, ticker]
    )
  }

  // Build chart data
  const chartData = useMemo(() => {
    const allTimes = new Set<number>()
    Object.values(history).forEach((series) => series.forEach((p) => allTimes.add(p.t)))
    const sortedTimes = Array.from(allTimes).sort()

    const datasets = selectedTickers
      .filter((t) => history[t] && history[t].length > 0)
      .map((ticker, idx) => {
        const series = history[ticker]
        const firstPrice = series[0]?.price || 1
        const data = sortedTimes.map((t) => {
          const pt = series.find((p) => p.t === t)
          if (!pt) return null
          return normalize ? (pt.price / firstPrice) * 100 : pt.price
        })
        const q = quotes.find((x) => x.ticker === ticker)
        return {
          label: q?.name || ticker,
          data,
          borderColor: CHART_COLORS[idx % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] + '20',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          spanGaps: true
        }
      })

    // For long ranges, show date only (no time) for better readability
    const isLongRange = ['90d', '1y', '5y'].includes(range)
    const labels = sortedTimes.map((t) => isLongRange
      ? new Date(t).toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' })
      : new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    )

    return { labels, datasets }
  }, [history, selectedTickers, quotes, normalize, range])

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom' as const, labels: { color: '#cbd5e1', font: { size: 11 }, usePointStyle: true, pointStyle: 'circle' as const } },
      tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#cbd5e1', bodyColor: '#cbd5e1', borderColor: '#475569', borderWidth: 1 }
    },
    scales: {
      x: { ticks: { color: '#94a3b8', font: { size: 9 }, maxTicksLimit: 8 }, grid: { display: false } },
      y: { ticks: { color: '#94a3b8', font: { size: 10 }, callback: (v: any) => normalize ? `${v}` : `$${v}` }, grid: { color: 'rgba(71,85,105,0.2)' } }
    }
  }), [normalize])

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Markets Dashboard</span>
          <Badge variant="outline" className="text-[10px]">
            {quotes.length} commodities tracked
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {backfilling && backfillProgress && (
            <Badge variant="outline" className="text-[10px]">
              Backfill: {backfillProgress.done}/{backfillProgress.total} • {backfillProgress.rows} rows • {backfillProgress.current}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleBackfill} disabled={backfilling}>
            {backfilling ? (
              <><Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />Backfilling...</>
            ) : (
              <><Database className="h-3.5 w-3.5 mr-2" />Backfill 5Y History</>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5 mr-2', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {!loading && quotes.length === 0 && (
        <div className="flex flex-col items-center justify-center flex-1 p-12 text-center">
          <Activity className="h-12 w-12 text-muted-foreground/30 mb-4" />
          <h3 className="text-base font-semibold mb-1">No market data yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            The Commodity collector runs every 30 minutes. Trigger it manually or wait for the next cycle.
          </p>
          <p className="text-xs text-muted-foreground">
            Sources page → "Commodity & Energy Prices" → Collect Now
          </p>
        </div>
      )}

      {quotes.length > 0 && (
        <div className="p-4 space-y-4">
          {/* Zone 1: KPI Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {kpis.kpiQuotes.map((q) => (
              <KpiCard key={q.ticker} quote={q} sparkline={history[q.ticker]?.map((p) => p.price)} onClick={() => openDrawer(q.ticker)} />
            ))}
            {kpis.topMover && (
              <Card className="col-span-1">
                <CardContent className="p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Top Mover</div>
                  <div className="text-sm font-semibold truncate">{kpis.topMover.name}</div>
                  <div className={cn('text-lg font-bold', kpis.topMover.change_pct >= 0 ? 'text-green-500' : 'text-red-500')}>
                    {kpis.topMover.change_pct >= 0 ? '+' : ''}{kpis.topMover.change_pct.toFixed(2)}%
                  </div>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardContent className="p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Sanctions 24h</div>
                <div className="text-2xl font-bold">{kpis.sanctionsCount}</div>
                <div className="text-xs text-muted-foreground">new actions</div>
              </CardContent>
            </Card>
          </div>

          {/* Zone 2 + 3: Heatmap + Chart */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold">Sector Heatmap</h3>
                  <Badge variant="outline" className="text-[10px]">% change today</Badge>
                </div>
                <SectorHeatmap quotes={quotes} onSelect={openDrawer} selected={drawerTicker || undefined} />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold">Price History</h3>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={normalize ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setNormalize(!normalize)}>
                      {normalize ? 'Normalized' : 'Raw $'}
                    </Button>
                    <Select value={range} onValueChange={(v) => setRange(v as never)}>
                      <SelectTrigger className="w-24 h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="24h">24 hours</SelectItem>
                        <SelectItem value="7d">7 days</SelectItem>
                        <SelectItem value="30d">30 days</SelectItem>
                        <SelectItem value="90d">90 days</SelectItem>
                        <SelectItem value="1y">1 year</SelectItem>
                        <SelectItem value="5y">5 years</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {/* Series toggles */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {quotes.slice(0, 14).map((q, idx) => {
                    const active = selectedTickers.includes(q.ticker)
                    return (
                      <button
                        key={q.ticker}
                        onClick={() => toggleTicker(q.ticker)}
                        className={cn(
                          'px-2 py-0.5 text-[10px] rounded border transition-colors',
                          active ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:bg-accent'
                        )}
                        style={active ? { borderColor: CHART_COLORS[selectedTickers.indexOf(q.ticker) % CHART_COLORS.length], color: CHART_COLORS[selectedTickers.indexOf(q.ticker) % CHART_COLORS.length] } : undefined}
                      >
                        {q.name}
                      </button>
                    )
                  })}
                </div>
                <div className="h-72">
                  {chartData.datasets.length > 0 ? (
                    <Line data={chartData} options={chartOptions} />
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                      Waiting for time-series data...<br />
                      Need at least 2 data points per ticker (next collection in &lt; 30min)
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Zone 4: Geopolitical Context */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <IntelPanel
              title="Recent SEC Filings"
              icon={<FileText className="h-3.5 w-3.5" />}
              items={intel.secFilings}
              emptyMsg="No filings in last 7 days"
            />
            <IntelPanel
              title="Sanctions Alerts"
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              items={intel.sanctions}
              emptyMsg="No sanctions in last 7 days"
            />
            <IntelPanel
              title="Prediction Markets"
              icon={<Target className="h-3.5 w-3.5" />}
              items={intel.predictions}
              emptyMsg="No active markets"
            />
          </div>
        </div>
      )}

      {/* Drawer */}
      {drawerTicker && drawerData && (
        <CommodityDetailDrawer
          ticker={drawerTicker}
          quote={quotes.find((q) => q.ticker === drawerTicker)!}
          data={drawerData}
          onClose={() => { setDrawerTicker(null); setDrawerData(null) }}
        />
      )}
    </div>
  )
}

function KpiCard({ quote, sparkline, onClick }: { quote: Quote; sparkline?: number[]; onClick: () => void }) {
  const isPositive = quote.change_pct >= 0
  return (
    <Card className="cursor-pointer hover:bg-accent/30 transition-colors" onClick={onClick}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{quote.name}</span>
          {sparkline && sparkline.length >= 2 && (
            <PriceSparkline values={sparkline.slice(-20)} width={50} height={18} color="auto" />
          )}
        </div>
        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="text-lg font-bold">${quote.price.toFixed(2)}</div>
          </div>
          <div className={cn('flex items-center gap-0.5 text-sm font-semibold', isPositive ? 'text-green-500' : 'text-red-500')}>
            {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {Math.abs(quote.change_pct).toFixed(2)}%
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function IntelPanel({ title, icon, items, emptyMsg }: { title: string; icon: React.ReactNode; items: IntelItem[]; emptyMsg: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          {icon}
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge variant="outline" className="text-[10px] ml-auto">{items.length}</Badge>
        </div>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-4 text-center">{emptyMsg}</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-auto">
            {items.map((item) => (
              <a
                key={item.id}
                href={item.source_url}
                onClick={(e) => { if (item.source_url) { e.preventDefault(); window.open(item.source_url, '_blank') } }}
                className="block border border-border rounded-md p-2 hover:bg-accent/30 transition-colors cursor-pointer"
              >
                <div className="flex items-start gap-2 mb-1">
                  {item.severity && (
                    <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-medium', SEVERITY_BG[item.severity] || SEVERITY_BG.info)}>
                      {item.severity.toUpperCase()}
                    </span>
                  )}
                  <span className="text-xs font-medium line-clamp-2 flex-1">{item.title}</span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{item.source_name || ''}</span>
                  <span>{formatRelativeTime(item.created_at)}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function CommodityDetailDrawer({
  ticker, quote, data, onClose
}: {
  ticker: string; quote: Quote
  data: { history: Array<{ price: number; change_pct: number; recorded_at: number }>; significantMoves: Array<{ price: number; change_pct: number; recorded_at: number }>; relatedIntel: IntelItem[] }
  onClose: () => void
}) {
  const chartData = useMemo(() => ({
    labels: data.history.map((p) => new Date(p.recorded_at).toLocaleDateString()),
    datasets: [{
      label: quote.name,
      data: data.history.map((p) => p.price),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59,130,246,0.15)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2
    }]
  }), [data.history, quote.name])

  return (
    <div className="fixed inset-y-0 right-0 z-[1500] w-full sm:w-[480px] max-w-full bg-card border-l border-border shadow-2xl flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div>
          <h2 className="text-base font-semibold">{quote.name}</h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            <span className="font-mono">{ticker}</span>
            <span>•</span>
            <span>{quote.category}</span>
            <span>•</span>
            <span className="text-foreground">${quote.price.toFixed(2)}</span>
            <span className={cn(quote.change_pct >= 0 ? 'text-green-500' : 'text-red-500')}>
              {quote.change_pct >= 0 ? '+' : ''}{quote.change_pct.toFixed(2)}%
            </span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div>
          <h4 className="text-xs uppercase text-muted-foreground mb-2">30-Day Price History</h4>
          <div className="h-48 border border-border rounded p-2">
            {data.history.length >= 2 ? (
              <Line
                data={chartData}
                options={{
                  responsive: true, maintainAspectRatio: false,
                  plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15,23,42,0.95)' } },
                  scales: {
                    x: { ticks: { color: '#94a3b8', font: { size: 9 }, maxTicksLimit: 6 }, grid: { display: false } },
                    y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.2)' } }
                  }
                }}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Need more data points</div>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-xs uppercase text-muted-foreground mb-2">Significant Moves (&gt;2%)</h4>
          {data.significantMoves.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No significant moves recorded</p>
          ) : (
            <div className="space-y-1 max-h-32 overflow-auto">
              {data.significantMoves.map((m, i) => (
                <div key={i} className="flex items-center justify-between text-xs border-b border-border/50 py-1">
                  <span className="text-muted-foreground">{new Date(m.recorded_at).toLocaleString()}</span>
                  <div className="flex items-center gap-2">
                    <span>${m.price.toFixed(2)}</span>
                    <span className={cn('font-semibold', m.change_pct >= 0 ? 'text-green-500' : 'text-red-500')}>
                      {m.change_pct >= 0 ? '+' : ''}{m.change_pct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="text-xs uppercase text-muted-foreground mb-2">Related Intel</h4>
          {data.relatedIntel.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No related intel found</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-auto">
              {data.relatedIntel.map((item) => (
                <div key={item.id} className="border border-border rounded p-2">
                  <div className="text-xs font-medium line-clamp-2 mb-1">{item.title}</div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    {item.severity && (
                      <span className={cn('px-1.5 py-0.5 rounded text-[9px]', SEVERITY_BG[item.severity] || SEVERITY_BG.info)}>
                        {item.severity}
                      </span>
                    )}
                    <span>{item.source_name}</span>
                    <span className="ml-auto">{formatRelativeTime(item.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
