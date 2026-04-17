import { useEffect, useState, useCallback } from 'react'
import { Moon, RefreshCw, Loader2, Search, ExternalLink, Globe2, AlertTriangle, ChevronDown, ChevronRight, Power, X, ShieldCheck, ShieldOff, Tag } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

interface DarkWebReport {
  id: string
  title: string
  source_url: string | null
  source_name: string
  hostname: string | null
  body_chars: number
  verification_score: number
  created_at: number
  updated_at: number
  tags: string[]
}

interface OnionHost {
  hostname: string
  urls: string[]
  reportCount: number
  lastSeen: number
}

interface RefreshJob {
  id: string
  startedAt: number
  finishedAt: number | null
  total: number
  done: number
  succeeded: number
  failed: number
  skippedDuplicate: number
  status: 'running' | 'completed' | 'cancelled' | 'error'
  lastError: string | null
}

interface TorState {
  status: 'stopped' | 'probing' | 'starting' | 'connected_external' | 'connected_managed' | 'error'
  socksHost: string
  socksPort: number
}

const PAGE_SIZE = 50

export function DarkWebIntelTab() {
  const [items, setItems] = useState<DarkWebReport[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState('')
  const [hostnameFilter, setHostnameFilter] = useState<string | null>(null)
  const [hosts, setHosts] = useState<OnionHost[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, { content?: string; loading: boolean }>>({})
  const [tor, setTor] = useState<TorState | null>(null)
  const [job, setJob] = useState<RefreshJob | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await invoke('darkweb:list', {
        limit: PAGE_SIZE,
        offset,
        search: search.trim() || undefined,
        hostname: hostnameFilter || undefined
      }) as { total: number; items: DarkWebReport[] }
      setItems(r.items)
      setTotal(r.total)
    } finally { setLoading(false) }
  }, [invoke, offset, search, hostnameFilter])

  const loadHosts = useCallback(async () => {
    const r = await invoke('darkweb:hosts') as OnionHost[]
    setHosts(r)
  }, [invoke])

  const loadTor = useCallback(async () => {
    try {
      const s = await invoke('darkweb:tor_status') as TorState
      setTor(s)
    } catch { /* ignore */ }
  }, [invoke])

  const loadJob = useCallback(async () => {
    try {
      const j = await invoke('darkweb:refresh_status') as RefreshJob | null
      setJob(j)
      if (j && j.status === 'running') setRefreshBusy(true)
    } catch { /* ignore */ }
  }, [invoke])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadHosts(); void loadTor(); void loadJob() }, [loadHosts, loadTor, loadJob])

  // Live refresh-job progress events from the bridge.
  useEffect(() => {
    const unsubProgress = window.heimdall.on('darkweb:refresh_progress', (payload: unknown) => {
      setJob(payload as RefreshJob)
    })
    const unsubComplete = window.heimdall.on('darkweb:refresh_complete', (payload: unknown) => {
      const j = payload as RefreshJob
      setJob(j)
      setRefreshBusy(false)
      const summary = `${j.succeeded} new, ${j.skippedDuplicate} unchanged, ${j.failed} failed`
      if (j.status === 'completed') toast.success(`Dark-web refresh complete`, { description: summary })
      else if (j.status === 'cancelled') toast.message('Refresh cancelled', { description: summary })
      else toast.error(`Refresh ${j.status}`, { description: j.lastError || summary })
      void load()
      void loadHosts()
    })
    return () => { unsubProgress(); unsubComplete() }
  }, [load, loadHosts])

  const refreshAll = async () => {
    setRefreshBusy(true)
    try {
      const r = await invoke('darkweb:refresh_all', { hostnameFilter: hostnameFilter || undefined }) as { ok: boolean; reason?: string; message?: string; job?: RefreshJob }
      if (!r.ok) {
        if (r.reason === 'tor_not_connected') {
          toast.error('Tor not connected', { description: r.message || 'Open Settings → Dark Web → Connect to Tor.' })
        } else if (r.reason === 'already_running') {
          toast.message('Refresh already in progress', { description: `${r.job?.done ?? 0}/${r.job?.total ?? 0} done` })
          if (r.job) setJob(r.job)
        } else {
          toast.error('Refresh failed', { description: r.message || r.reason })
        }
        setRefreshBusy(r.reason === 'already_running')
      } else if (r.job) {
        setJob(r.job)
      }
    } catch (err) {
      toast.error('Refresh error', { description: String(err) })
      setRefreshBusy(false)
    }
  }

  const cancelRefresh = async () => {
    try { await invoke('darkweb:cancel_refresh') } catch { /* */ }
  }

  const toggleExpand = async (id: string) => {
    setExpanded((prev) => {
      const next = { ...prev }
      if (next[id]) {
        delete next[id]
      } else {
        next[id] = { loading: true }
      }
      return next
    })
    if (expanded[id]) return // closing
    try {
      const c = await invoke('darkweb:get_content', { id }) as { content: string; tags: string[] } | null
      setExpanded((prev) => ({ ...prev, [id]: { content: c?.content || '(no content)', loading: false } }))
    } catch (err) {
      setExpanded((prev) => ({ ...prev, [id]: { content: `Error: ${err}`, loading: false } }))
    }
  }

  const torConnected = tor?.status === 'connected_external' || tor?.status === 'connected_managed'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-card/50">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <Moon className="h-5 w-5 text-fuchsia-400 mt-1 shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold flex items-center gap-2">
                Dark-web intel
                {torConnected ? (
                  <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    <ShieldCheck className="h-3 w-3 mr-1" /> Tor: {tor!.socksHost}:{tor!.socksPort}
                  </Badge>
                ) : (
                  <Badge className="text-[10px] bg-red-500/20 text-red-300 border border-red-500/40">
                    <ShieldOff className="h-3 w-3 mr-1" /> Tor disconnected
                  </Badge>
                )}
              </h1>
              <p className="text-xs text-muted-foreground mt-1">
                {total.toLocaleString()} dark-web report{total === 1 ? '' : 's'} from {hosts.length} unique onion host{hosts.length === 1 ? '' : 's'}.
                Refresh fetches the latest content from every <code className="font-mono">.onion</code> URL referenced in stored intel.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {job && job.status === 'running' && (
              <Button size="sm" variant="outline" onClick={cancelRefresh}
                className="border-red-500/30 text-red-400 hover:bg-red-500/10">
                <X className="h-3.5 w-3.5 mr-1.5" /> Cancel
              </Button>
            )}
            <Button onClick={refreshAll} disabled={refreshBusy || !torConnected}
              title={!torConnected ? 'Connect Tor in Settings → Dark Web first' : undefined}>
              {refreshBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              {refreshBusy ? `Refreshing ${job?.done ?? 0}/${job?.total ?? '?'}` : `Refresh ${hostnameFilter ? hostnameFilter : 'All'}`}
            </Button>
          </div>
        </div>

        {/* Live refresh progress bar */}
        {job && job.status === 'running' && (
          <div className="mt-3">
            <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
              <span>Fetching {job.done}/{job.total} onion URLs · {job.succeeded} new · {job.skippedDuplicate} unchanged · {job.failed} failed</span>
              <span>{Math.round((job.done / job.total) * 100)}%</span>
            </div>
            <div className="h-1.5 bg-muted rounded overflow-hidden">
              <div className="h-full bg-fuchsia-400 transition-all"
                style={{ width: `${(job.done / job.total) * 100}%` }} />
            </div>
            {job.lastError && (
              <div className="text-[10px] text-amber-300 mt-1 truncate" title={job.lastError}>
                Last error: {job.lastError}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* Hosts sidebar */}
        <div className="w-64 border-r border-border bg-card/30 flex flex-col">
          <div className="px-3 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
            <span>Onion hosts ({hosts.length})</span>
            {hostnameFilter && (
              <button onClick={() => { setHostnameFilter(null); setOffset(0) }}
                className="text-fuchsia-400 hover:text-fuchsia-300 normal-case tracking-normal">
                Clear filter
              </button>
            )}
          </div>
          <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
            {hosts.length === 0 && (
              <p className="text-[10px] text-muted-foreground text-center py-4">No onion hosts yet</p>
            )}
            {hosts.map((h) => (
              <button
                key={h.hostname}
                onClick={() => { setHostnameFilter(h.hostname); setOffset(0) }}
                className={cn(
                  'w-full text-left px-2 py-1.5 rounded text-[11px] transition-colors',
                  hostnameFilter === h.hostname
                    ? 'bg-fuchsia-500/15 text-fuchsia-200 border border-fuchsia-500/30'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Globe2 className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate flex-1">{h.hostname.slice(0, 16)}…</span>
                </div>
                <div className="flex justify-between mt-1 text-[10px] opacity-70">
                  <span>{h.reportCount} report{h.reportCount === 1 ? '' : 's'}</span>
                  <span>{formatRelativeTime(h.lastSeen)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Reports list */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Search bar */}
          <div className="px-4 py-2 border-b border-border bg-card/30 flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOffset(0) }}
              placeholder="Search title or content…"
              className="h-7 text-xs"
            />
            {hostnameFilter && (
              <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                <Globe2 className="h-2.5 w-2.5" /> {hostnameFilter.slice(0, 20)}…
              </Badge>
            )}
          </div>

          {/* List */}
          <div className="flex-1 overflow-auto">
            {!torConnected && (
              <div className="m-4 p-3 rounded border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-200 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div>
                  <span className="font-semibold">Tor isn't connected.</span> The "Refresh" button is disabled until you connect Tor in
                  Settings → Dark Web → Connect to Tor. You can still browse and search existing dark-web intel below.
                </div>
              </div>
            )}
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <Moon className="h-10 w-10 opacity-30 mb-2" />
                <p className="text-sm">No dark-web reports yet</p>
                <p className="text-[10px] mt-1">Run an Agentic chat with darkweb-relevant terms to populate.</p>
              </div>
            )}
            {items.map((r) => {
              const isOpen = !!expanded[r.id]
              return (
                <div key={r.id} className="border-b border-border/50">
                  <button
                    onClick={() => toggleExpand(r.id)}
                    className="w-full px-4 py-3 hover:bg-accent/30 transition-colors text-left"
                  >
                    <div className="flex items-start gap-2">
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="text-[9px] uppercase font-mono shrink-0 border-fuchsia-500/40 text-fuchsia-300">DARKWEB</Badge>
                          <span className="text-sm truncate">{r.title.replace(/^\[DARKWEB\]\s*/, '')}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground flex-wrap">
                          <span className="font-mono truncate max-w-md">{r.source_url || '(no url)'}</span>
                          <span>·</span>
                          <span>{r.body_chars.toLocaleString()} chars</span>
                          <span>·</span>
                          <span>V:{r.verification_score}/100</span>
                          <span>·</span>
                          <span>{formatRelativeTime(r.created_at)}</span>
                          {r.updated_at > r.created_at && (
                            <>
                              <span>·</span>
                              <span className="text-emerald-300">refreshed {formatRelativeTime(r.updated_at)}</span>
                            </>
                          )}
                        </div>
                        {r.tags.length > 0 && (
                          <div className="flex items-center gap-1 mt-1 flex-wrap">
                            {r.tags.slice(0, 6).map((t) => (
                              <Badge key={t} variant="outline" className="text-[9px] py-0 px-1 gap-0.5">
                                <Tag className="h-2 w-2" /> {t}
                              </Badge>
                            ))}
                            {r.tags.length > 6 && <span className="text-[9px] text-muted-foreground">+{r.tags.length - 6}</span>}
                          </div>
                        )}
                      </div>
                      {r.source_url && (
                        <a href={r.source_url}
                          onClick={(e) => e.stopPropagation()}
                          target="_blank" rel="noreferrer"
                          className="shrink-0 text-muted-foreground hover:text-fuchsia-300"
                          title="Open in browser (will fail without Tor Browser)"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-3 ml-6">
                      {expanded[r.id]?.loading ? (
                        <div className="text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 inline mr-1 animate-spin" /> Loading content…</div>
                      ) : (
                        <pre className="text-[11px] font-mono whitespace-pre-wrap bg-muted/40 p-2 rounded max-h-96 overflow-auto break-words">
                          {expanded[r.id]?.content?.slice(0, 8000)}
                          {(expanded[r.id]?.content?.length ?? 0) > 8000 && '\n…[truncated]'}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="px-4 py-2 border-t border-border bg-card/30 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</Button>
                <Button size="sm" variant="ghost" disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
