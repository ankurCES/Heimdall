// ChronologiesPage — v1.9.2 analyst-curated timeline workspace.
//
// Master/detail layout. Left rail: every chronology with event-count
// + span. Right pane: ordered event list for the selected chronology.
// The analyst can add free-form events, edit/remove, reorder via the
// up/down chevrons, and export as Markdown.
//
// Cross-surface integration: EntityTimelinePage drops events into a
// chronology via promptDialog → chronology:add_event.

import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  History, Plus, Loader2, AlertCircle, Trash2, Edit3,
  ChevronUp, ChevronDown, Download, FileText, Mic, StickyNote, ShieldOff
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { promptDialog } from '@renderer/components/PromptDialog'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

type SourceKind = 'intel' | 'transcript' | 'note'

interface ChronologyEvent {
  id: string
  ts: number
  title: string
  description?: string | null
  source_kind?: SourceKind | null
  source_id?: string | null
  tags?: string[]
}

interface Chronology {
  id: string
  name: string
  description: string | null
  created_at: number
  updated_at: number
  events: ChronologyEvent[]
  event_count: number
  span_start: number | null
  span_end: number | null
}

function fmtDate(ts: number): string {
  try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' } catch { return String(ts) }
}

function SourceIcon({ kind }: { kind?: SourceKind | null }) {
  if (kind === 'intel') return <FileText className="h-3 w-3" />
  if (kind === 'transcript') return <Mic className="h-3 w-3" />
  if (kind === 'note') return <StickyNote className="h-3 w-3" />
  return null
}

