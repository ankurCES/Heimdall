// UniversalSearchOverlay — v1.5.1 Cmd-K spotlight for the analyst.
//
// Hits search:universal across intel_reports + transcripts FTS5.
// Mounts once in Layout, toggled by Cmd/Ctrl+K. Debounced 200ms so
// fast typing doesn't flood the main process. Up/Down navigate
// hits; Enter opens the relevant page; Esc closes.
//
// Result rows are kind-aware: intel hits link to /library?report=<id>,
// transcript hits link to /transcripts (and the page picks the row
// up via its own list refresh — we set sessionStorage hint).

import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, FileText, Mic, X as XIcon, Loader2, Star, Bookmark, Play, Trash2, Bell, BellOff, Users, FileScan, Image as ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'

type Kind = 'intel' | 'transcript' | 'humint' | 'document' | 'image'

interface SearchHit {
  kind: Kind
  id: string
  title: string
  snippet: string
  score: number
  matchedColumn: string
  meta: {
    discipline?: string
    severity?: string
    sourceName?: string
    duration_ms?: number | null
    language?: string | null
    engine?: string | null
    reportId?: string | null
    sessionId?: string | null
    pageCount?: number | null
    cameraMake?: string | null
    cameraModel?: string | null
  }
  createdAt: number
}

const DEBOUNCE_MS = 200

function formatRelativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString()
}

