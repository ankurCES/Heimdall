import { useEffect, useState, useCallback } from 'react'
import { Target, Loader2, RefreshCw, Eye, X, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'

/**
 * Indicators & Warnings Watchlist — every active indicator extracted
 * from a published report, with live observation counts. Click an
 * indicator to see its hit history (which intel triggered it).
 *
 * The IndicatorTrackerService runs every 15 minutes against new intel.
 */

interface Indicator {
  id: string
  report_id: string
  reportTitle: string
  hypothesis: string
  indicator_text: string
  direction: 'confirming' | 'refuting'
  priority: 'high' | 'medium' | 'low'
  observationCount: number
  lastObservedAt: number | null
}

interface Observation {
  id: string
  intelId: string | null
  intelTitle: string
  matchedText: string
  score: number
  observedAt: number
  reviewed: 0 | 1
}

interface Stats {
  activeIndicators: number
  totalObservations: number
  highPriorityHits24h: number
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-500/10 text-red-300 border-red-500/30',
  medium: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  low: 'bg-slate-500/10 text-slate-400 border-slate-500/30'
}

function formatTime(ts: number | null): string {
  if (!ts) return 'never'
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

export function IndicatorWatchlistPage() {
  const [indicators, setIndicators] = useState<Indicator[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [observations, setObservations] = useState<Observation[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ind, st] = await Promise.all([
        window.heimdall.invoke('indicators:list') as Promise<{ ok: boolean; indicators?: Indicator[] }>,
        window.heimdall.invoke('indicators:stats') as Promise<{ ok: boolean } & Stats>
      ])
      if (ind.ok) setIndicators(ind.indicators || [])
      if (st.ok) setStats({ activeIndicators: st.activeIndicators, totalObservations: st.totalObservations, highPriorityHits24h: st.highPriorityHits24h })
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t) }, [load])

  useEffect(() => {
    if (!selectedId) { setObservations([]); return }
    (async () => {
      try {
        const r = await window.heimdall.invoke('indicators:observations', selectedId) as { ok: boolean; observations?: Observation[] }
        if (r.ok) setObservations(r.observations || [])
      } catch { /* */ }
    })()
  }, [selectedId])

  const runNow = async () => {
    setRunning(true)
    toast.info('Running indicator scan…')
    try {
      const r = await window.heimdall.invoke('indicators:run_now') as { ok: boolean; scanned?: number; hits?: number }
      if (r.ok) toast.success(`Scan complete — ${r.hits} hits (${r.scanned} indicators scanned)`)
    } catch (err) { toast.error(String(err)) }
    setRunning(false)
    load()
  }

  const selected = indicators.find((i) => i.id === selectedId) ?? null

  return (
    <div className="flex h-full">
      <div className={`${selectedId ? 'w-1/2' : 'w-full'} flex flex-col border-r border-border transition-all`}>
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3">
              <Target className="w-6 h-6 text-cyan-400" />
              <div>
                <h1 className="text-xl font-semibold">Indicators &amp; Warnings</h1>
                <p className="text-xs text-muted-foreground">
                  Active indicators from published reports, continuously evaluated against incoming intel.
                </p>
              </div>
            </div>
            <Button onClick={runNow} disabled={running} size="sm">
              {running ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Run scan
            </Button>
          </div>
          {stats && (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Active indicators</div>
                <div className="text-xl font-semibold">{stats.activeIndicators.toLocaleString()}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Total observations</div>
                <div className="text-xl font-semibold">{stats.totalObservations.toLocaleString()}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">High-priority hits (24h)</div>
                <div className="text-xl font-semibold text-red-300">{stats.highPriorityHits24h}</div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}
          {!loading && indicators.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <Target className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No active indicators yet.</p>
              <p className="text-xs mt-2 opacity-70">Publish a report with an Indicators &amp; Warnings annex to populate this watchlist.</p>
            </div>
          )}
          {indicators.length > 0 && (
            <div className="divide-y divide-border">
              {indicators.map((ind) => (
                <button
                  key={ind.id}
                  onClick={() => setSelectedId(ind.id === selectedId ? null : ind.id)}
                  className={`w-full text-left px-6 py-3 hover:bg-accent/30 flex items-start gap-3 ${selectedId === ind.id ? 'bg-accent/40 border-l-2 border-l-cyan-400' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {ind.direction === 'confirming' ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> : <TrendingDown className="w-3.5 h-3.5 text-amber-400" />}
                      <Badge variant="outline" className={`text-[9px] capitalize ${PRIORITY_COLORS[ind.priority]}`}>{ind.priority}</Badge>
                      <span className="text-xs text-muted-foreground truncate">{ind.reportTitle}</span>
                    </div>
                    <div className="text-sm">{ind.indicator_text}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      <span className="text-cyan-300/80">{ind.observationCount} observation{ind.observationCount === 1 ? '' : 's'}</span>
                      {' · '}
                      <span>last seen {formatTime(ind.lastObservedAt)}</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="w-1/2 flex flex-col">
          <div className="border-b border-border px-6 py-4 flex items-start justify-between">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Hypothesis</div>
              <p className="text-sm">{selected.hypothesis}</p>
              <div className="text-xs text-muted-foreground mt-2">
                <Badge variant="outline" className={`text-[9px] capitalize mr-2 ${PRIORITY_COLORS[selected.priority]}`}>{selected.priority}</Badge>
                <Badge variant="outline" className="text-[9px] capitalize">{selected.direction}</Badge>
              </div>
              <div className="mt-2 text-sm font-medium">{selected.indicator_text}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}><X className="w-3.5 h-3.5" /></Button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="text-xs text-muted-foreground mb-2 uppercase">Observations ({observations.length})</div>
            {observations.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No observations yet — this indicator hasn't been triggered.</p>
            ) : (
              <div className="space-y-2">
                {observations.map((obs) => (
                  <div key={obs.id} className="border border-border rounded p-3 text-sm">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Eye className="w-3 h-3" />
                      <span>{formatTime(obs.observedAt)}</span>
                      <span>·</span>
                      <span className="font-mono">score {obs.score.toFixed(2)}</span>
                    </div>
                    <div className="font-medium text-xs mb-1 truncate">{obs.intelTitle}</div>
                    <div className="text-xs text-muted-foreground italic">"{obs.matchedText}"</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