export function ChronologiesPage() {
  const [list, setList] = useState<Chronology[]>([])
  const [selected, setSelected] = useState<Chronology | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const loadList = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const rows = await window.heimdall.invoke('chronology:list') as Chronology[]
      setList(rows)
      if (selected) {
        const refreshed = rows.find((r) => r.id === selected.id) || null
        setSelected(refreshed)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selected?.id])

  useEffect(() => { loadList() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Chronology-level actions ────────────────────────────────────

  const handleNew = useCallback(async () => {
    const name = await promptDialog({
      label: 'Chronology name',
      placeholder: 'e.g. Operation Aurora — financial leg',
      validate: (v) => (v.trim().length < 3 ? 'At least 3 characters' : null)
    })
    if (!name) return
    const description = await promptDialog({
      label: 'Description (optional)',
      placeholder: 'What story does this chronology tell?',
      multiline: true
    })
    setBusy(true)
    try {
      const created = await window.heimdall.invoke('chronology:create', {
        name, description: description ?? null
      }) as Chronology
      await loadList()
      setSelected(created)
      toast.success('Chronology created')
    } catch (e) {
      toast.error('Create failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [loadList])

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this chronology and all its events?')) return
    setBusy(true)
    try {
      await window.heimdall.invoke('chronology:delete', id)
      if (selected?.id === id) setSelected(null)
      await loadList()
      toast.success('Deleted')
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected?.id, loadList])

  const handleRename = useCallback(async (c: Chronology) => {
    const name = await promptDialog({
      label: 'Rename chronology',
      initialValue: c.name,
      validate: (v) => (v.trim().length < 3 ? 'At least 3 characters' : null)
    })
    if (!name || name === c.name) return
    setBusy(true)
    try {
      await window.heimdall.invoke('chronology:update', { id: c.id, patch: { name } })
      await loadList()
    } catch (e) {
      toast.error('Rename failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [loadList])

  const handleExport = useCallback(async (c: Chronology) => {
    try {
      const md = await window.heimdall.invoke('chronology:export_markdown', c.id) as string | null
      if (!md) return
      // Drop into clipboard — easiest cross-platform export from the renderer.
      await navigator.clipboard.writeText(md)
      toast.success('Markdown copied to clipboard')
    } catch (e) {
      toast.error('Export failed: ' + (e as Error).message)
    }
  }, [])

  // ── Event-level actions ─────────────────────────────────────────

  const handleAddEvent = useCallback(async () => {
    if (!selected) return
    const title = await promptDialog({
      label: 'Event title',
      placeholder: 'e.g. Suspicious wire transfer flagged',
      validate: (v) => (v.trim().length < 3 ? 'At least 3 characters' : null)
    })
    if (!title) return
    const dateStr = await promptDialog({
      label: 'Event date/time (UTC)',
      placeholder: 'YYYY-MM-DD HH:mm  (blank = now)',
    })
    let ts = Date.now()
    if (dateStr && dateStr.trim()) {
      const parsed = Date.parse(dateStr.trim().replace(' ', 'T') + (dateStr.includes('Z') ? '' : 'Z'))
      if (Number.isFinite(parsed)) ts = parsed
      else { toast.error('Could not parse date — using now'); }
    }
    const description = await promptDialog({
      label: 'Description / annotation (optional)',
      multiline: true
    })
    setBusy(true)
    try {
      const updated = await window.heimdall.invoke('chronology:add_event', {
        id: selected.id,
        event: { ts, title, description, source_kind: 'note' }
      }) as Chronology
      setSelected(updated)
      await loadList()
    } catch (e) {
      toast.error('Add event failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, loadList])

  const handleEditEvent = useCallback(async (ev: ChronologyEvent) => {
    if (!selected) return
    const title = await promptDialog({
      label: 'Edit title',
      initialValue: ev.title,
      validate: (v) => (v.trim().length < 3 ? 'At least 3 characters' : null)
    })
    if (!title) return
    const description = await promptDialog({
      label: 'Edit description',
      initialValue: ev.description || '',
      multiline: true
    })
    setBusy(true)
    try {
      const updated = await window.heimdall.invoke('chronology:update_event', {
        id: selected.id, eventId: ev.id, patch: { title, description }
      }) as Chronology
      setSelected(updated)
      await loadList()
    } catch (e) {
      toast.error('Update failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, loadList])

  const handleRemoveEvent = useCallback(async (eventId: string) => {
    if (!selected) return
    if (!confirm('Remove this event from the chronology?')) return
    setBusy(true)
    try {
      const updated = await window.heimdall.invoke('chronology:remove_event', {
        id: selected.id, eventId
      }) as Chronology
      setSelected(updated)
      await loadList()
    } catch (e) {
      toast.error('Remove failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, loadList])

  // Re-time event so it nudges relative to neighbour. Avoid actual
  // index-based reorder by adjusting timestamps; events list is always
  // displayed sorted by ts.
  const handleNudge = useCallback(async (ev: ChronologyEvent, dir: -1 | 1) => {
    if (!selected) return
    const events = [...selected.events].sort((a, b) => a.ts - b.ts)
    const idx = events.findIndex((e) => e.id === ev.id)
    if (idx < 0) return
    const target = events[idx + dir]
    if (!target) return
    // Swap timestamps. Simple, deterministic, preserves the relative
    // order against any *other* events that fall between them only if
    // there are none — which is the common case for two adjacent rows.
    const newTs = target.ts
    const targetNewTs = ev.ts
    setBusy(true)
    try {
      const reordered = events.map((e) => {
        if (e.id === ev.id) return { ...e, ts: newTs }
        if (e.id === target.id) return { ...e, ts: targetNewTs }
        return e
      })
      const updated = await window.heimdall.invoke('chronology:replace_events', {
        id: selected.id, events: reordered
      }) as Chronology
      setSelected(updated)
      await loadList()
    } catch (e) {
      toast.error('Reorder failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, loadList])

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left rail */}
      <div className="w-80 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Chronologies</span>
          </div>
          <Button size="sm" variant="ghost" onClick={handleNew} disabled={busy} title="New chronology">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 p-3 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 mt-0.5" /> {error}
            </div>
          )}
          {!loading && !error && list.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">
              No chronologies yet. Click <Plus className="inline h-3 w-3" /> to create one,
              or use the "Add to chronology" button on entity timelines.
            </div>
          )}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c)}
              className={cn(
                'w-full text-left rounded-md p-2.5 transition-colors',
                selected?.id === c.id
                  ? 'bg-primary/10 ring-1 ring-primary/30'
                  : 'hover:bg-accent'
              )}
            >
              <div className="text-sm font-medium truncate">{c.name}</div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">{c.event_count} events</Badge>
                <span>updated {formatRelativeTime(c.updated_at)}</span>
              </div>
              {c.span_start && c.span_end && (
                <div className="mt-1 text-[10px] text-muted-foreground/80">
                  {new Date(c.span_start).toISOString().slice(0, 10)} →{' '}
                  {new Date(c.span_end).toISOString().slice(0, 10)}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex-1 overflow-y-auto">
        {!selected && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a chronology to view its events.
          </div>
        )}
        {selected && (
          <div className="p-6 max-w-4xl mx-auto">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <History className="h-5 w-5 text-primary" />
                      {selected.name}
                    </CardTitle>
                    {selected.description && (
                      <CardDescription className="mt-1">{selected.description}</CardDescription>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => handleRename(selected)} disabled={busy} title="Rename">
                      <Edit3 className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleExport(selected)} disabled={busy} title="Export Markdown to clipboard">
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={async () => {
                        try {
                          await window.heimdall.invoke('critique:create_for_parent', { parent_kind: 'chronology', parent_id: selected.id })
                          toast.success('Critique submitted', { description: 'Opening Critiques page.' })
                          navigate('/critiques')
                        } catch (err) { toast.error('Critique failed', { description: String(err).replace(/^Error:\s*/, '') }) }
                      }}
                      disabled={busy || selected.event_count === 0}
                      title="Red-team critique (LLM argues against this chronology's narrative)"
                      className="text-amber-600 dark:text-amber-400">
                      <ShieldOff className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(selected.id)} disabled={busy} title="Delete">
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-medium">Events ({selected.event_count})</div>
                  <Button size="sm" onClick={handleAddEvent} disabled={busy}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add event
                  </Button>
                </div>

                {selected.events.length === 0 && (
                  <div className="text-sm text-muted-foreground p-6 text-center border border-dashed rounded-md">
                    No events yet. Add free-form events here, or attach intel from the
                    Entity Timeline.
                  </div>
                )}

                <ol className="relative border-l-2 border-border pl-5 space-y-3">
                  {selected.events.map((ev, idx) => (
                    <li key={ev.id} className="group relative">
                      <span className="absolute -left-[26px] top-2 h-3 w-3 rounded-full bg-primary ring-2 ring-background" />
                      <div className="rounded-md border border-border bg-card p-3 hover:border-primary/40 transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{fmtDate(ev.ts)}</span>
                              {ev.source_kind && (
                                <Badge variant="outline" className="text-[10px] flex items-center gap-1">
                                  <SourceIcon kind={ev.source_kind} />
                                  {ev.source_kind}
                                </Badge>
                              )}
                            </div>
                            <div className="mt-1 text-sm font-medium">{ev.title}</div>
                            {ev.description && (
                              <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
                                {ev.description}
                              </div>
                            )}
                            {ev.source_id && (
                              <div className="mt-1 text-[10px] text-muted-foreground/70 font-mono truncate">
                                source: {ev.source_id}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button size="sm" variant="ghost" disabled={busy || idx === 0}
                                    onClick={() => handleNudge(ev, -1)} title="Move earlier">
                              <ChevronUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy || idx === selected.events.length - 1}
                                    onClick={() => handleNudge(ev, 1)} title="Move later">
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy}
                                    onClick={() => handleEditEvent(ev)} title="Edit">
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy}
                                    onClick={() => handleRemoveEvent(ev.id)} title="Remove">
                              <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
