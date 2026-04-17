import { useEffect, useState, useCallback } from 'react'
import {
  Play, Plus, Trash2, RefreshCw, Loader2, Search, Power, ShieldCheck, ShieldOff,
  AlertTriangle, X, ChevronDown, ChevronRight, Check, Globe2, Tag, ExternalLink, Ban
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'

interface DarkWebSeed {
  id: string
  category: string
  query: string
  description: string | null
  enabled: boolean
  isCustom: boolean
  lastRunAt: number | null
  lastError: string | null
  hitCount: number
  createdAt: number
}
interface SeedRunProgress {
  jobId: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  totalSeeds: number
  doneSeeds: number
  currentSeed: { id: string; category: string; query: string } | null
  totalHits: number
  storedReports: number
  failedFetches: number
  skippedQuarantined: number
  lastError: string | null
}
interface AhmiaHit { title: string; onionUrl: string; description: string; lastSeen?: string }
interface HostHealth {
  hostname: string
  consecutiveFailures: number
  totalFailures: number
  totalSuccesses: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  quarantined: boolean
  quarantinedAt: number | null
  updatedAt: number
}
interface TorState { status: string; socksHost: string; socksPort: number }

const CATEGORY_COLORS: Record<string, string> = {
  cybercrime:       'border-red-400/30 bg-red-400/5 text-red-200',
  'financial-fraud':'border-amber-400/30 bg-amber-400/5 text-amber-200',
  marketplace:      'border-orange-400/30 bg-orange-400/5 text-orange-200',
  trafficking:      'border-pink-400/30 bg-pink-400/5 text-pink-200',
  'threat-actor':   'border-fuchsia-400/30 bg-fuchsia-400/5 text-fuchsia-200',
  geopolitical:     'border-blue-400/30 bg-blue-400/5 text-blue-200'
}
function colorFor(cat: string): string {
  return CATEGORY_COLORS[cat] || 'border-slate-400/30 bg-slate-400/5 text-slate-200'
}

export function DarkWebExplorerTab() {
  const [tor, setTor] = useState<TorState | null>(null)
  const [seeds, setSeeds] = useState<DarkWebSeed[]>([])
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({})
  const [job, setJob] = useState<SeedRunProgress | null>(null)
  const [seedRunBusy, setSeedRunBusy] = useState(false)
  const [hostHealth, setHostHealth] = useState<HostHealth[]>([])
  const [showQuarantined, setShowQuarantined] = useState(false)

  // Crawler state
  const [crawlerStatus, setCrawlerStatus] = useState<{
    enabled: boolean; queued: number; inFlight: number
    totalCrawled: number; totalDiscovered: number; totalSkippedDedup: number; totalFailed: number
  } | null>(null)

  // Custom search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<AhmiaHit[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [addingUrl, setAddingUrl] = useState<Set<string>>(new Set())

  // Add-custom-seed modal
  const [addOpen, setAddOpen] = useState(false)
  const [newCat, setNewCat] = useState('')
  const [newQuery, setNewQuery] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadAll = useCallback(async () => {
    try {
      const t = await invoke('darkweb:tor_status') as TorState
      setTor(t)
      const s = await invoke('darkweb:seeds_list') as DarkWebSeed[]
      setSeeds(s)
      const j = await invoke('darkweb:seeds_status') as SeedRunProgress | null
      setJob(j)
      if (j?.status === 'running') setSeedRunBusy(true)
      const h = await invoke('darkweb:hosts_health', { quarantinedOnly: false, limit: 200 }) as HostHealth[]
      setHostHealth(h)
      const cs = await invoke('darkweb:crawler_status') as typeof crawlerStatus
      setCrawlerStatus(cs)
    } catch { /* */ }
  }, [invoke])

  useEffect(() => { void loadAll() }, [loadAll])

  // Live seed-run progress
  useEffect(() => {
    const unsub = window.heimdall.on('darkweb:seed_progress', (p: unknown) => {
      const pp = p as SeedRunProgress
      setJob(pp)
      if (pp.status !== 'running') {
        setSeedRunBusy(false)
        const summary = `${pp.doneSeeds}/${pp.totalSeeds} seeds — ${pp.storedReports} reports stored, ${pp.failedFetches} failed`
        if (pp.status === 'completed') toast.success('Seed sweep complete', { description: summary })
        else if (pp.status === 'cancelled') toast.message('Seed sweep cancelled', { description: summary })
        else toast.error(`Seed sweep ${pp.status}`, { description: pp.lastError || summary })
        void loadAll()
      }
    })
    const unsubCrawl = window.heimdall.on('darkweb:crawl_progress', (s: unknown) => {
      setCrawlerStatus(s as typeof crawlerStatus)
    })
    return () => { unsub(); unsubCrawl() }
  }, [loadAll])

  const torConnected = tor?.status === 'connected_external' || tor?.status === 'connected_managed'

  // Group seeds by category
  const grouped: Record<string, DarkWebSeed[]> = {}
  for (const s of seeds) {
    ;(grouped[s.category] = grouped[s.category] || []).push(s)
  }
  const sortedCategories = Object.keys(grouped).sort()
  const allCategories = Array.from(new Set([...sortedCategories, 'cybercrime', 'financial-fraud', 'marketplace', 'trafficking', 'threat-actor', 'geopolitical'])).sort()

  const toggleCat = (cat: string) => setOpenCategories((p) => ({ ...p, [cat]: !(p[cat] ?? true) }))
  const isOpen = (cat: string) => openCategories[cat] ?? true

  const onToggleSeed = async (seed: DarkWebSeed) => {
    setSeeds((prev) => prev.map((s) => s.id === seed.id ? { ...s, enabled: !s.enabled } : s))
    try { await invoke('darkweb:seeds_toggle', { id: seed.id, enabled: !seed.enabled }) } catch { void loadAll() }
  }
  const onDeleteSeed = async (seed: DarkWebSeed) => {
    if (!confirm(`Delete seed "${seed.query}"?`)) return
    try { await invoke('darkweb:seeds_delete', { id: seed.id }); void loadAll() } catch (err) { toast.error(String(err)) }
  }
  const onRunSeed = async (seed: DarkWebSeed) => {
    if (!torConnected) { toast.error('Tor not connected'); return }
    toast.message(`Running "${seed.query}"…`)
    try {
      const r = await invoke('darkweb:seeds_run', { id: seed.id }) as { ok: boolean; hits: number; stored: number; failed: number; reason?: string }
      if (r.ok) toast.success(`Seed ran`, { description: `${r.hits} hits, ${r.stored} stored, ${r.failed} failed` })
      else toast.error(`Seed failed`, { description: r.reason })
      void loadAll()
    } catch (err) { toast.error(String(err)) }
  }
  const onRunAll = async () => {
    if (!torConnected) { toast.error('Tor not connected'); return }
    setSeedRunBusy(true)
    try {
      const r = await invoke('darkweb:seeds_run_all') as { ok: boolean; reason?: string; jobId?: string }
      if (!r.ok) { toast.error(`Cannot start sweep`, { description: r.reason }); setSeedRunBusy(false) }
    } catch (err) { toast.error(String(err)); setSeedRunBusy(false) }
  }
  const onCancelSweep = async () => { try { await invoke('darkweb:seeds_cancel') } catch { /* */ } }

  const onSearch = async () => {
    const q = searchQuery.trim()
    if (!q) return
    setSearchBusy(true)
    setSearchHits([])
    try {
      const r = await invoke('darkweb:explorer_search', { query: q, limit: 15 }) as { ok: boolean; hits?: AhmiaHit[]; reason?: string; message?: string }
      if (!r.ok) { toast.error('Search failed', { description: r.message || r.reason }) }
      else setSearchHits(r.hits || [])
    } catch (err) { toast.error(String(err)) }
    finally { setSearchBusy(false) }
  }

  const onAddOne = async (hit: AhmiaHit) => {
    if (!torConnected) { toast.error('Tor not connected'); return }
    setAddingUrl((p) => new Set(p).add(hit.onionUrl))
    try {
      const r = await invoke('darkweb:add_from_search', { url: hit.onionUrl, sourceQuery: searchQuery }) as { ok: boolean; reportId?: string; reason?: string; message?: string }
      if (r.ok) toast.success('Added to intel', { description: hit.onionUrl.slice(0, 60) })
      else toast.error('Add failed', { description: r.message || r.reason })
    } catch (err) { toast.error(String(err)) }
    finally { setAddingUrl((p) => { const n = new Set(p); n.delete(hit.onionUrl); return n }) }
  }

  const onAddAll = async () => {
    if (!torConnected) { toast.error('Tor not connected'); return }
    if (searchHits.length === 0) return
    const urls = searchHits.map((h) => h.onionUrl)
    setAddingUrl(new Set(urls))
    try {
      const r = await invoke('darkweb:add_batch_from_search', { urls, sourceQuery: searchQuery }) as { ok: boolean; stored: number; failed: number }
      if (r.ok) toast.success('Batch add complete', { description: `${r.stored} stored, ${r.failed} failed` })
    } catch (err) { toast.error(String(err)) }
    finally { setAddingUrl(new Set()) }
  }

  const onAddSeedSubmit = async () => {
    if (!newCat.trim() || !newQuery.trim()) { toast.error('Category and query required'); return }
    try {
      const r = await invoke('darkweb:seeds_add_custom', { category: newCat, query: newQuery, description: newDesc }) as { ok: boolean; reason?: string; message?: string }
      if (r.ok) {
        toast.success('Custom seed added')
        setAddOpen(false); setNewCat(''); setNewQuery(''); setNewDesc('')
        void loadAll()
      } else toast.error('Add failed', { description: r.message || r.reason })
    } catch (err) { toast.error(String(err)) }
  }

  const onUnquarantine = async (hostname: string) => {
    try { await invoke('darkweb:hosts_unquarantine', { hostname }); toast.success(`${hostname.slice(0, 16)}… un-quarantined`); void loadAll() } catch (err) { toast.error(String(err)) }
  }

  const quarantinedHosts = hostHealth.filter((h) => h.quarantined)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tor warning banner */}
      {!torConnected && (
        <div className="m-4 p-3 rounded border border-amber-500/30 bg-amber-500/5 flex items-start gap-2">
          <ShieldOff className="h-4 w-4 mt-0.5 text-amber-300 shrink-0" />
          <div className="flex-1 text-xs">
            <span className="font-semibold text-amber-200">Tor is not connected.</span>
            <span className="text-muted-foreground"> Seeded sweeps and "Add to Intel" are disabled. Custom search via Ahmia (clearnet) still works.</span>
          </div>
          <Link to="/settings" className="shrink-0">
            <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-200 hover:bg-amber-500/10">
              <Power className="h-3.5 w-3.5 mr-1" /> Connect Tor
            </Button>
          </Link>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* ── Seeded sweep section ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm flex items-center gap-2">
                  <ListChecksIcon /> Seeded sweeps
                  {torConnected && <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"><ShieldCheck className="h-3 w-3 mr-1" /> Tor ready</Badge>}
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Curated dark-web search queries grouped by category. Each enabled seed runs <code className="font-mono">ahmia_search</code>,
                  fetches the top onion results through Tor, and stores them as <code className="font-mono">[DARKWEB]</code> intel.
                  All discoveries auto-enrich (IOC extraction, threat-actor matching, LLM tag generation).
                </CardDescription>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Custom seed
                </Button>
                {seedRunBusy && job?.status === 'running' && (
                  <Button size="sm" variant="outline" onClick={onCancelSweep} className="border-red-500/30 text-red-400 hover:bg-red-500/10">
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel
                  </Button>
                )}
                <Button size="sm" onClick={onRunAll} disabled={!torConnected || seedRunBusy || seeds.filter((s) => s.enabled).length === 0}>
                  {seedRunBusy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
                  Run all enabled ({seeds.filter((s) => s.enabled).length})
                </Button>
              </div>
            </div>

            {/* Live progress bar */}
            {job && job.status === 'running' && (
              <div className="mt-3">
                <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                  <span>
                    Sweeping seed {job.doneSeeds}/{job.totalSeeds}
                    {job.currentSeed && ` · "${job.currentSeed.query}" (${job.currentSeed.category})`}
                  </span>
                  <span>{job.totalHits} hits · {job.storedReports} stored · {job.failedFetches} failed</span>
                </div>
                <div className="h-1.5 bg-muted rounded overflow-hidden">
                  <div className="h-full bg-fuchsia-400 transition-all"
                    style={{ width: `${(job.doneSeeds / Math.max(job.totalSeeds, 1)) * 100}%` }} />
                </div>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {sortedCategories.map((cat) => {
              const items = grouped[cat]
              const enabledCount = items.filter((s) => s.enabled).length
              return (
                <div key={cat} className={cn('rounded border p-2', colorFor(cat))}>
                  <button onClick={() => toggleCat(cat)} className="w-full flex items-center gap-2 text-xs font-semibold">
                    {isOpen(cat) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {cat}
                    <Badge variant="outline" className="text-[10px] py-0 px-1">{enabledCount}/{items.length}</Badge>
                  </button>
                  {isOpen(cat) && (
                    <div className="mt-2 space-y-1.5">
                      {items.map((s) => (
                        <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-card/40 border border-border/40">
                          <Switch checked={s.enabled} onCheckedChange={() => onToggleSeed(s)} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono truncate">{s.query}</span>
                              {s.isCustom && <Badge variant="outline" className="text-[9px] py-0 px-1">custom</Badge>}
                            </div>
                            {s.description && <div className="text-[10px] text-muted-foreground truncate">{s.description}</div>}
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                              <span>{s.hitCount} total hits</span>
                              {s.lastRunAt && <span>· last {formatRelativeTime(s.lastRunAt)}</span>}
                              {s.lastError && <span className="text-red-300">· error: {s.lastError.slice(0, 50)}</span>}
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => onRunSeed(s)} disabled={!torConnected || !s.enabled} title="Run this seed">
                            <Play className="h-3 w-3" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onDeleteSeed(s)} title="Delete seed">
                            <Trash2 className="h-3 w-3 text-red-400" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {seeds.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No seeds configured. Click "Custom seed" to add one.</p>
            )}
          </CardContent>
        </Card>

        {/* ── Custom search section ── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2"><Search className="h-4 w-4" /> Custom dark-web search</CardTitle>
            <CardDescription className="text-xs">
              Search Ahmia (clearnet, no Tor needed). Each result card has an "Add to Intel" button — clicking it
              fetches the onion page through Tor and stores it as <code className="font-mono">[DARKWEB]</code> intel.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onSearch() }}
                placeholder="Search dark-web (e.g. 'iran sanctions evasion', 'lockbit victim')…"
                className="text-sm"
              />
              <Button onClick={onSearch} disabled={searchBusy || !searchQuery.trim()}>
                {searchBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}
                Search
              </Button>
              {searchHits.length > 0 && (
                <Button variant="outline" onClick={onAddAll} disabled={!torConnected || addingUrl.size > 0}>
                  <Plus className="h-4 w-4 mr-1" /> Add all ({searchHits.length})
                </Button>
              )}
            </div>
            {searchHits.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {searchHits.map((hit, i) => (
                  <div key={i} className="rounded border border-border p-3 bg-card/30 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{hit.title}</div>
                        <div className="text-[10px] font-mono text-muted-foreground truncate">{hit.onionUrl}</div>
                      </div>
                      <a href={hit.onionUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-fuchsia-300 shrink-0">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-3">{hit.description}</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-[10px] text-muted-foreground">{hit.lastSeen ? `seen ${hit.lastSeen}` : ''}</span>
                      <Button size="sm" variant="outline" onClick={() => onAddOne(hit)} disabled={!torConnected || addingUrl.has(hit.onionUrl)}>
                        {addingUrl.has(hit.onionUrl) ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                        Add to intel
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!searchBusy && searchQuery && searchHits.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No results. Try different keywords or actor names.</p>
            )}
          </CardContent>
        </Card>

        {/* ── Onion link crawler status ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Globe2 className="h-4 w-4 text-cyan-300" />
                  Onion link crawler
                  {crawlerStatus && (
                    <Badge className={cn('text-[10px] border', crawlerStatus.enabled
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-muted text-muted-foreground border-border'
                    )}>
                      {crawlerStatus.enabled ? 'auto' : 'off'}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Extracts <code className="font-mono">.onion</code> URLs from fetched pages, follows them (max depth 2, max 5 per page),
                  stores each as linked intel with <code className="font-mono">onion_crossref</code> relationship, enriches + recurses.
                  Already-ingested URLs are skipped. Links are visible in the Network graph.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    const next = !(crawlerStatus?.enabled ?? true)
                    try { await invoke('darkweb:crawler_toggle', { enabled: next }); void loadAll() } catch {}
                  }}
                  className={cn(
                    'text-[10px] px-2 py-1 rounded border transition-colors',
                    crawlerStatus?.enabled
                      ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {crawlerStatus?.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <Button size="sm" variant="ghost" onClick={async () => {
                  try { await invoke('darkweb:crawler_reset_visited'); toast.success('Visited set reset') } catch {}
                }} title="Reset visited-URL dedup (allows re-crawl of already-visited pages)">
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </CardHeader>
          {crawlerStatus && (crawlerStatus.totalCrawled > 0 || crawlerStatus.queued > 0 || crawlerStatus.inFlight > 0) && (
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
                {[
                  { label: 'Crawled', value: crawlerStatus.totalCrawled, color: 'text-emerald-300' },
                  { label: 'Discovered', value: crawlerStatus.totalDiscovered, color: 'text-cyan-300' },
                  { label: 'Deduped', value: crawlerStatus.totalSkippedDedup, color: 'text-muted-foreground' },
                  { label: 'Failed', value: crawlerStatus.totalFailed, color: 'text-red-300' },
                  { label: 'Queue', value: crawlerStatus.queued + crawlerStatus.inFlight, color: 'text-amber-300' }
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded border border-border p-2">
                    <div className={cn('text-lg font-semibold', color)}>{value}</div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
                  </div>
                ))}
              </div>
              {(crawlerStatus.queued > 0 || crawlerStatus.inFlight > 0) && (
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Crawling: {crawlerStatus.inFlight} in flight, {crawlerStatus.queued} queued</span>
                </div>
              )}
            </CardContent>
          )}
        </Card>

        {/* ── Quarantined hosts section ── */}
        {quarantinedHosts.length > 0 && (
          <Card>
            <CardHeader>
              <button onClick={() => setShowQuarantined(!showQuarantined)} className="w-full flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Ban className="h-4 w-4 text-amber-300" />
                  Quarantined onion hosts
                  <Badge variant="outline" className="text-[10px]">{quarantinedHosts.length}</Badge>
                </CardTitle>
                {showQuarantined ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              <CardDescription className="text-xs">
                Hosts with ≥5 consecutive fetch failures are quarantined and skipped from sweeps. Click "Restore" to re-enable.
              </CardDescription>
            </CardHeader>
            {showQuarantined && (
              <CardContent className="space-y-1">
                {quarantinedHosts.map((h) => (
                  <div key={h.hostname} className="flex items-center gap-2 p-2 rounded border border-border/40 bg-card/30">
                    <Globe2 className="h-3 w-3 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono truncate">{h.hostname}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {h.totalFailures} failures · {h.totalSuccesses} successes · last error: {h.lastError?.slice(0, 60) || 'unknown'}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => onUnquarantine(h.hostname)}>
                      <RefreshCw className="h-3 w-3 mr-1" /> Restore
                    </Button>
                  </div>
                ))}
              </CardContent>
            )}
          </Card>
        )}
      </div>

      {/* Add custom seed modal */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Plus className="h-4 w-4" /> Add custom seed</DialogTitle>
            <DialogDescription className="text-xs">
              Add a custom dark-web search query. Categories can be free-text — type a new one to create it.
              CSAM-related queries are automatically rejected by the safety policy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Category</label>
              <Input
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                list="dw-categories"
                placeholder="e.g. cybercrime, theatre-syria, ransomware-actors…"
                className="text-sm font-mono"
              />
              <datalist id="dw-categories">
                {allCategories.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label className="text-xs font-medium">Query</label>
              <Input value={newQuery} onChange={(e) => setNewQuery(e.target.value)} placeholder="e.g. 'wagner mercenary recruitment'" className="text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Description (optional)</label>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What you're monitoring with this seed" className="text-sm" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={onAddSeedSubmit} disabled={!newCat.trim() || !newQuery.trim()}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add seed
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ListChecksIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" />
    </svg>
  )
}
