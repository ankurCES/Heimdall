import { useEffect, useState, useCallback } from 'react'
import { Eye, Plus, RefreshCw, Trash2, ChevronDown, ChevronRight, Loader2, AlertOctagon, Sparkles } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@renderer/components/ui/dialog'
import { ClassificationBadge, CLASSIFICATION_LEVELS, type Classification } from '@renderer/components/ClassificationBanner'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'

/**
 * I&W Workbench (Themes 5.1 + 5.2 of the agency roadmap).
 *
 * Define high-impact events the analyst is watching for. For each event,
 * tag observable indicators with R/A/G thresholds. Continuously evaluate
 * indicators against current intel data; alert when thresholds cross.
 */

type Level = 'red' | 'amber' | 'green'

interface IwIndicator {
  id: string
  event_id: string
  name: string
  description: string | null
  query_type: 'intel_count' | 'entity_count'
  query_params: Record<string, unknown>
  red_threshold: number | null
  amber_threshold: number | null
  weight: number
  current_value: number | null
  current_level: Level | null
  last_evaluated_at: number | null
  status: 'active' | 'paused'
}

interface IwEvent {
  id: string
  name: string
  description: string | null
  scenario_class: string | null
  classification: Classification
  status: 'active' | 'closed'
  created_at: number
  level?: Level
  indicators?: IwIndicator[]
}

const LEVEL_PILL: Record<Level, string> = {
  red: 'bg-red-500/20 text-red-300 border-red-500/40',
  amber: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  green: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
}

const LEVEL_DOT: Record<Level, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500'
}

export function IwPage() {
  const [events, setEvents] = useState<IwEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.heimdall.invoke('iw:events:list') as IwEvent[]
      setEvents(result || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const evaluateAll = async () => {
    setEvaluating(true)
    try {
      await window.heimdall.invoke('iw:evaluate:all')
      await load()
    } finally {
      setEvaluating(false)
    }
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const totals = {
    events: events.length,
    red: events.filter((e) => e.level === 'red').length,
    amber: events.filter((e) => e.level === 'amber').length,
    green: events.filter((e) => e.level === 'green').length,
    indicators: events.reduce((sum, e) => sum + (e.indicators?.length || 0), 0)
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Eye className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-bold">Indicators & Warnings</h1>
          <span className="text-xs text-muted-foreground">
            ({totals.events} events · {totals.indicators} indicators)
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('px-2 py-0.5 rounded text-xs font-mono border', LEVEL_PILL.red)}>{totals.red} red</span>
          <span className={cn('px-2 py-0.5 rounded text-xs font-mono border', LEVEL_PILL.amber)}>{totals.amber} amber</span>
          <span className={cn('px-2 py-0.5 rounded text-xs font-mono border', LEVEL_PILL.green)}>{totals.green} green</span>
          <Button size="sm" variant="outline" onClick={evaluateAll} disabled={evaluating || loading}>
            {evaluating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Evaluate All
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />New Event
          </Button>
        </div>
      </div>

      {events.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Eye className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm mb-2">No I&W events defined yet.</p>
            <p className="text-xs">Click <strong>New Event</strong> to start tracking a high-impact scenario (conflict, escalation, intrusion campaign).</p>
          </CardContent>
        </Card>
      ) : (
        events.map((ev) => (
          <EventCard
            key={ev.id}
            event={ev}
            expanded={expanded.has(ev.id)}
            onToggle={() => toggleExpand(ev.id)}
            onChanged={load}
          />
        ))
      )}

      <CreateEventDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { void load(); setCreateOpen(false) }}
      />
    </div>
  )
}

