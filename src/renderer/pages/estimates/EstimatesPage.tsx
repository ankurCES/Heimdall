// EstimatesPage — v1.9.5 ICD-203 estimative-probability tracker.
//
// Each estimate is a forecast wrapped in a Words of Estimative
// Probability phrase. The page is a single-pane table view with a
// calibration card pinned to the top: Brier score + per-WEP buckets
// showing whether your "likely" forecasts are actually coming true
// ~65% of the time. Inline resolve actions per row.

import { useEffect, useState, useCallback } from 'react'
import {
  Gauge, Plus, Loader2, AlertCircle, Trash2, CheckCircle2, XCircle,
  CircleHelp, Minus, RotateCcw, Edit3, Calendar, AlertTriangle
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { promptDialog } from '@renderer/components/PromptDialog'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

type Wep = 'almost_certain' | 'very_likely' | 'likely' | 'even_chance' | 'unlikely' | 'very_unlikely' | 'almost_no_chance'
type Status = 'open' | 'resolved_correct' | 'resolved_partial' | 'resolved_wrong' | 'resolved_unknowable'
type ConfidenceBand = 'low' | 'moderate' | 'high'

interface Estimate {
  id: string
  statement: string
  wep: Wep
  confidence_band: ConfidenceBand
  deadline_at: number | null
  resolution_criteria: string | null
  parent_kind: string | null
  parent_id: string | null
  parent_label: string | null
  status: Status
  resolved_at: number | null
  resolution_note: string | null
  created_at: number
  updated_at: number
}

interface PerWepStats {
  wep: Wep
  expected_pct: number
  resolved_n: number
  observed_pct: number | null
  open_n: number
}

interface CalibrationStats {
  total: number
  open: number
  resolved: number
  brier_score: number | null
  per_wep: PerWepStats[]
}

const WEP_META: Record<Wep, { label: string; pct: number }> = {
  almost_certain:   { label: 'Almost certain',     pct: 95 },
  very_likely:      { label: 'Very likely',        pct: 85 },
  likely:           { label: 'Likely',             pct: 65 },
  even_chance:      { label: 'Roughly even',       pct: 50 },
  unlikely:         { label: 'Unlikely',           pct: 35 },
  very_unlikely:    { label: 'Very unlikely',      pct: 15 },
  almost_no_chance: { label: 'Almost no chance',   pct: 5 }
}

const STATUS_META: Record<Status, { label: string; icon: typeof CheckCircle2; color: string; bg: string }> = {
  open:                { label: 'Open',         icon: CircleHelp,   color: 'text-blue-600 dark:text-blue-400',         bg: 'bg-blue-500/15' },
  resolved_correct:    { label: 'Correct',      icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400',   bg: 'bg-emerald-500/15' },
  resolved_partial:    { label: 'Partial',      icon: Minus,        color: 'text-amber-600 dark:text-amber-400',       bg: 'bg-amber-500/15' },
  resolved_wrong:      { label: 'Wrong',        icon: XCircle,      color: 'text-red-600 dark:text-red-400',           bg: 'bg-red-500/15' },
  resolved_unknowable: { label: 'Unknowable',   icon: CircleHelp,   color: 'text-muted-foreground',                    bg: 'bg-muted/30' }
}

function fmtDate(ts: number | null): string {
  if (!ts) return '—'
  try { return new Date(ts).toISOString().slice(0, 10) } catch { return '—' }
}

function brierGrade(b: number | null): { label: string; color: string } | null {
  if (b == null) return null
  if (b < 0.10) return { label: 'Excellent', color: 'text-emerald-600 dark:text-emerald-400' }
  if (b < 0.18) return { label: 'Good',      color: 'text-emerald-600 dark:text-emerald-400' }
  if (b < 0.25) return { label: 'Fair',      color: 'text-amber-600 dark:text-amber-400' }
  return { label: 'Poor (worse than coin-flip)', color: 'text-red-600 dark:text-red-400' }
}

export function EstimatesPage() {
  const [list, setList] = useState<Estimate[]>([])
  const [stats, setStats] = useState<CalibrationStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [rows, calib] = await Promise.all([
        window.heimdall.invoke('estimate:list') as Promise<Estimate[]>,
        window.heimdall.invoke('estimate:calibration') as Promise<CalibrationStats>
      ])
      setList(rows)
      setStats(calib)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleNew = useCallback(async () => {
    const statement = await promptDialog({
      label: 'Forecast statement',
      placeholder: 'e.g. "Russia conducts cyber op against EU energy grid before 1 Aug 2026"',
      validate: (v) => v.trim().length < 12 ? 'Be specific (12+ chars)' : null
    })
    if (!statement) return
    const wepStr = await promptDialog({
      label: 'WEP (1-7)',
      description: '1=almost_certain (95%), 2=very_likely (85%), 3=likely (65%), 4=even_chance (50%), 5=unlikely (35%), 6=very_unlikely (15%), 7=almost_no_chance (5%)',
      placeholder: '3',
      validate: (v) => /^[1-7]$/.test(v.trim()) ? null : 'Pick 1–7'
    })
    if (!wepStr) return
    const wepIdx = parseInt(wepStr, 10) - 1
    const wep = (Object.keys(WEP_META) as Wep[])[wepIdx]
    const deadlineStr = await promptDialog({
      label: 'Deadline (YYYY-MM-DD)',
      placeholder: 'When should this be resolved?',
      validate: (v) => !v.trim() || !isNaN(Date.parse(v)) ? null : 'Bad date'
    })
    let deadline_at: number | null = null
    if (deadlineStr && deadlineStr.trim()) {
      deadline_at = Date.parse(deadlineStr.trim())
      if (!Number.isFinite(deadline_at)) deadline_at = null
    }
    const criteria = await promptDialog({
      label: 'Resolution criteria (how will you know?)',
      multiline: true
    })
    setBusy(true)
    try {
      await window.heimdall.invoke('estimate:create', {
        statement, wep, deadline_at, resolution_criteria: criteria
      })
      await load()
      toast.success('Estimate logged')
    } catch (e) {
      toast.error('Create failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [load])

  const handleResolve = useCallback(async (id: string, status: Status) => {
    const note = await promptDialog({
      label: 'Resolution note (optional)',
      multiline: true
    })
    setBusy(true)
    try {
      await window.heimdall.invoke('estimate:resolve', { id, status, note })
      await load()
    } catch (e) {
      toast.error('Resolve failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [load])

  const handleReopen = useCallback(async (id: string) => {
    setBusy(true)
    try {
      await window.heimdall.invoke('estimate:reopen', id)
      await load()
    } catch (e) {
      toast.error('Reopen failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [load])

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this estimate?')) return
    setBusy(true)
    try {
      await window.heimdall.invoke('estimate:delete', id)
      await load()
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [load])

  const handleEditStatement = useCallback(async (e: Estimate) => {
    const next = await promptDialog({
      label: 'Edit statement', initialValue: e.statement,
      validate: (v) => v.trim().length < 12 ? 'Too short' : null
    })
    if (!next || next === e.statement) return
    try {
      await window.heimdall.invoke('estimate:update', { id: e.id, patch: { statement: next } })
      await load()
    } catch (err) { toast.error('Update failed: ' + (err as Error).message) }
  }, [load])

  const grade = brierGrade(stats?.brier_score ?? null)
  const overdue = list.filter((e) => e.status === 'open' && e.deadline_at && e.deadline_at < Date.now())

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Estimative Probability Tracker</h1>
          </div>
          <Button size="sm" onClick={handleNew} disabled={busy}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New estimate
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-md border border-red-500/30 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5" /> {error}
          </div>
        )}

        {/* Calibration overview */}
        {stats && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Calibration</CardTitle>
              <CardDescription className="text-xs">
                Brier score is mean squared error between WEP probability and observed outcome (0 = perfect, 0.25 = random for binary calls).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-3 text-xs mb-4">
                <div className="rounded-md p-2 border bg-muted/20">
                  <div className="text-[10px] uppercase text-muted-foreground">Total</div>
                  <div className="text-lg font-semibold">{stats.total}</div>
                </div>
                <div className="rounded-md p-2 border bg-blue-500/10">
                  <div className="text-[10px] uppercase text-blue-600 dark:text-blue-400">Open</div>
                  <div className="text-lg font-semibold">{stats.open}</div>
                </div>
                <div className="rounded-md p-2 border bg-emerald-500/10">
                  <div className="text-[10px] uppercase text-emerald-600 dark:text-emerald-400">Resolved</div>
                  <div className="text-lg font-semibold">{stats.resolved}</div>
                </div>
                <div className="rounded-md p-2 border bg-muted/20">
                  <div className="text-[10px] uppercase text-muted-foreground">Brier score</div>
                  <div className="text-lg font-semibold">
                    {stats.brier_score != null ? stats.brier_score.toFixed(3) : '—'}
                  </div>
                  {grade && <div className={cn('text-[10px]', grade.color)}>{grade.label}</div>}
                </div>
              </div>

              <div className="space-y-1">
                {stats.per_wep.map((b) => (
                  <div key={b.wep} className="flex items-center gap-3 text-xs">
                    <div className="w-32 text-muted-foreground">{WEP_META[b.wep].label}</div>
                    <div className="w-12 text-right font-mono text-muted-foreground">{b.expected_pct.toFixed(0)}%</div>
                    <div className="flex-1 relative h-3 rounded-full bg-muted overflow-hidden">
                      {/* Expected marker */}
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-foreground/60 z-10"
                        style={{ left: `${b.expected_pct}%` }}
                        title={`Expected ${b.expected_pct.toFixed(0)}%`}
                      />
                      {/* Observed bar */}
                      {b.observed_pct != null && (
                        <div
                          className={cn(
                            'h-full',
                            Math.abs(b.observed_pct - b.expected_pct) < 10 ? 'bg-emerald-500'
                            : Math.abs(b.observed_pct - b.expected_pct) < 20 ? 'bg-amber-500'
                            : 'bg-red-500'
                          )}
                          style={{ width: `${b.observed_pct}%` }}
                          title={`Observed ${b.observed_pct.toFixed(0)}%`}
                        />
                      )}
                    </div>
                    <div className="w-24 text-right text-muted-foreground">
                      {b.observed_pct != null ? `${b.observed_pct.toFixed(0)}% obs` : '—'} ({b.resolved_n}+{b.open_n}o)
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Overdue ribbon */}
        {overdue.length > 0 && (
          <div className="flex items-center gap-2 p-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span><strong>{overdue.length}</strong> open estimate{overdue.length === 1 ? '' : 's'} past deadline — resolve to keep calibration honest.</span>
          </div>
        )}

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : list.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No estimates yet. Click <strong>New estimate</strong> to log your first forecast.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {list.map((e) => {
                  const sm = STATUS_META[e.status]
                  const SIcon = sm.icon
                  const isOverdue = e.status === 'open' && e.deadline_at != null && e.deadline_at < Date.now()
                  return (
                    <div key={e.id} className="group p-3 hover:bg-accent/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <Badge className="text-[10px] bg-primary/15 text-primary">{WEP_META[e.wep].pct}% · {WEP_META[e.wep].label}</Badge>
                            <Badge variant="outline" className="text-[10px]">conf: {e.confidence_band}</Badge>
                            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium inline-flex items-center gap-1', sm.bg, sm.color)}>
                              <SIcon className="h-3 w-3" />{sm.label}
                            </span>
                            {e.parent_label && (
                              <Badge variant="outline" className="text-[10px]">{e.parent_kind}: {e.parent_label}</Badge>
                            )}
                          </div>
                          <div className="text-sm">{e.statement}</div>
                          {e.resolution_criteria && (
                            <div className="mt-0.5 text-[11px] text-muted-foreground italic">↳ {e.resolution_criteria}</div>
                          )}
                          <div className="mt-1 text-[10px] text-muted-foreground flex items-center gap-2">
                            <Calendar className="h-3 w-3" />
                            <span>deadline: {fmtDate(e.deadline_at)}</span>
                            {isOverdue && <span className="text-amber-600 dark:text-amber-400 font-medium">· OVERDUE</span>}
                            <span>· created {formatRelativeTime(e.created_at)}</span>
                            {e.resolved_at && <span>· resolved {formatRelativeTime(e.resolved_at)}</span>}
                          </div>
                          {e.resolution_note && (
                            <div className="mt-1 text-[11px] text-muted-foreground/80 italic">note: {e.resolution_note}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
                          {e.status === 'open' ? (
                            <>
                              <Button size="sm" variant="ghost" className="h-7 text-emerald-600 dark:text-emerald-400" onClick={() => handleResolve(e.id, 'resolved_correct')} title="Resolve correct">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-amber-600 dark:text-amber-400" onClick={() => handleResolve(e.id, 'resolved_partial')} title="Resolve partial">
                                <Minus className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-red-600 dark:text-red-400" onClick={() => handleResolve(e.id, 'resolved_wrong')} title="Resolve wrong">
                                <XCircle className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => handleResolve(e.id, 'resolved_unknowable')} title="Mark unknowable (excluded from calibration)">
                                <CircleHelp className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" className="h-7" onClick={() => handleReopen(e.id)} title="Reopen">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => handleEditStatement(e)} title="Edit statement">
                            <Edit3 className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-red-600 dark:text-red-400" onClick={() => handleDelete(e.id)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
