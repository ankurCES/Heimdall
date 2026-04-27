// EntityTimelinePage — v1.7.0 cross-corpus timeline for one canonical entity.
//
// Phase 8 opens here. Existing analyst tradecraft for "what do we know
// about this entity?" requires walking five different list views.
// This page collapses that into one chronological narrative: every
// mention of the entity (and its aliases) across intel reports,
// transcripts, HUMINT sessions, documents, briefings, and images.
//
// Surface:
//   - Header card: canonical name, type, summary counts (mentions
//     per corpus + first/last seen).
//   - Filter chips per corpus to narrow the timeline.
//   - Vertical timeline rendered in newest-first order; events grouped
//     by day; each card carries kind icon + title + snippet (with
//     <mark> highlighting from FTS5) + a click-through to the source.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  Clock, FileText, Mic, Users, FileScan, ScrollText, Image as ImageIcon,
  ArrowLeft, Loader2, AlertCircle, GitMerge
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'

type Kind = 'intel' | 'transcript' | 'humint' | 'document' | 'briefing' | 'image'

interface TimelineEvent {
  kind: Kind
  ts: number
  id: string
  title: string
  snippet: string
  meta: {
    discipline?: string
    severity?: string
    sourceName?: string
    classification?: string
    sessionId?: string | null
    duration_ms?: number | null
    language?: string | null
  }
}

interface TimelineSummary {
  canonical_value: string
  entity_type: string | null
  alias_count: number
  mention_count: number
  first_seen: number | null
  last_seen: number | null
  by_kind: Record<Kind, number>
}

interface Timeline {
  summary: TimelineSummary
  events: TimelineEvent[]
}

const KIND_META: Record<Kind, { label: string; icon: typeof FileText; color: string }> = {
  intel:      { label: 'Intel',       icon: FileText,    color: 'text-blue-600 dark:text-blue-400' },
  transcript: { label: 'Transcript',  icon: Mic,         color: 'text-emerald-600 dark:text-emerald-400' },
  humint:     { label: 'HUMINT',      icon: Users,       color: 'text-purple-600 dark:text-purple-400' },
  document:   { label: 'Document',    icon: FileScan,    color: 'text-orange-600 dark:text-orange-400' },
  briefing:   { label: 'Briefing',    icon: ScrollText,  color: 'text-cyan-600 dark:text-cyan-400' },
  image:      { label: 'Image',       icon: ImageIcon,   color: 'text-pink-600 dark:text-pink-400' }
}

