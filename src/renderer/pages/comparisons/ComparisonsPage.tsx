// ComparisonsPage — v1.9.0 Phase 10 cross-subject comparative analysis.
//
// List + detail layout. Top-bar buttons launch the two flavours:
//   - Compare entities — prompts for two canonical ids
//   - Compare time windows — prompts for two date ranges
//
// Detail pane renders the LLM's structured markdown report through
// the existing MarkdownRenderer; status pill + 5s poll while
// generating mirror the BriefingsPage pattern.

import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Scale, Loader2, AlertCircle, CheckCircle2, RefreshCw, Trash2,
  Users as UsersIcon, Clock as ClockIcon, FileText, Plus
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { promptDialog } from '@renderer/components/PromptDialog'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

interface ComparativeAnalysis {
  id: string
  name: string
  kind: 'entities' | 'time_windows'
  left_subject_json: string
  right_subject_json: string
  status: 'generating' | 'ready' | 'error'
  model: string | null
  body_md: string | null
  sources_json: string | null
  error_text: string | null
  generated_at: number
  updated_at: number
}

function StatusPill({ status }: { status: ComparativeAnalysis['status'] }) {
  if (status === 'ready') {
    return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Ready</span>
  }
  if (status === 'generating') {
    return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Generating</span>
  }
  return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-600 dark:text-red-400 inline-flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Error</span>
}

