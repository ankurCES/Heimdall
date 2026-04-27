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
import { Search, FileText, Mic, X as XIcon, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

interface SearchHit {
  kind: 'intel' | 'transcript'
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
  const [filter, setFilter] = useState<'all' | 'intel' | 'transcript'>('all')
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

  // Auto-focus input on open.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      // Reset state when closed so re-opening starts fresh
      setQuery('')
      setHits([])
      setHighlight(0)
    }
  }, [open])

  const runSearch = useCallback(async (q: string, kindFilter: 'all' | 'intel' | 'transcript') => {
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
    if (hit.kind === 'intel') {
      navigate(`/library?report=${encodeURIComponent(hit.id)}`)
    } else {
      // Transcripts page picks the row up by id via its list refresh +
      // sessionStorage hint we set here.
      sessionStorage.setItem('transcripts:focusId', hit.id)
      navigate('/transcripts')
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
          {(['all', 'intel', 'transcript'] as const).map((k) => (
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
              {k === 'all' ? 'All' : k === 'intel' ? 'Intel reports' : 'Transcripts'}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {hits.length > 0 ? `${hits.length} hit${hits.length > 1 ? 's' : ''}` : query.trim() ? 'no matches' : ''}
          </span>
        </div>

        <div className="flex-1 overflow-auto py-1">
          {hits.length === 0 && !loading && query.trim() && (
            <div className="text-sm text-muted-foreground px-4 py-6 text-center">
              No matches. Try a phrase ("cyber attack"), prefix (terror*), or column filter (title:bombing).
            </div>
          )}
          {hits.length === 0 && !query.trim() && (
            <div className="text-xs text-muted-foreground px-4 py-6 text-center space-y-1">
              <div>Search every intel report and transcript across Heimdall.</div>
              <div className="font-mono">↑↓ navigate · Enter open · Esc close · ⌘K toggle</div>
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
                {hit.kind === 'intel' ? (
                  <FileText className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                ) : (
                  <Mic className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                )}
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
                  <span>{hit.kind === 'intel' ? hit.meta.sourceName ?? 'unknown' : hit.meta.engine ?? '—'}</span>
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