function fmtAbsolute(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

function navigateForEvent(navigate: ReturnType<typeof useNavigate>, ev: TimelineEvent): void {
  switch (ev.kind) {
    case 'intel':
      navigate(`/library?report=${encodeURIComponent(ev.id)}`)
      break
    case 'transcript':
      sessionStorage.setItem('transcripts:focusId', ev.id)
      navigate('/transcripts')
      break
    case 'humint':
      navigate(`/chat?session=${encodeURIComponent(ev.meta.sessionId ?? '')}`)
      break
    case 'document':
      navigate('/quarantine')
      break
    case 'briefing':
      sessionStorage.setItem('briefings:focusId', ev.id)
      navigate('/briefings')
      break
    case 'image':
      sessionStorage.setItem('images:focusId', ev.id)
      navigate('/images')
      break
  }
}

export function EntityTimelinePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeKinds, setActiveKinds] = useState<Set<Kind>>(new Set(['intel', 'transcript', 'humint', 'document', 'briefing', 'image']))

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    void (async () => {
      try {
        const r = await window.heimdall.invoke('entity:timeline', { id, limitPerCorpus: 50 }) as Timeline | null
        if (!r) setError('Entity not found.')
        else setTimeline(r)
      } catch (err) {
        setError(String(err).replace(/^Error:\s*/, ''))
      } finally { setLoading(false) }
    })()
  }, [id])

  const visibleEvents = useMemo(() => {
    if (!timeline) return []
    return timeline.events.filter((e) => activeKinds.has(e.kind))
  }, [timeline, activeKinds])

  const grouped = useMemo(() => {
    const buckets = new Map<string, TimelineEvent[]>()
    for (const ev of visibleEvents) {
      const day = fmtDay(ev.ts)
      const arr = buckets.get(day) ?? []
      arr.push(ev)
      buckets.set(day, arr)
    }
    return Array.from(buckets.entries())
  }, [visibleEvents])

  const toggleKind = (k: Kind) => {
    setActiveKinds((cur) => {
      const next = new Set(cur)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  if (!id) return <div className="p-6 text-sm text-muted-foreground">Missing entity id in URL.</div>

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="ghost" onClick={() => navigate(-1)} className="h-8">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
          </Button>
          <GitMerge className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold truncate">{timeline?.summary.canonical_value ?? id}</h1>
          <Badge variant="outline" className="text-[10px] ml-2">v1.7.0</Badge>
          {timeline?.summary.entity_type && (
            <Badge className="text-[10px] uppercase">{timeline.summary.entity_type}</Badge>
          )}
        </div>
        {timeline && (
          <div className="grid grid-cols-6 gap-2 text-xs">
            {(Object.keys(KIND_META) as Kind[]).map((k) => {
              const m = KIND_META[k]
              const Icon = m.icon
              const count = timeline.summary.by_kind[k]
              const active = activeKinds.has(k)
              return (
                <button
                  key={k}
                  onClick={() => toggleKind(k)}
                  className={cn(
                    'border rounded-md p-2 text-left transition-colors',
                    active
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border bg-muted/20 opacity-60 hover:opacity-100'
                  )}
                >
                  <div className={cn('flex items-center gap-1.5 text-[11px]', m.color)}>
                    <Icon className="h-3.5 w-3.5" />
                    {m.label}
                  </div>
                  <div className="text-base font-semibold mt-0.5">{count}</div>
                </button>
              )
            })}
          </div>
        )}
        {timeline && (
          <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" />
              {timeline.summary.first_seen ? fmtAbsolute(timeline.summary.first_seen) : '—'}
              {' → '}
              {timeline.summary.last_seen ? fmtAbsolute(timeline.summary.last_seen) : '—'}
            </span>
            <span>· {timeline.summary.alias_count} alias{timeline.summary.alias_count !== 1 ? 'es' : ''}</span>
            <span>· {visibleEvents.length} of {timeline.events.length} mention{timeline.events.length !== 1 ? 's' : ''} shown</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Building timeline…
          </div>
        )}
        {error && (
          <div className="border border-red-500/30 bg-red-500/5 rounded-md p-3 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {!loading && !error && timeline && visibleEvents.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No mentions match the selected corpus filters.
          </div>
        )}
        {!loading && !error && grouped.length > 0 && (
          <div className="relative">
            {/* Vertical rail */}
            <div className="absolute left-[6px] top-0 bottom-0 w-0.5 bg-border" />
            <div className="space-y-6">
              {grouped.map(([day, events]) => (
                <div key={day}>
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-3.5 w-3.5 rounded-full bg-primary border-2 border-background z-10" />
                    <div className="text-sm font-medium">{day}</div>
                    <div className="text-[11px] text-muted-foreground">{events.length} mention{events.length !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="space-y-2 pl-7">
                    {events.map((ev, i) => {
                      const m = KIND_META[ev.kind]
                      const Icon = m.icon
                      return (
                        <button
                          key={`${ev.kind}-${ev.id}-${i}`}
                          onClick={() => navigateForEvent(navigate, ev)}
                          className="w-full text-left border border-border rounded-md p-3 hover:bg-accent/50 transition-colors"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon className={cn('h-3.5 w-3.5 shrink-0', m.color)} />
                            <span className="text-sm font-medium truncate">{ev.title}</span>
                            {ev.meta.severity && (
                              <Badge variant="outline" className="text-[10px] uppercase">{ev.meta.severity}</Badge>
                            )}
                            {ev.meta.discipline && (
                              <Badge variant="outline" className="text-[10px] uppercase">{ev.meta.discipline}</Badge>
                            )}
                            {ev.meta.classification && (
                              <Badge variant="outline" className="text-[10px]">{ev.meta.classification}</Badge>
                            )}
                            <span className="text-[11px] text-muted-foreground ml-auto shrink-0">
                              {fmtAbsolute(ev.ts)}
                            </span>
                          </div>
                          {ev.snippet && (
                            <div
                              className="text-xs text-muted-foreground mt-1.5 line-clamp-3 [&>mark]:bg-amber-500/30 [&>mark]:text-foreground [&>mark]:rounded [&>mark]:px-0.5"
                              dangerouslySetInnerHTML={{ __html: ev.snippet }}
                            />
                          )}
                          <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
                            {ev.meta.sourceName && <span>{ev.meta.sourceName}</span>}
                            {ev.meta.language && <span>· {ev.meta.language}</span>}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 text-[11px] text-muted-foreground text-center">
          Cross-corpus timeline assembled from {timeline?.summary.mention_count ?? '—'} canonical mentions across 6 corpora.
          {' '}<Link to="/entities" className="text-primary hover:underline">Browse all entities</Link>
        </div>
      </div>
    </div>
  )
}
