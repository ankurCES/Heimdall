import { useEffect, useState } from 'react'
import { Moon, Play, Loader2, Clock, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'

interface OvernightRun {
  id: number
  started_at: number
  finished_at: number
  gaps_considered: number
  terms_spawned: number
  reports_collected: number
  dpb_id: string | null
  summary: string | null
  duration_ms: number
}

export function OvernightPage() {
  const [latest, setLatest] = useState<OvernightRun | null>(null)
  const [recent, setRecent] = useState<OvernightRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setError(null)
    try {
      const [l, r] = await Promise.all([
        window.heimdall.invoke('overnight:latest'),
        window.heimdall.invoke('overnight:recent', { limit: 20 })
      ]) as [OvernightRun | null, OvernightRun[]]
      setLatest(l); setRecent(r)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function runNow() {
    setBusy(true); setError(null)
    try {
      await window.heimdall.invoke('overnight:run_now', { periodHours: 24 })
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  async function prune() {
    try {
      await window.heimdall.invoke('overnight:prune_expired')
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Moon className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Overnight Collection Cycle</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            At 02:30 local every night, Heimdall: 1) reads the top-20 open
            intel gaps, 2) derives 1–2 search terms from each, 3) spawns them
            as watch terms with a 24h expiry, 4) generates a Daily Brief over
            the overnight window. The cycle never calls an LLM — it stays
            deterministic so it works air-gapped.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={prune} disabled={busy}>
            <Trash2 className="h-4 w-4 mr-2" />Prune expired terms
          </Button>
          <Button onClick={runNow} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            Run cycle now
          </Button>
        </div>
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
            Cycle completion summary. The DPB id (if present) links to a
            generated Daily Brief for the overnight window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!latest ? (
            <p className="text-xs text-muted-foreground">
              No cycles have completed yet. Wait for the 02:30 cron to fire or click <strong>Run cycle now</strong>.
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <Stat label="Gaps considered" value={latest.gaps_considered} />
              <Stat label="Terms spawned" value={latest.terms_spawned} hint="24h expiry" />
              <Stat label="Reports in window" value={latest.reports_collected} />
              <Stat label="Duration" value={`${latest.duration_ms} ms`} />
              <Stat label="Finished" value={formatRelativeTime(latest.finished_at)} />
              {latest.dpb_id && (
                <div className="col-span-full">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    DPB {latest.dpb_id}
                  </Badge>
                </div>
              )}
              {latest.summary && (
                <div className="col-span-full text-xs text-muted-foreground">{latest.summary}</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent cycles</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">No cycles yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left py-2 font-medium">#</th>
                  <th className="text-left py-2 font-medium">Finished</th>
                  <th className="text-right py-2 font-medium">Gaps</th>
                  <th className="text-right py-2 font-medium">Terms</th>
                  <th className="text-right py-2 font-medium">Reports</th>
                  <th className="text-left py-2 font-medium">DPB</th>
                  <th className="text-right py-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 font-mono text-xs">{r.id}</td>
                    <td className="py-1.5 text-xs">{formatRelativeTime(r.finished_at)}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.gaps_considered}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.terms_spawned}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.reports_collected}</td>
                    <td className="py-1.5 text-xs font-mono">{r.dpb_id ? r.dpb_id.slice(0, 10) : '—'}</td>
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
