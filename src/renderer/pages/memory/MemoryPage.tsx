import { useEffect, useState } from 'react'
import { Brain, Play, Loader2, Clock, Zap } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { formatRelativeTime } from '@renderer/lib/utils'

interface Run {
  id: number
  started_at: number
  finished_at: number
  sessions_considered: number
  sessions_consolidated: number
  humints_created: number
  duration_ms: number
}

export function MemoryPage() {
  const [latest, setLatest] = useState<Run | null>(null)
  const [recent, setRecent] = useState<Run[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setError(null)
    try {
      const [l, r] = await Promise.all([
        window.heimdall.invoke('memory:latest_run'),
        window.heimdall.invoke('memory:recent_runs', { limit: 20 })
      ]) as [Run | null, Run[]]
      setLatest(l); setRecent(r)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function runNow() {
    setBusy(true); setError(null)
    try {
      await window.heimdall.invoke('memory:consolidate', { lookback_ms: 72 * 60 * 60 * 1000 })
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Memory consolidation</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            At 03:00 local every night, Heimdall compresses yesterday's chat
            sessions into durable <code className="font-mono">humint_reports</code> rows with
            <code className="font-mono">auto_consolidated=1</code>. The agent's
            <code className="font-mono">humint_recall</code> tool picks them
            up automatically, so institutional memory accumulates without the
            analyst having to explicitly record every finding.
          </p>
        </div>
        <Button onClick={runNow} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          Consolidate now (72h lookback)
        </Button>
      </div>

      {error && (
        <div className="text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Latest run</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Needs a configured LLM connection. Sessions with fewer than 4
            exchanges or &lt;800 total chars are skipped; sessions the model
            judges off-topic are considered but produce no humint row.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!latest ? (
            <p className="text-xs text-muted-foreground">
              No consolidation runs yet. The 03:00 cron will fire tonight, or click <strong>Consolidate now</strong>.
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <Stat label="Sessions considered" value={latest.sessions_considered} />
              <Stat label="Sessions consolidated" value={latest.sessions_consolidated} />
              <Stat label="HUMINTs created" value={latest.humints_created} hint="auto_consolidated=1" />
              <Stat label="Duration" value={`${latest.duration_ms} ms`} />
              <Stat label="Finished" value={formatRelativeTime(latest.finished_at)} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent runs</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left py-2 font-medium">#</th>
                  <th className="text-left py-2 font-medium">Finished</th>
                  <th className="text-right py-2 font-medium">Considered</th>
                  <th className="text-right py-2 font-medium">Created</th>
                  <th className="text-right py-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 font-mono text-xs">{r.id}</td>
                    <td className="py-1.5 text-xs">{formatRelativeTime(r.finished_at)}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.sessions_considered}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.humints_created}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.duration_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-semibold font-mono">{value}</div>
      {hint && <div className="text-[9px] text-muted-foreground italic mt-0.5">{hint}</div>}
    </div>
  )
}