function parseDateInput(s: string): number | null {
  if (!s) return null
  // Accept YYYY-MM-DD plain date strings — interpret in local time.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  // Or accept ISO timestamps directly.
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

export function ComparisonsPage() {
  const [list, setList] = useState<ComparativeAnalysis[]>([])
  const [selected, setSelected] = useState<ComparativeAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await window.heimdall.invoke('comparison:list', { limit: 50 }) as ComparativeAnalysis[]
      setList(rows)
      setSelected((cur) => cur ? rows.find((r) => r.id === cur.id) ?? null : cur)
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }, [])

  useEffect(() => {
    void load()
    // Poll every 5s while a comparison is generating, mirroring BriefingsPage.
    const id = setInterval(() => {
      if (list.some((r) => r.status === 'generating')) void load()
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, list.length])

  const compareEntities = async () => {
    setError(null)
    const leftId = await promptDialog({
      label: 'Left canonical entity',
      description: 'Paste the canonical id (UUID). Use "copy id" on /entity/:id to grab it.',
      placeholder: 'a1b2c3d4-…',
      validate: (v) => v.trim().length < 8 ? 'Canonical id looks too short' : null
    })
    if (!leftId) return
    const rightId = await promptDialog({
      label: 'Right canonical entity',
      description: 'Paste the canonical id of the entity to compare against.',
      placeholder: 'a1b2c3d4-…',
      validate: (v) => v.trim().length < 8 ? 'Canonical id looks too short' : v.trim() === leftId.trim() ? 'Cannot compare with itself' : null
    })
    if (!rightId) return
    setBusy(true)
    try {
      const r = await window.heimdall.invoke('comparison:generate_entities', {
        leftCanonicalId: leftId.trim(),
        rightCanonicalId: rightId.trim()
      }) as ComparativeAnalysis
      await load()
      setSelected(r)
      toast.success('Comparison submitted', { description: 'LLM is synthesising — list refreshes every 5s.' })
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      toast.error('Comparison failed', { description: msg })
    } finally { setBusy(false) }
  }

  const compareTimeWindows = async () => {
    setError(null)
    const leftRange = await promptDialog({
      label: 'Left time window',
      description: 'Format: YYYY-MM-DD..YYYY-MM-DD (e.g. "2026-01-01..2026-03-31"). Whole-day boundaries in local time.',
      placeholder: '2026-01-01..2026-03-31',
      validate: (v) => /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? null : 'Use YYYY-MM-DD..YYYY-MM-DD'
    })
    if (!leftRange) return
    const rightRange = await promptDialog({
      label: 'Right time window',
      description: 'Same format. Compared against the left window.',
      placeholder: '2026-04-01..2026-06-30',
      validate: (v) => /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? null : 'Use YYYY-MM-DD..YYYY-MM-DD'
    })
    if (!rightRange) return
    const [ls, le] = leftRange.trim().split('..').map(parseDateInput)
    const [rs, re] = rightRange.trim().split('..').map(parseDateInput)
    if (!ls || !le || !rs || !re) {
      toast.error('Invalid date format')
      return
    }
    setBusy(true)
    try {
      // Treat the end-day as inclusive by adding 24h.
      const r = await window.heimdall.invoke('comparison:generate_time_windows', {
        leftWindow: { start: ls, end: le + 86_400_000 },
        rightWindow: { start: rs, end: re + 86_400_000 }
      }) as ComparativeAnalysis
      await load()
      setSelected(r)
      toast.success('Comparison submitted', { description: 'LLM is synthesising — list refreshes every 5s.' })
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      toast.error('Comparison failed', { description: msg })
    } finally { setBusy(false) }
  }

  const removeOne = async () => {
    if (!selected) return
    if (!confirm(`Delete comparison "${selected.name}"?`)) return
    try {
      await window.heimdall.invoke('comparison:delete', selected.id)
      setSelected(null)
      await load()
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }

  const subjectLabels = useMemo(() => {
    if (!selected) return null
    try {
      const left = JSON.parse(selected.left_subject_json) as { canonical_id?: string; label?: string; start?: number; end?: number }
      const right = JSON.parse(selected.right_subject_json) as { canonical_id?: string; label?: string; start?: number; end?: number }
      const fmt = (s: typeof left): string => {
        if (s.label) return s.label
        if (s.canonical_id) return s.canonical_id.slice(0, 8) + '…'
        if (s.start && s.end) return `${new Date(s.start).toLocaleDateString()} → ${new Date(s.end).toLocaleDateString()}`
        return '—'
      }
      return { left: fmt(left), right: fmt(right) }
    } catch { return null }
  }, [selected])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Scale className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Comparative Analysis</h1>
          <Badge variant="outline" className="text-[10px] ml-2">v1.9.0</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="default" onClick={compareEntities} disabled={busy} className="h-8">
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <UsersIcon className="h-3.5 w-3.5 mr-1" />}
              Compare entities
            </Button>
            <Button size="sm" variant="outline" onClick={compareTimeWindows} disabled={busy} className="h-8">
              <ClockIcon className="h-3.5 w-3.5 mr-1" /> Compare time windows
            </Button>
            <Button size="sm" variant="ghost" onClick={load} className="h-8" title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          LLM-driven structured side-by-side: compare two entities or two time windows. Output mirrors the daily-briefing
          format (BLUF, Shared Themes, Divergences, Trajectory, Open Questions) with citation-grounded prose.
        </p>
        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {error}
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 border-r border-border flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {list.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center px-3">
                No comparisons yet. Click <strong>Compare entities</strong> or <strong>Compare time windows</strong> above to generate the first one.
              </div>
            ) : list.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md transition-colors border',
                  selected?.id === r.id ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent'
                )}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{r.name}</span>
                  <StatusPill status={r.status} />
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  <Badge variant="outline" className="text-[9px] uppercase font-mono">{r.kind === 'entities' ? 'entities' : 'time'}</Badge>
                  <span>{formatRelativeTime(r.updated_at)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {selected ? (
            <div className="flex flex-col h-full overflow-hidden">
              <div className="border-b border-border px-6 py-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
                      <Scale className="h-4 w-4 text-primary" />
                      {selected.name}
                      <StatusPill status={selected.status} />
                    </h2>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                      <Badge variant="outline" className="text-[10px] uppercase">{selected.kind === 'entities' ? 'entities' : 'time windows'}</Badge>
                      {subjectLabels && (
                        <span className="font-mono">{subjectLabels.left} <span className="text-foreground">vs</span> {subjectLabels.right}</span>
                      )}
                      <span>· generated {formatRelativeTime(selected.generated_at)}</span>
                      {selected.model && <span>· {selected.model}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={removeOne} className="h-8 text-red-600 dark:text-red-400 hover:bg-red-500/10">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-6">
                {selected.status === 'generating' && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> LLM synthesizing the comparison… 30-60 seconds.
                  </div>
                )}
                {selected.status === 'error' && (
                  <div className="border border-red-500/30 bg-red-500/5 rounded-md p-3 space-y-1">
                    <div className="text-sm font-medium text-red-700 dark:text-red-400 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" /> Generation failed
                    </div>
                    <div className="text-xs text-red-600 dark:text-red-400 font-mono">{selected.error_text}</div>
                  </div>
                )}
                {selected.status === 'ready' && selected.body_md && (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <MarkdownRenderer content={selected.body_md} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 px-6 text-center">
              <FileText className="h-10 w-10 opacity-40" />
              <div className="text-sm">Select a comparison from the list, or generate a new one above.</div>
              <Link to="/entities" className="text-xs text-primary hover:underline">… or browse entities for canonical ids</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
