// WatchlistPage — v1.7.5 aggregate view of watched canonical entities.
//
// Closes the v1.7.4 loop. Each EntityTimelinePage shows the watch
// toggle for that one entity; this page surfaces every watched
// entity at once with a quick "is anything firing today?" read,
// without needing to drill into each timeline individually.

import { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Bell, BellOff, RefreshCw, Loader2, AlertCircle, Eye, ArrowRight,
  CheckCircle2, X as XIcon
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

interface EntityWatchWithMeta {
  id: string
  canonical_id: string
  alert_enabled: 0 | 1
  last_alerted_intel_id: string | null
  last_alerted_at: number | null
  created_at: number
  updated_at: number
  canonical_value: string | null
  entity_type: string | null
  mention_count: number
}

export function WatchlistPage() {
  const [rows, setRows] = useState<EntityWatchWithMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await window.heimdall.invoke('entity:watch_list') as EntityWatchWithMeta[]
      setRows(r)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const setEnabled = async (canonicalId: string, enabled: boolean) => {
    try {
      await window.heimdall.invoke('entity:watch_set_enabled', { canonicalId, enabled })
      await load()
    } catch (err) { toast.error('Toggle failed', { description: String(err) }) }
  }

  const remove = async (canonicalId: string, name: string) => {
    if (!confirm(`Stop watching "${name}"?`)) return
    try {
      await window.heimdall.invoke('entity:watch_remove', canonicalId)
      await load()
    } catch (err) { toast.error('Remove failed', { description: String(err) }) }
  }

  const enabledCount = rows.filter((r) => r.alert_enabled === 1).length
  const recentCount = rows.filter((r) => r.last_alerted_at && Date.now() - r.last_alerted_at < 24 * 3600 * 1000).length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Eye className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Entity Watchlist</h1>
          <Badge variant="outline" className="text-[10px] ml-2">v1.7.5</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={load} disabled={loading} className="h-8">
              <RefreshCw className={cn('h-3.5 w-3.5 mr-1', loading && 'animate-spin')} /> Refresh
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Pinned canonical entities. The watchlist cron runs every 5 minutes; new intel mentions surface as toasts.
          Add/remove from any entity's timeline page via the Watch / Watching toggle.
        </p>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <Card>
            <CardContent className="p-3">
              <div className="text-muted-foreground">Total watched</div>
              <div className="text-lg font-semibold">{rows.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-muted-foreground">Alerts enabled</div>
              <div className={cn('text-lg font-semibold', enabledCount > 0 && 'text-emerald-600 dark:text-emerald-400')}>
                {enabledCount}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-muted-foreground">Fired in last 24h</div>
              <div className={cn('text-lg font-semibold', recentCount > 0 && 'text-amber-600 dark:text-amber-400')}>
                {recentCount}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="border border-red-500/30 bg-red-500/5 rounded-md p-3 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading watchlist…
          </div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div className="text-center py-12 space-y-2">
            <div className="text-sm text-muted-foreground">
              No entities watched yet.
            </div>
            <div className="text-xs text-muted-foreground">
              Open any entity's timeline (<Link to="/entities" className="text-primary hover:underline">Entities</Link>) and click the bell to start watching.
            </div>
          </div>
        )}
        {rows.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Watched entities</CardTitle>
              <CardDescription className="text-xs">
                Click any row to open its timeline. Toggle the bell to pause alerts without removing from the list.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="text-[11px] text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-2 font-normal">Entity</th>
                    <th className="text-left px-2 py-2 font-normal">Type</th>
                    <th className="text-right px-2 py-2 font-normal">Mentions</th>
                    <th className="text-left px-2 py-2 font-normal">Last alerted</th>
                    <th className="text-left px-2 py-2 font-normal">Watching since</th>
                    <th className="text-right px-4 py-2 font-normal">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const recent = r.last_alerted_at && Date.now() - r.last_alerted_at < 24 * 3600 * 1000
                    return (
                      <tr
                        key={r.id}
                        onClick={() => navigate(`/entity/${encodeURIComponent(r.canonical_id)}`)}
                        className="border-b border-border/30 last:border-0 hover:bg-accent/40 cursor-pointer"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate max-w-[20rem]">
                              {r.canonical_value ?? <span className="text-muted-foreground italic">(deleted canonical)</span>}
                            </span>
                            {r.alert_enabled === 1 ? (
                              <Bell className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                            ) : (
                              <BellOff className="h-3 w-3 text-muted-foreground" />
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{r.canonical_id.slice(0, 8)}…</div>
                        </td>
                        <td className="px-2 py-3">
                          <Badge variant="outline" className="text-[10px] uppercase font-mono">
                            {r.entity_type ?? '—'}
                          </Badge>
                        </td>
                        <td className="px-2 py-3 text-right font-mono text-xs">{r.mention_count}</td>
                        <td className="px-2 py-3 text-xs text-muted-foreground">
                          {r.last_alerted_at ? (
                            <span className={cn(recent && 'text-amber-600 dark:text-amber-400 font-medium')}>
                              {formatRelativeTime(r.last_alerted_at)}
                            </span>
                          ) : <span className="italic">never</span>}
                        </td>
                        <td className="px-2 py-3 text-xs text-muted-foreground">{formatRelativeTime(r.created_at)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => setEnabled(r.canonical_id, r.alert_enabled !== 1)}
                              className={cn(
                                'h-7 px-2',
                                r.alert_enabled === 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                              )}
                              title={r.alert_enabled === 1 ? 'Pause alerts' : 'Resume alerts'}
                            >
                              {r.alert_enabled === 1 ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => remove(r.canonical_id, r.canonical_value ?? r.canonical_id)}
                              className="h-7 px-2 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                              title="Stop watching"
                            >
                              <XIcon className="h-3.5 w-3.5" />
                            </Button>
                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground ml-1" />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        <div className="mt-6 text-[11px] text-muted-foreground text-center">
          The cron emits up to 5 toast alerts per entity per tick, then advances the cursor. Pause via the bell to keep the row but stop the toasts.
          {' '}<CheckCircle2 className="inline h-3 w-3" /> First-tick mentions are skipped to prevent flooding when you add a high-traffic entity.
        </div>
      </div>
    </div>
  )
}