function EventCard({ event, expanded, onToggle, onChanged }: { event: IwEvent; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const [addOpen, setAddOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const lvl = event.level || 'green'
  const indicators = event.indicators || []

  const evaluate = async () => {
    await window.heimdall.invoke('iw:evaluate:event', { id: event.id })
    onChanged()
  }

  const remove = async () => {
    if (!confirm(`Delete event "${event.name}" and all its indicators?`)) return
    await window.heimdall.invoke('iw:events:delete', { id: event.id })
    onChanged()
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <button onClick={onToggle} className="text-muted-foreground hover:text-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <span className={cn('h-3 w-3 rounded-full', LEVEL_DOT[lvl])} aria-label={`Level: ${lvl}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{event.name}</CardTitle>
              <ClassificationBadge level={event.classification} />
              {event.scenario_class && <span className="text-[10px] text-muted-foreground/70 font-mono uppercase">{event.scenario_class}</span>}
            </div>
            {event.description && <CardDescription className="text-xs mt-0.5">{event.description}</CardDescription>}
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={evaluate} title="Re-evaluate every indicator">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSuggestOpen(true)} title="AI-suggest indicators">
              <Sparkles className="h-3.5 w-3.5 mr-1" />Suggest
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />Indicator
            </Button>
            <Button size="sm" variant="ghost" onClick={remove} className="text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent>
          {indicators.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No indicators yet — click <strong>+ Indicator</strong> to add one.</p>
          ) : (
            <div className="space-y-2">
              {indicators.map((ind) => <IndicatorRow key={ind.id} indicator={ind} onChanged={onChanged} />)}
            </div>
          )}
        </CardContent>
      )}
      <AddIndicatorDialog
        open={addOpen}
        eventId={event.id}
        onClose={() => setAddOpen(false)}
        onAdded={() => { onChanged(); setAddOpen(false) }}
      />
      <SuggestIndicatorsDialog
        open={suggestOpen}
        event={event}
        onClose={() => setSuggestOpen(false)}
        onAdded={onChanged}
      />
    </Card>
  )
}

function IndicatorRow({ indicator, onChanged }: { indicator: IwIndicator; onChanged: () => void }) {
  const lvl: Level = indicator.current_level || 'green'
  const evaluate = async () => {
    await window.heimdall.invoke('iw:evaluate:indicator', { id: indicator.id })
    onChanged()
  }
  const remove = async () => {
    if (!confirm(`Delete indicator "${indicator.name}"?`)) return
    await window.heimdall.invoke('iw:indicators:delete', { id: indicator.id })
    onChanged()
  }
  return (
    <div className="border border-border/50 rounded p-2.5 text-xs hover:bg-accent/30">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn('h-2 w-2 rounded-full shrink-0', LEVEL_DOT[lvl])} />
        <span className="font-medium">{indicator.name}</span>
        <span className={cn('px-1.5 py-0 rounded text-[10px] font-mono border', LEVEL_PILL[lvl])}>{lvl}</span>
        <span className="text-muted-foreground font-mono">value: {indicator.current_value ?? '—'}</span>
        <span className="text-muted-foreground/70 text-[10px]">
          (amber ≥ {indicator.amber_threshold ?? '?'} / red ≥ {indicator.red_threshold ?? '?'})
        </span>
        <span className="ml-auto text-muted-foreground/70 text-[10px]">
          {indicator.last_evaluated_at ? formatRelativeTime(indicator.last_evaluated_at) : 'unevaluated'}
        </span>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={evaluate} title="Re-evaluate">
          <RefreshCw className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive" onClick={remove}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      {indicator.description && (
        <p className="mt-1 text-muted-foreground/80 text-[11px] pl-4">{indicator.description}</p>
      )}
      <p className="mt-1 text-muted-foreground/60 text-[10px] font-mono pl-4">
        {indicator.query_type} {JSON.stringify(indicator.query_params).slice(0, 120)}
      </p>
    </div>
  )
}

function CreateEventDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [classification, setClassification] = useState<Classification>('UNCLASSIFIED')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) { setName(''); setDescription(''); setClassification('UNCLASSIFIED') }
  }, [open])

  const submit = async () => {
    if (!name.trim()) return
    setSubmitting(true)
    try {
      await window.heimdall.invoke('iw:events:create', { name: name.trim(), description: description.trim() || undefined, classification })
      onCreated()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertOctagon className="h-4 w-4" />New I&W Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Event Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Conflict in Taiwan Strait"' />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What scenario are you watching for?" />
          </div>
          <div>
            <Label>Classification</Label>
            <Select value={classification} onValueChange={(v) => setClassification(v as Classification)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CLASSIFICATION_LEVELS.map((lvl) => <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddIndicatorDialog({ open, eventId, onClose, onAdded }: { open: boolean; eventId: string; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [discipline, setDiscipline] = useState<string>('any')
  const [windowHours, setWindowHours] = useState(24)
  const [redThreshold, setRedThreshold] = useState(10)
  const [amberThreshold, setAmberThreshold] = useState(3)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setName(''); setKeywords(''); setDiscipline('any'); setWindowHours(24); setRedThreshold(10); setAmberThreshold(3)
    }
  }, [open])

  const submit = async () => {
    if (!name.trim()) return
    setSubmitting(true)
    try {
      await window.heimdall.invoke('iw:indicators:add', {
        event_id: eventId,
        name: name.trim(),
        query_type: 'intel_count',
        query_params: {
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          discipline: discipline === 'any' ? undefined : discipline,
          window_hours: windowHours
        },
        red_threshold: redThreshold,
        amber_threshold: amberThreshold
      })
      onAdded()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Indicator</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Indicator Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "PLA amphibious exercises"' />
          </div>
          <div>
            <Label>Keywords (comma-separated)</Label>
            <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="amphibious, PLA, exercise" />
            <p className="text-[10px] text-muted-foreground mt-1">Counts intel reports whose title or content matches any keyword.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Discipline (optional)</Label>
              <Select value={discipline} onValueChange={setDiscipline}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {['osint', 'cybint', 'finint', 'socmint', 'geoint', 'sigint', 'rumint', 'ci', 'agency', 'imint'].map((d) => (
                    <SelectItem key={d} value={d}>{d.toUpperCase()}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Window (hours)</Label>
              <Input type="number" value={windowHours} onChange={(e) => setWindowHours(parseInt(e.target.value, 10) || 24)} min={1} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Amber threshold (≥)</Label>
              <Input type="number" value={amberThreshold} onChange={(e) => setAmberThreshold(parseInt(e.target.value, 10) || 0)} min={0} />
            </div>
            <div>
              <Label>Red threshold (≥)</Label>
              <Input type="number" value={redThreshold} onChange={(e) => setRedThreshold(parseInt(e.target.value, 10) || 0)} min={0} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            Add Indicator
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface Suggestion {
  name: string
  description: string
  query_type: 'intel_count' | 'entity_count'
  rationale: string
}

/**
 * Cross-cutting I — AI-suggested I&W indicators.
 *
 * Opens on "Suggest" button click; calls the LLM via iw:suggest_indicators
 * and renders 6-10 indicator proposals. Each row has a one-click "Add"
 * that seeds an intel_count indicator with sensible defaults the analyst
 * can tweak later.
 */
function SuggestIndicatorsDialog({ open, event, onClose, onAdded }: { open: boolean; event: IwEvent; onClose: () => void; onAdded: () => void }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [addedIdx, setAddedIdx] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    setSuggestions([]); setAddedIdx(new Set()); setError(null)
    void (async () => {
      setLoading(true)
      try {
        const rows = await window.heimdall.invoke('iw:suggest_indicators', {
          name: event.name,
          description: event.description,
          scenario_class: event.scenario_class
        }) as Suggestion[]
        setSuggestions(rows)
      } catch (err) {
        setError(String(err).replace(/^Error:\s*/, ''))
      } finally {
        setLoading(false)
      }
    })()
  }, [open, event.name, event.description, event.scenario_class])

  const add = async (idx: number) => {
    const s = suggestions[idx]
    const kw = s.name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4).slice(0, 3)
    try {
      await window.heimdall.invoke('iw:indicators:add', {
        event_id: event.id,
        name: s.name,
        description: s.description,
        query_type: s.query_type,
        query_params: { keywords: kw, window_hours: 168 },
        red_threshold: 10,
        amber_threshold: 3
      })
      setAddedIdx((prev) => new Set(prev).add(idx))
      onAdded()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />AI-suggested indicators
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto space-y-2 pr-1">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Asking the model for indicators anchored in academic / historical precedent…
            </div>
          )}
          {error && (
            <div className="text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
          )}
          {!loading && !error && suggestions.length === 0 && (
            <p className="text-xs text-muted-foreground italic p-4">No suggestions returned. The model may be unreachable — configure an LLM connection in Settings.</p>
          )}
          {suggestions.map((s, i) => (
            <div key={i} className="p-3 rounded border border-border bg-card/30">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{s.description}</div>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="text-[9px] font-mono uppercase tracking-wider bg-muted px-1.5 py-0.5 rounded">{s.query_type}</span>
                    <span className="text-[10px] text-muted-foreground italic">{s.rationale}</span>
                  </div>
                </div>
                {addedIdx.has(i) ? (
                  <span className="text-xs text-emerald-400 shrink-0">Added</span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void add(i)}>
                    <Plus className="h-3 w-3 mr-1" />Add
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
