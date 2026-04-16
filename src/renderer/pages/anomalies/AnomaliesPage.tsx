import { useEffect, useState } from 'react'
import { Activity, RefreshCw, Loader2, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

interface Anomaly {
  id: number
  signal: string
  signal_label: string
  bucket_at: number
  value: number
  baseline_median: number
  baseline_mad: number
  modified_z: number
  direction: 'spike' | 'drop'
  severity: 'low' | 'med' | 'high'
  created_at: number
}

interface RunRow {
  id: number; started_at: number; finished_at: number;
  signals_scanned: number; anomalies_found: number; duration_ms: number
}

interface SignalSummary { signal: string; signal_label: string; anomaly_count: number; last_anomaly_at: number | null }

const SEVERITY_COLOR: Record<Anomaly['severity'], string> = {
  high: 'bg-red-500/15 border-red-500/40 text-red-300',
  med: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
  low: 'bg-slate-500/15 border-slate-500/40 text-slate-300'
}

export function AnomaliesPage() {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [signals, setSignals] = useState<SignalSummary[]>([])
  const [run, setRun] = useState<RunRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterSignal, setFilterSignal] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setError(null)
    try {
      const [r, a, s] = await Promise.all([
        window.heimdall.invoke('anomaly:latest'),
        window.heimdall.invoke('anomaly:recent', { limit: 200 }),
        window.heimdall.invoke('anomaly:signals')
      ]) as [RunRow | null, Anomaly[], SignalSummary[]]
      setRun(r); setAnomalies(a); setSignals(s)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function detect() {
    setBusy(true); setError(null)
    try {
      await window.heimdall.invoke('anomaly:detect', { window_days: 60 })
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const visible = filterSignal ? anomalies.filter((a) => a.signal === filterSignal) : anomalies

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Anomalies</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Daily report-volume and watch-term-hit time series scored against
            a trailing 14-day baseline using modified z-score (MAD-based,
            robust to outliers). Buckets with |z|&nbsp;&gt;&nbsp;3 are recorded;
            |z|&nbsp;&gt;&nbsp;4.5 is tagged high severity.
          </p>
        </div>
        <Button onClick={detect} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Detect now
        </Button>
      </div>

      <div className="px-6 py-3 border-b border-border">
        <Card>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Stat label="Signals tracked" value={run?.signals_scanned ?? signals.length} />
            <Stat label="Anomalies stored" value={anomalies.length} />
            <Stat label="High-severity" value={anomalies.filter((a) => a.severity === 'high').length} />
            <Stat label="Duration" value={run?.duration_ms != null ? `${run.duration_ms} ms` : '—'} />
            <Stat label="Last run" value={run ? formatRelativeTime(run.finished_at) : 'never'} />
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      <div className="flex-1 overflow-hidden flex">
        <div className="w-80 border-r border-border overflow-auto">
          <div className="px-4 py-2 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wider">Signals</div>
          <button
            onClick={() => setFilterSignal(null)}
            className={cn(
              'w-full text-left px-4 py-2 border-b border-border/40 text-sm hover:bg-accent/30',
              filterSignal == null && 'bg-accent/50'
            )}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1">All signals</span>
              <span className="text-xs font-mono text-muted-foreground">{anomalies.length}</span>
            </div>
          </button>
          {signals.map((s) => (
            <button
              key={s.signal}
              onClick={() => setFilterSignal(s.signal)}
              className={cn(
                'w-full text-left px-4 py-2 border-b border-border/40 text-sm hover:bg-accent/30',
                filterSignal === s.signal && 'bg-accent/50'
              )}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate">{s.signal_label}</span>
                <span className="text-xs font-mono text-muted-foreground">{s.anomaly_count}</span>
              </div>
              <div className="text-[10px] text-muted-foreground font-mono truncate">{s.signal}</div>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {visible.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No anomalies. Click <strong>Detect now</strong> to scan the last 60 days.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b border-border">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2 font-medium">Severity</th>
                  <th className="text-left px-4 py-2 font-medium">Day</th>
                  <th className="text-left px-4 py-2 font-medium">Signal</th>
                  <th className="text-right px-4 py-2 font-medium">Value</th>
                  <th className="text-right px-4 py-2 font-medium">Baseline</th>
                  <th className="text-right px-4 py-2 font-medium">Mod-Z</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.id} className="border-b border-border/40 hover:bg-accent/20">
                    <td className="px-4 py-1.5">
                      <span className={cn(
                        'text-[10px] px-2 py-0.5 rounded font-mono font-bold border uppercase',
                        SEVERITY_COLOR[a.severity]
                      )}>{a.severity}</span>
                    </td>
                    <td className="px-4 py-1.5 text-xs font-mono">{new Date(a.bucket_at).toLocaleDateString()}</td>
                    <td className="px-4 py-1.5 text-xs">
                      <div className="truncate">{a.signal_label}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">{a.signal}</div>
                    </td>
                    <td className="px-4 py-1.5 text-right text-xs font-mono flex items-center justify-end gap-1">
                      {a.direction === 'spike' ? (
                        <ArrowUp className="h-3.5 w-3.5 text-red-400" />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5 text-amber-400" />
                      )}
                      {a.value.toFixed(0)}
                    </td>
                    <td className="px-4 py-1.5 text-right text-xs font-mono text-muted-foreground">
                      {a.baseline_median.toFixed(1)} ± {a.baseline_mad.toFixed(1)}
                    </td>
                    <td className="px-4 py-1.5 text-right text-xs font-mono text-primary">{a.modified_z.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold font-mono">{value}</div>
    </div>
  )
}
