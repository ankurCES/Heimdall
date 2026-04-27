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
  ArrowLeft, Loader2, AlertCircle, GitMerge, Network, MapPin, List, Combine,
  Bell, BellOff
} from 'lucide-react'
import { toast } from 'sonner'
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
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

// v1.7.1 — co-mention graph anchored on this entity. Built from
// intel_entities (the only layer with explicitly-canonicalised
// links), so edges are deterministic.
interface CoMention {
  canonical_id: string
  canonical_value: string
  entity_type: string
  shared_reports: number
  co_mention_count: number
  last_co_mentioned_at: number
}
interface CoMentionGraph {
  source_canonical_id: string
  source_canonical_value: string
  source_entity_type: string
  source_report_count: number
  edges: CoMention[]
}

// v1.7.2 — geo pins for the map overlay.
type GeoPinKind = 'intel' | 'image'
interface GeoPin {
  kind: GeoPinKind
  id: string
  title: string
  ts: number
  lat: number
  lng: number
  meta: {
    discipline?: string
    severity?: string
    sourceName?: string
    cameraMake?: string | null
    cameraModel?: string | null
  }
}
interface EntityGeoPayload {
  source_canonical_id: string
  source_canonical_value: string
  pins: GeoPin[]
  bounds: { sw: [number, number]; ne: [number, number] } | null
  by_kind: Record<GeoPinKind, number>
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
  const [coMentions, setCoMentions] = useState<CoMentionGraph | null>(null)
  const [geo, setGeo] = useState<EntityGeoPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [coMentionsLoading, setCoMentionsLoading] = useState(false)
  const [geoLoading, setGeoLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'timeline' | 'map'>('timeline')
  const [watchEnabled, setWatchEnabled] = useState<boolean>(false)
  const [watchLoading, setWatchLoading] = useState<boolean>(false)
  const [activeKinds, setActiveKinds] = useState<Set<Kind>>(new Set(['intel', 'transcript', 'humint', 'document', 'briefing', 'image']))

  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    setCoMentions(null)
    void (async () => {
      try {
        const r = await window.heimdall.invoke('entity:timeline', { id, limitPerCorpus: 50 }) as Timeline | null
        if (!r) setError('Entity not found.')
        else setTimeline(r)
      } catch (err) {
        setError(String(err).replace(/^Error:\s*/, ''))
      } finally { setLoading(false) }
    })()
    // Co-mentions fetch in parallel; failure is non-fatal — timeline
    // stays usable when the link analysis call errors out.
    setCoMentionsLoading(true)
    void (async () => {
      try {
        const r = await window.heimdall.invoke('entity:co_mentions', { id, limit: 25 }) as CoMentionGraph | null
        setCoMentions(r ?? null)
      } catch { setCoMentions(null) }
      finally { setCoMentionsLoading(false) }
    })()
    setGeoLoading(true)
    setGeo(null)
    void (async () => {
      try {
        const r = await window.heimdall.invoke('entity:geo_pins', { id, limitPerCorpus: 200 }) as EntityGeoPayload | null
        setGeo(r ?? null)
      } catch { setGeo(null) }
      finally { setGeoLoading(false) }
    })()
    // v1.7.4 — load current watch state for the toggle.
    void (async () => {
      try {
        const w = await window.heimdall.invoke('entity:watch_status', id) as { alert_enabled: 0 | 1 } | null
        setWatchEnabled(!!(w && w.alert_enabled === 1))
      } catch { setWatchEnabled(false) }
    })()
  }, [id])

  const toggleWatch = async () => {
    if (!id) return
    setWatchLoading(true)
    try {
      if (watchEnabled) {
        await window.heimdall.invoke('entity:watch_remove', id)
        setWatchEnabled(false)
        toast.message('Stopped watching this entity')
      } else {
        await window.heimdall.invoke('entity:watch_add', id)
        setWatchEnabled(true)
        toast.success('Watching this entity', {
          description: 'You\'ll get a toast when new intel mentions arrive (5-min cron). First-tick existing mentions are skipped.',
          duration: 6000
        })
      }
    } catch (err) {
      toast.error('Watch toggle failed', { description: String(err).replace(/^Error:\s*/, '') })
    } finally { setWatchLoading(false) }
  }

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

  // v1.7.3 — fold this canonical entity into another. The analyst
  // pastes the target id (copyable from /entities or from the
  // Co-mentions sidebar's button-id). Confirm dialog spells out the
  // irreversible-by-default-but-audit-logged consequence.
  const mergeIntoTarget = async () => {
    if (!id || !timeline) return
    const targetId = prompt(
      `Fold "${timeline.summary.canonical_value}" into another canonical entity.\n\n` +
      `Paste the target canonical id (UUID). Every intel_entities row pointing here will be repointed at the target. ` +
      `This canonical entity will then be deleted.\n\n` +
      `Audit-logged. Reversible only by re-running the resolver and re-clustering from scratch.`
    )
    if (!targetId) return
    try {
      const r = await window.heimdall.invoke('entity:merge', {
        sourceIds: [id],
        targetId: targetId.trim()
      }) as { ok: boolean; target_canonical_id: string; reassigned_intel_entities: number }
      toast.success('Merge applied', {
        description: `${r.reassigned_intel_entities} mention${r.reassigned_intel_entities !== 1 ? 's' : ''} reassigned. Navigating to target…`,
        duration: 4000
      })
      // Navigate to the target (this canonical was deleted).
      navigate(`/entity/${encodeURIComponent(r.target_canonical_id)}`)
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      toast.error('Merge failed', { description: msg, duration: 8000 })
    }
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
          {timeline && (
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant={watchEnabled ? 'default' : 'outline'}
                onClick={toggleWatch}
                disabled={watchLoading}
                className={cn('h-8', watchEnabled && 'bg-emerald-600 hover:bg-emerald-700')}
                title={watchEnabled
                  ? 'Watching this entity — toast on new intel mentions. Click to unwatch.'
                  : 'Add to watchlist — get a toast when new intel mentions arrive (5-min cron).'}
              >
                {watchLoading ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : watchEnabled ? (
                  <Bell className="h-3.5 w-3.5 mr-1" />
                ) : (
                  <BellOff className="h-3.5 w-3.5 mr-1" />
                )}
                {watchEnabled ? 'Watching' : 'Watch'}
              </Button>
              <Button
                size="sm" variant="ghost"
                onClick={mergeIntoTarget}
                className="h-8 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                title="Fold this canonical into another (audit-logged)"
              >
                <Combine className="h-3.5 w-3.5 mr-1" /> Merge into…
              </Button>
              <button
                onClick={() => { navigator.clipboard?.writeText(id ?? ''); toast.message('Canonical id copied') }}
                className="text-[10px] text-muted-foreground hover:text-foreground font-mono px-2 py-1 rounded border border-border"
                title="Copy this canonical id (use as merge target on another entity)"
              >
                copy id
              </button>
            </div>
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
            {/* v1.7.2 — view toggle. Map button disabled when no
                geo-tagged pins exist for this entity. */}
            <div className="ml-auto flex items-center gap-1 border border-border rounded-md p-0.5">
              <button
                onClick={() => setView('timeline')}
                className={cn(
                  'text-[11px] px-2 py-0.5 rounded flex items-center gap-1',
                  view === 'timeline' ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <List className="h-3 w-3" /> Timeline
              </button>
              <button
                onClick={() => setView('map')}
                disabled={!geo || geo.pins.length === 0}
                className={cn(
                  'text-[11px] px-2 py-0.5 rounded flex items-center gap-1',
                  view === 'map' ? 'bg-primary/15 text-primary font-medium' : 'text-muted-foreground hover:text-foreground',
                  (!geo || geo.pins.length === 0) && 'opacity-50 cursor-not-allowed'
                )}
                title={!geo || geo.pins.length === 0 ? 'No geo-tagged mentions for this entity' : 'Show pins on a map'}
              >
                <MapPin className="h-3 w-3" /> Map
                {geo && geo.pins.length > 0 && (
                  <span className="ml-0.5 text-[10px] font-mono">{geo.pins.length}</span>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
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

        {/* v1.7.2 — map view. Renders only when toggled on AND we
            have pins; the toggle button is disabled otherwise. */}
        {view === 'map' && geo && geo.pins.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
                <FileText className="h-3 w-3" /> {geo.by_kind.intel} intel
              </span>
              <span className="flex items-center gap-1 text-pink-600 dark:text-pink-400">
                <ImageIcon className="h-3 w-3" /> {geo.by_kind.image} images
              </span>
              <span>· {geo.pins.length} geo-tagged mention{geo.pins.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="h-[60vh] rounded-md overflow-hidden border border-border">
              <MapContainer
                bounds={geo.bounds ? [geo.bounds.sw, geo.bounds.ne] : undefined}
                center={geo.bounds ? undefined : [geo.pins[0].lat, geo.pins[0].lng]}
                zoom={geo.bounds ? undefined : 4}
                boundsOptions={{ padding: [40, 40] }}
                scrollWheelZoom={true}
                style={{ height: '100%', width: '100%', background: '#0a0a0a' }}
                attributionControl={true}
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                  url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                  subdomains="abcd"
                />
                {geo.pins.map((p, i) => (
                  <CircleMarker
                    key={`${p.kind}-${p.id}-${i}`}
                    center={[p.lat, p.lng]}
                    radius={p.kind === 'intel' ? 7 : 5}
                    pathOptions={{
                      color: p.kind === 'intel' ? '#3b82f6' : '#ec4899',
                      fillColor: p.kind === 'intel' ? '#3b82f6' : '#ec4899',
                      fillOpacity: 0.7,
                      weight: 2
                    }}
                    eventHandlers={{
                      click: () => {
                        if (p.kind === 'intel') navigate(`/library?report=${encodeURIComponent(p.id)}`)
                        else { sessionStorage.setItem('images:focusId', p.id); navigate('/images') }
                      }
                    }}
                  >
                    <Popup>
                      <div className="text-xs space-y-1">
                        <div className="font-medium">{p.title}</div>
                        <div className="text-muted-foreground">{fmtAbsolute(p.ts)}</div>
                        {p.meta.severity && <div>Severity: {p.meta.severity}</div>}
                        {p.meta.discipline && <div>Discipline: {p.meta.discipline}</div>}
                        {p.meta.cameraMake && <div>{p.meta.cameraMake} {p.meta.cameraModel ?? ''}</div>}
                        <div className="font-mono text-[10px]">{p.lat.toFixed(4)}, {p.lng.toFixed(4)}</div>
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}
              </MapContainer>
            </div>
          </div>
        )}

        {view === 'map' && (geoLoading || !geo || geo.pins.length === 0) && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            {geoLoading ? 'Computing geo pins…' : 'No geo-tagged mentions for this entity yet.'}
          </div>
        )}

        {view === 'timeline' && !loading && !error && timeline && visibleEvents.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No mentions match the selected corpus filters.
          </div>
        )}
        {view === 'timeline' && !loading && !error && grouped.length > 0 && (
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

        {/* v1.7.1 — Co-mention link analysis sidebar. Click any row to
            navigate to that entity's own timeline (recursive
            exploration across the entity graph). */}
        <aside className="w-72 border-l border-border overflow-auto p-4 space-y-3 bg-muted/10">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Co-mentions</h2>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Other canonical entities that share at least one intel report with this one. Click to pivot.
          </p>
          {coMentionsLoading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          )}
          {!coMentionsLoading && coMentions && coMentions.edges.length === 0 && (
            <div className="text-xs text-muted-foreground italic">
              No co-mentions yet. Run the entity resolver (Entities → Resolve) so canonical links exist, or wait for more reports.
            </div>
          )}
          {!coMentionsLoading && coMentions && coMentions.edges.length > 0 && (
            <>
              <div className="text-[11px] text-muted-foreground border-b border-border pb-2">
                {coMentions.edges.length} of top-25 partners across <strong className="text-foreground">{coMentions.source_report_count}</strong> shared report{coMentions.source_report_count !== 1 ? 's' : ''}
              </div>
              <ul className="space-y-1">
                {coMentions.edges.map((edge) => {
                  // Pixel-bar width relative to the strongest partner —
                  // gives the analyst a quick visual ranking.
                  const top = coMentions.edges[0]?.shared_reports || 1
                  const pct = Math.max(8, Math.round((edge.shared_reports / top) * 100))
                  return (
                    <li key={edge.canonical_id}>
                      <button
                        onClick={() => navigate(`/entity/${encodeURIComponent(edge.canonical_id)}`)}
                        className="w-full text-left rounded-md p-2 hover:bg-accent/50 transition-colors border border-transparent hover:border-border"
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[9px] uppercase shrink-0 font-mono">{edge.entity_type}</Badge>
                          <span className="text-xs font-medium truncate flex-1">{edge.canonical_value}</span>
                          <span className="text-[11px] font-mono text-muted-foreground shrink-0">{edge.shared_reports}</span>
                        </div>
                        <div className="mt-1.5 h-1 w-full bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-primary/70" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {edge.co_mention_count} mention{edge.co_mention_count !== 1 ? 's' : ''} ·
                          last seen {new Date(edge.last_co_mentioned_at).toLocaleDateString()}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
