// CritiquesPage — v1.9.3 red-team / devil's-advocate workspace.
//
// Master/detail. Left rail: every critique with its parent kind +
// label + status. Right pane: the rendered LLM critique. Analyst can
// kick off a free-form critique here, or drop in via "Run critique"
// buttons on hypothesis/comparison/chronology pages — those land as
// rows linked back to their parent (parent_kind + parent_id).
//
// Polling: while a row is in 'generating' status, we re-fetch every
// 5s so the body lands without the analyst hitting refresh.

import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShieldOff, Plus, Loader2, AlertCircle, Trash2, Sparkles,
  ListChecks, Scale, History as HistoryIcon, ScrollText, Target
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { promptDialog } from '@renderer/components/PromptDialog'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

type ParentKind = 'hypothesis' | 'comparison' | 'chronology' | 'briefing' | 'free'
type Status = 'generating' | 'ready' | 'error'

interface Critique {
  id: string
  parent_kind: ParentKind
  parent_id: string | null
  parent_label: string | null
  topic_md: string | null
  critique_md: string | null
  status: Status
  error_text: string | null
  model: string | null
  created_at: number
  updated_at: number
}

const PARENT_META: Record<ParentKind, { label: string; icon: typeof ListChecks; route: ((id: string) => string) | null }> = {
  hypothesis: { label: 'Hypothesis', icon: ListChecks,  route: () => '/hypotheses' },
  comparison: { label: 'Comparison', icon: Scale,       route: () => '/comparisons' },
  chronology: { label: 'Chronology', icon: HistoryIcon, route: () => '/chronologies' },
  briefing:   { label: 'Briefing',   icon: ScrollText,  route: () => '/briefings' },
  free:       { label: 'Free-form',  icon: Target,      route: null }
}

function StatusPill({ status }: { status: Status }) {
  if (status === 'generating') {
    return <Badge className="bg-blue-500/15 text-blue-600 dark:text-blue-400 text-[10px] flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />generating</Badge>
  }
  if (status === 'error') {
    return <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 text-[10px]">error</Badge>
  }
  return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px]">ready</Badge>
}

export function CritiquesPage() {
  const [list, setList] = useState<Critique[]>([])
  const [selected, setSelected] = useState<Critique | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const pollRef = useRef<number | null>(null)

  const loadList = useCallback(async () => {
    try {
      const rows = await window.heimdall.invoke('critique:list', { limit: 200 }) as Critique[]
      setList(rows)
      if (selected) {
        const refreshed = rows.find((r) => r.id === selected.id)
        if (refreshed) setSelected(refreshed)
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selected?.id])

  useEffect(() => { loadList() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 5s while any row is generating. Stops automatically
  // once they've all settled.
  useEffect(() => {
    const anyGenerating = list.some((c) => c.status === 'generating')
    if (anyGenerating && pollRef.current == null) {
      pollRef.current = window.setInterval(() => { void loadList() }, 5000)
    } else if (!anyGenerating && pollRef.current != null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [list, loadList])

  const handleNew = useCallback(async () => {
    const label = await promptDialog({
      label: 'Short label',
      placeholder: 'e.g. "China BRI 2026 forecast"',
      validate: (v) => v.trim().length < 3 ? 'At least 3 chars' : null
    })
    if (!label) return
    const topic = await promptDialog({
      label: 'Analytic conclusion to red-team',
      description: 'Paste the analysis the LLM should argue against. Be specific — bullet points, key judgments, or a paragraph all work.',
      multiline: true,
      validate: (v) => v.trim().length < 20 ? 'Give the red team something to chew on (20+ chars)' : null
    })
    if (!topic) return
    setBusy(true)
    try {
      const created = await window.heimdall.invoke('critique:create_freeform', {
        topic, label
      }) as Critique
      await loadList()
      setSelected(created)
      toast.success('Critique submitted', { description: 'LLM is generating — watch this row.' })
    } catch (e) {
      toast.error('Submit failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [loadList])

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this critique?')) return
    setBusy(true)
    try {
      await window.heimdall.invoke('critique:delete', id)
      if (selected?.id === id) setSelected(null)
      await loadList()
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected?.id, loadList])

  const goToParent = (c: Critique) => {
    const meta = PARENT_META[c.parent_kind]
    if (meta.route && c.parent_id) navigate(meta.route(c.parent_id))
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left rail */}
      <div className="w-80 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-semibold">Critiques</span>
          </div>
          <Button size="sm" variant="ghost" onClick={handleNew} disabled={busy} title="New free-form critique">
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
              No critiques yet. Click <Plus className="inline h-3 w-3" /> to red-team a free-form
              topic, or use the "Run critique" button on a hypothesis, comparison, or chronology.
            </div>
          )}
          {list.map((c) => {
            const m = PARENT_META[c.parent_kind]
            const Icon = m.icon
            return (
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
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.label}</span>
                  <div className="ml-auto"><StatusPill status={c.status} /></div>
                </div>
                <div className="text-sm font-medium truncate">{c.parent_label || '(untitled)'}</div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {formatRelativeTime(c.updated_at)}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex-1 overflow-y-auto">
        {!selected && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a critique to read the red-team verdict.
          </div>
        )}
        {selected && (
          <div className="p-6 max-w-4xl mx-auto">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <ShieldOff className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                      {selected.parent_label || '(untitled)'}
                    </CardTitle>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">
                        {PARENT_META[selected.parent_kind].label}
                      </Badge>
                      <StatusPill status={selected.status} />
                      {selected.model && (
                        <Badge variant="outline" className="text-[10px]">
                          <Sparkles className="h-3 w-3 mr-1" />{selected.model}
                        </Badge>
                      )}
                      <span>updated {formatRelativeTime(selected.updated_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {selected.parent_id && PARENT_META[selected.parent_kind].route && (
                      <Button size="sm" variant="outline" onClick={() => goToParent(selected)}>
                        Open parent
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(selected.id)} disabled={busy} title="Delete">
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {selected.status === 'generating' && (
                  <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground border border-dashed rounded-md">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Red-teaming in progress — auto-refreshing every 5 seconds.
                  </div>
                )}
                {selected.status === 'error' && (
                  <div className="p-4 rounded-md border border-red-500/30 bg-red-500/5 text-sm">
                    <div className="flex items-center gap-2 font-medium text-red-600 dark:text-red-400 mb-1">
                      <AlertCircle className="h-4 w-4" /> Critique failed
                    </div>
                    <div className="text-muted-foreground whitespace-pre-wrap">{selected.error_text}</div>
                  </div>
                )}
                {selected.status === 'ready' && selected.critique_md && (
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <MarkdownRenderer content={selected.critique_md} />
                  </div>
                )}

                {selected.topic_md && (
                  <details className="mt-6 rounded-md border border-border bg-muted/20">
                    <summary className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground cursor-pointer hover:text-foreground">
                      Show original analysis (the input that was critiqued)
                    </summary>
                    <pre className="p-3 text-xs whitespace-pre-wrap font-mono text-muted-foreground/80">
                      {selected.topic_md}
                    </pre>
                  </details>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