export function UniversalSearchOverlay() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [filter, setFilter] = useState<'all' | Kind>('all')
  const [saved, setSaved] = useState<Array<{ id: string; name: string; query: string; kinds_filter: string | null; last_hit_count: number; alert_enabled: 0 | 1 }>>([])
  const [showSaved, setShowSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const navigate = useNavigate()
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Global Cmd/Ctrl+K listener — install once, regardless of open state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((cur) => !cur)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // v1.5.3 — surface saved-search alerts as toasts. Each new hit gets
  // its own toast with a deep-link action so the analyst can jump
  // straight to the report without re-running the query.
  useEffect(() => {
    const off = window.heimdall.on('search:alert_hit', (...args: unknown[]) => {
      const a = args[0] as {
        saved_search_name: string
        hit_kind: Kind
        hit_id: string
        hit_title: string
      } | undefined
      if (!a) return
      const kindLabel = a.hit_kind === 'transcript' ? 'Transcript'
        : a.hit_kind === 'humint' ? 'HUMINT'
        : a.hit_kind === 'document' ? 'Document'
        : a.hit_kind === 'image' ? 'Image'
        : 'Intel'
      toast.message(`🔔 ${a.saved_search_name}: new hit`, {
        description: `${kindLabel} — ${a.hit_title}`,
        duration: 8000,
        action: {
          label: 'Open',
          onClick: () => {
            switch (a.hit_kind) {
              case 'intel':
                navigate(`/library?report=${encodeURIComponent(a.hit_id)}`)
                break
              case 'transcript':
                sessionStorage.setItem('transcripts:focusId', a.hit_id)
                navigate('/transcripts')
                break
              case 'image':
                sessionStorage.setItem('images:focusId', a.hit_id)
                navigate('/images')
                break
              default:
                navigate('/browse')
            }
          }
        }
      })
    })
    return () => { try { off() } catch { /* */ } }
  }, [navigate])

  // Auto-focus input on open + load saved searches.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
      void loadSaved()
    } else {
      setQuery('')
      setHits([])
      setHighlight(0)
      setShowSaved(false)
    }
  }, [open])

  const loadSaved = async () => {
    try {
      const list = await window.heimdall.invoke('search:saved_list') as Array<{ id: string; name: string; query: string; kinds_filter: string | null; last_hit_count: number; alert_enabled: 0 | 1 }>
      setSaved(list)
    } catch { /* */ }
  }

  const saveCurrent = async () => {
    const q = query.trim()
    if (!q) return
    const name = prompt(`Name this saved search:`, q.slice(0, 60))
    if (!name) return
    try {
      await window.heimdall.invoke('search:saved_create', {
        name,
        query: q,
        kinds: filter === 'all' ? null : [filter]
      })
      await loadSaved()
    } catch (err) {
      console.warn('save failed:', err)
    }
  }

  const runSaved = async (id: string) => {
    try {
      const r = await window.heimdall.invoke('search:saved_run', { id, limit: 30 }) as { search: { query: string; kinds_filter: string | null }; hits: SearchHit[] }
      if (r) {
        setQuery(r.search.query)
        setFilter(r.search.kinds_filter ? (r.search.kinds_filter.split(',')[0] as Kind) : 'all')
        setHits(r.hits)
        setHighlight(0)
        setShowSaved(false)
      }
    } catch (err) { console.warn('run saved failed:', err) }
  }

  const deleteSaved = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this saved search?')) return
    try {
      await window.heimdall.invoke('search:saved_delete', id)
      await loadSaved()
    } catch { /* */ }
  }

  const toggleAlerts = async (id: string, current: 0 | 1, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await window.heimdall.invoke('search:saved_update', {
        id,
        patch: { alert_enabled: current === 1 ? 0 : 1 }
      })
      await loadSaved()
    } catch { /* */ }
  }

  const runSearch = useCallback(async (q: string, kindFilter: 'all' | Kind) => {
    if (!q.trim()) { setHits([]); setLoading(false); return }
    setLoading(true)
    try {
      const args = {
        query: q,
        limit: 30,
        kinds: kindFilter === 'all' ? undefined : [kindFilter]
      }
      const r = await window.heimdall.invoke('search:universal', args) as SearchHit[]
      setHits(r)
      setHighlight(0)
    } catch (err) {
      // FTS5 syntax errors mid-typing are common — keep silent
      console.debug('search failed:', err)
      setHits([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounce typing.
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      void runSearch(query, filter)
    }, DEBOUNCE_MS)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [query, filter, runSearch])

  const navigateToHit = useCallback((hit: SearchHit) => {
    setOpen(false)
    switch (hit.kind) {
      case 'intel':
        navigate(`/library?report=${encodeURIComponent(hit.id)}`)
        break
      case 'transcript':
        sessionStorage.setItem('transcripts:focusId', hit.id)
        navigate('/transcripts')
        break
      case 'humint':
        // HUMINT report opens via the chat session it was consolidated from.
        navigate(`/chat?session=${encodeURIComponent(hit.meta.sessionId ?? '')}`)
        break
      case 'document':
        // Documents currently surface inside their parent intel report.
        if (hit.meta.reportId) navigate(`/library?report=${encodeURIComponent(hit.meta.reportId)}`)
        else navigate('/quarantine')
        break
      case 'image':
        sessionStorage.setItem('images:focusId', hit.id)
        navigate('/images')
        break
    }
  }, [navigate])

  // Up/Down/Enter on the input row.
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(hits.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Enter' && hits[highlight]) { e.preventDefault(); navigateToHit(hits[highlight]) }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 pointer-events-none"
      onClick={() => setOpen(false)}
    >
      <div
        className="pointer-events-auto bg-card border border-border rounded-lg shadow-2xl w-full max-w-2xl flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search reports & transcripts… (FTS5 syntax: phrase queries, AND/OR/NOT, prefix*)"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
          <button
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground p-0.5"
            title="Close (Esc)"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/20">
          {(['all', 'intel', 'transcript', 'humint', 'document', 'image'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                'text-[11px] px-2 py-0.5 rounded',
                filter === k
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {k === 'all' ? 'All'
                : k === 'intel' ? 'Intel'
                : k === 'transcript' ? 'Transcripts'
                : k === 'humint' ? 'HUMINT'
                : k === 'document' ? 'Documents'
                : 'Images'}
            </button>
          ))}
          <button
            onClick={() => setShowSaved((s) => !s)}
            className={cn(
              'ml-auto text-[11px] px-2 py-0.5 rounded flex items-center gap-1',
              showSaved
                ? 'bg-primary/20 text-primary font-medium'
                : 'text-muted-foreground hover:bg-accent'
            )}
            title="Saved searches"
          >
            <Bookmark className="h-3 w-3" />
            {saved.length > 0 ? `${saved.length} saved` : 'saved'}
          </button>
          {query.trim() && hits.length > 0 && (
            <button
              onClick={saveCurrent}
              className="text-[11px] px-2 py-0.5 rounded text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 flex items-center gap-1"
              title="Save this search"
            >
              <Star className="h-3 w-3" /> Save
            </button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {hits.length > 0 ? `${hits.length} hit${hits.length > 1 ? 's' : ''}` : query.trim() ? 'no matches' : ''}
          </span>
        </div>

        <div className="flex-1 overflow-auto py-1">
          {showSaved && (
            <div className="border-b border-border">
              <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-muted/20">
                Saved searches
              </div>
              {saved.length === 0 ? (
                <div className="text-xs text-muted-foreground px-4 py-3 text-center">
                  No saved searches yet. Run a query, then click <Star className="inline h-3 w-3" /> Save.
                </div>
              ) : saved.map((s) => (
                <button
                  key={s.id}
                  onClick={() => runSaved(s.id)}
                  className="w-full text-left px-3 py-2 flex gap-2 items-center hover:bg-accent/50"
                >
                  <Bookmark className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{s.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate font-mono">
                      {s.query}{s.kinds_filter ? ` · ${s.kinds_filter}` : ''}
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {s.last_hit_count} hit{s.last_hit_count !== 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={(e) => toggleAlerts(s.id, s.alert_enabled, e)}
                    className={cn(
                      'p-0.5 shrink-0',
                      s.alert_enabled === 1
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    title={s.alert_enabled === 1 ? 'Alerts on (toasts when new hits arrive). Click to disable.' : 'Alerts off. Click to enable cron-driven alerts.'}
                  >
                    {s.alert_enabled === 1 ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                  </button>
                  <Play className="h-3 w-3 text-muted-foreground shrink-0" />
                  <button
                    onClick={(e) => deleteSaved(s.id, e)}
                    className="text-muted-foreground hover:text-red-500 p-0.5 shrink-0"
                    title="Delete saved search"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </button>
              ))}
            </div>
          )}
          {!showSaved && hits.length === 0 && !loading && query.trim() && (
            <div className="text-sm text-muted-foreground px-4 py-6 text-center">
              No matches. Try a phrase ("cyber attack"), prefix (terror*), or column filter (title:bombing).
            </div>
          )}
          {!showSaved && hits.length === 0 && !query.trim() && (
            <div className="text-xs text-muted-foreground px-4 py-6 text-center space-y-1">
              <div>Search every intel report and transcript across Heimdall.</div>
              <div className="font-mono">↑↓ navigate · Enter open · Esc close · ⌘K toggle · ★ save</div>
            </div>
          )}
          {/* v1.5.4 — handoff buttons. When the analyst wants to keep
              browsing rather than open a single hit, these seed the
              query into Browse / Feed via sessionStorage. */}
          {!showSaved && hits.length > 0 && (
            <div className="px-3 py-1.5 flex items-center gap-2 text-[11px] border-b border-border bg-muted/10">
              <span className="text-muted-foreground">Show all in:</span>
              <button
                onClick={() => {
                  sessionStorage.setItem('browse:query', query)
                  setOpen(false)
                  navigate('/browse')
                }}
                className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Browse
              </button>
              <button
                onClick={() => {
                  sessionStorage.setItem('feed:query', query)
                  setOpen(false)
                  navigate('/feed')
                }}
                className="px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Feed
              </button>
            </div>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.kind}-${hit.id}`}
              onClick={() => navigateToHit(hit)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'w-full text-left px-3 py-2 flex gap-3 items-start',
                i === highlight ? 'bg-primary/10' : 'hover:bg-accent/50'
              )}
            >
              <div className="mt-0.5 shrink-0">
                {hit.kind === 'intel' && <FileText className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />}
                {hit.kind === 'transcript' && <Mic className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />}
                {hit.kind === 'humint' && <Users className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />}
                {hit.kind === 'document' && <FileScan className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />}
                {hit.kind === 'image' && <ImageIcon className="h-3.5 w-3.5 text-pink-600 dark:text-pink-400" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium truncate">{hit.title}</span>
                  {hit.kind === 'intel' && hit.meta.discipline && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400 uppercase shrink-0">
                      {hit.meta.discipline}
                    </span>
                  )}
                  {hit.kind === 'transcript' && hit.meta.language && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                      {hit.meta.language}
                    </span>
                  )}
                </div>
                <div
                  className="text-xs text-muted-foreground mt-0.5 line-clamp-2 [&>mark]:bg-amber-500/30 [&>mark]:text-foreground [&>mark]:rounded [&>mark]:px-0.5"
                  dangerouslySetInnerHTML={{ __html: hit.snippet }}
                />
                <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
                  <span>
                    {hit.kind === 'intel' ? (hit.meta.sourceName ?? 'unknown')
                      : hit.kind === 'transcript' ? (hit.meta.engine ?? '—')
                      : hit.kind === 'humint' ? `session ${hit.meta.sessionId?.slice(0, 8) ?? '—'}`
                      : hit.kind === 'document' ? (hit.meta.pageCount ? `${hit.meta.pageCount}p` : 'document')
                      : hit.kind === 'image' ? `${hit.meta.cameraMake ?? '—'} ${hit.meta.cameraModel ?? ''}`.trim()
                      : '—'}
                  </span>
                  <span>·</span>
                  <span>{formatRelativeTime(hit.createdAt)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
