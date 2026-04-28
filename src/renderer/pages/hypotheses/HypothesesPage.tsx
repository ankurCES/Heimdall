// HypothesesPage — v1.9.1 operationalised ACH workspace.
//
// Master/detail. Left rail lists every hypothesis with a quick
// support/refute/neutral breakdown + net score. Right pane shows
// the selected hypothesis's running evidence list, each row
// click-through to its underlying intel report. Analyst can flip
// any verdict (the running tally honours overrides).

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ListChecks, Plus, RefreshCw, Loader2, AlertCircle, Trash2,
  ThumbsUp, ThumbsDown, Minus, HelpCircle, Sparkles, Pause, Play,
  Edit3, Archive, ShieldOff, ListTodo
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { promptDialog } from '@renderer/components/PromptDialog'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

type Verdict = 'supports' | 'refutes' | 'neutral' | 'undetermined'
type Status = 'active' | 'paused' | 'closed'

interface Hypothesis {
  id: string
  name: string
  statement: string
  status: Status
  anchor_canonical_id: string | null
  scope_hint: string | null
  created_at: number
  updated_at: number
  last_evaluated_at: number | null
  evidence_count: number
  supports_count: number
  refutes_count: number
  neutral_count: number
  undetermined_count: number
  net_score: number
  anchor_canonical_value: string | null
}

interface Evidence {
  id: string
  hypothesis_id: string
  intel_id: string
  verdict: Verdict
  confidence: number
  reasoning: string | null
  model: string | null
  evaluated_at: number
  analyst_override: Verdict | null
  analyst_override_at: number | null
  report_title: string | null
  report_severity: string | null
  report_source_name: string | null
  report_created_at: number | null
}

const VERDICT_META: Record<Verdict, { label: string; icon: typeof ThumbsUp; color: string; bg: string }> = {
  supports:     { label: 'Supports',     icon: ThumbsUp,   color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/15' },
  refutes:      { label: 'Refutes',      icon: ThumbsDown, color: 'text-red-600 dark:text-red-400',         bg: 'bg-red-500/15' },
  neutral:      { label: 'Neutral',      icon: Minus,      color: 'text-muted-foreground',                  bg: 'bg-muted/30' },
  undetermined: { label: 'Undetermined', icon: HelpCircle, color: 'text-amber-600 dark:text-amber-400',     bg: 'bg-amber-500/15' }
}

function VerdictPill({ verdict, overridden }: { verdict: Verdict; overridden?: boolean }) {
  const m = VERDICT_META[verdict]
  const Icon = m.icon
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium inline-flex items-center gap-1', m.bg, m.color)}>
      <Icon className="h-3 w-3" />
      {m.label}{overridden && <span className="text-[9px] italic">(override)</span>}
    </span>
  )
}

function StatusPill({ status }: { status: Status }) {
  if (status === 'active') return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px]">active</Badge>
  if (status === 'paused') return <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px]">paused</Badge>
  return <Badge className="bg-muted/40 text-muted-foreground text-[10px]">closed</Badge>
}

export function HypothesesPage() {
  const [list, setList] = useState<Hypothesis[]>([])
  const [selected, setSelected] = useState<Hypothesis | null>(null)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [loading, setLoading] = useState(true)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const loadList = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const rows = await window.heimdall.invoke('hypothesis:list') as Hypothesis[]
      setList(rows)
      setSelected((cur) => cur ? rows.find((r) => r.id === cur.id) ?? null : cur)
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
    finally { setLoading(false) }
  }, [])

  const loadEvidence = useCallback(async (id: string) => {
    setEvidenceLoading(true)
    try {
      const rows = await window.heimdall.invoke('hypothesis:evidence', { id, limit: 100 }) as Evidence[]
      setEvidence(rows)
    } catch { setEvidence([]) }
    finally { setEvidenceLoading(false) }
  }, [])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => {
    if (selected) void loadEvidence(selected.id)
    else setEvidence([])
  }, [selected?.id, loadEvidence])

  const createHypothesis = async () => {
    const name = await promptDialog({
      label: 'Name this hypothesis',
      description: 'A short identifier — e.g. "FIN7 reorg".',
      placeholder: 'FIN7 reorg',
      validate: (v) => v.trim().length < 3 ? 'Name needs ≥3 chars' : null
    })
    if (!name) return
    const statement = await promptDialog({
      label: 'Hypothesis statement',
      description: 'The full claim the system will score new intel against. Phrase it as a falsifiable assertion. The LLM evaluator returns supports / refutes / neutral / undetermined per intel report.',
      placeholder: 'FIN7 is reorganising with new command-and-control infrastructure since April 2026.',
      multiline: true,
      validate: (v) => v.trim().length < 10 ? 'Statement is too short' : null
    })
    if (!statement) return
    setBusy(true)
    try {
      await window.heimdall.invoke('hypothesis:create', { name, statement })
      await loadList()
      toast.success('Hypothesis created', { description: 'Auto-evaluator runs every 15 min on new intel.' })
    } catch (err) {
      toast.error('Create failed', { description: String(err).replace(/^Error:\s*/, '') })
    } finally { setBusy(false) }
  }

  const editStatement = async () => {
    if (!selected) return
    const next = await promptDialog({
      label: 'Edit hypothesis statement',
      initialValue: selected.statement,
      multiline: true,
      validate: (v) => v.trim().length < 10 ? 'Statement is too short' : null
    })
    if (!next) return
    try {
      await window.heimdall.invoke('hypothesis:update', { id: selected.id, patch: { statement: next } })
      await loadList()
    } catch (err) { toast.error('Update failed', { description: String(err).replace(/^Error:\s*/, '') }) }
  }

  const setStatus = async (status: Status) => {
    if (!selected) return
    try {
      await window.heimdall.invoke('hypothesis:update', { id: selected.id, patch: { status } })
      await loadList()
    } catch (err) { toast.error('Update failed', { description: String(err).replace(/^Error:\s*/, '') }) }
  }

  const removeHypothesis = async () => {
    if (!selected) return
    if (!confirm(`Delete hypothesis "${selected.name}" and all its evidence rows? This is irreversible.`)) return
    try {
      await window.heimdall.invoke('hypothesis:delete', selected.id)
      setSelected(null)
      await loadList()
    } catch (err) { toast.error('Delete failed', { description: String(err).replace(/^Error:\s*/, '') }) }
  }

  // v1.9.3 — kick off a red-team critique against the selected
  // hypothesis. The LLM runs async; we navigate to /critiques so the
  // analyst can watch the row land.
  const runCritique = async () => {
    if (!selected) return
    try {
      await window.heimdall.invoke('critique:create_for_parent', {
        parent_kind: 'hypothesis', parent_id: selected.id
      })
      toast.success('Critique submitted', {
        description: 'Red-teaming in progress — opening Critiques page.',
        action: { label: 'Open', onClick: () => navigate('/critiques') }
      })
      navigate('/critiques')
    } catch (err) {
      toast.error('Critique failed', { description: String(err).replace(/^Error:\s*/, '') })
    }
  }

  // v1.9.4 — bind a fresh KAC to this hypothesis and jump there.
  const runKac = async () => {
    if (!selected) return
    try {
      const created = await window.heimdall.invoke('kac:create', {
        name: `KAC: ${selected.name}`,
        parent_kind: 'hypothesis',
        parent_id: selected.id
      }) as { id: string }
      toast.success('Assumption check created', {
        description: 'Open it from the Assumptions page; click Extract to seed via LLM.',
        action: { label: 'Open', onClick: () => navigate('/assumptions') }
      })
      navigate('/assumptions')
      void created
    } catch (err) {
      toast.error('KAC failed', { description: String(err).replace(/^Error:\s*/, '') })
    }
  }

  const overrideVerdict = async (evidenceId: string, verdict: Verdict | null) => {
    try {
      await window.heimdall.invoke('hypothesis:set_override', { evidenceId, verdict })
      if (selected) {
        await Promise.all([loadList(), loadEvidence(selected.id)])
      }
    } catch (err) { toast.error('Override failed', { description: String(err).replace(/^Error:\s*/, '') }) }
  }

  const runNow = async () => {
    setBusy(true)
    try {
      const r = await window.heimdall.invoke('hypothesis:run_now') as { scanned: number; evaluated: number }
      toast.success('Auto-evaluator finished', { description: `Scanned ${r.scanned} hypothesis${r.scanned !== 1 ? 'es' : ''}, scored ${r.evaluated} new evidence row${r.evaluated !== 1 ? 's' : ''}.` })
      await loadList()
      if (selected) await loadEvidence(selected.id)
    } catch (err) { toast.error('Run failed', { description: String(err).replace(/^Error:\s*/, '') }) }
    finally { setBusy(false) }
  }

  // Bar chart-style breakdown for the selected hypothesis.
  const breakdown = useMemo(() => {
    if (!selected) return null
    const total = selected.evidence_count || 1
    return {
      supports: (selected.supports_count / total) * 100,
      refutes: (selected.refutes_count / total) * 100,
      neutral: (selected.neutral_count / total) * 100,
      undetermined: (selected.undetermined_count / total) * 100
    }
  }, [selected])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <ListChecks className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Hypothesis Tracker</h1>
          <Badge variant="outline" className="text-[10px] ml-2">v1.9.1</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="default" onClick={createHypothesis} disabled={busy} className="h-8">
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
              New hypothesis
            </Button>
            <Button size="sm" variant="outline" onClick={runNow} disabled={busy} className="h-8" title="Force the auto-evaluator to run now (does not wait for the 15-min cron tick)">
              <Sparkles className="h-3.5 w-3.5 mr-1" /> Run evaluator now
            </Button>
            <Button size="sm" variant="ghost" onClick={loadList} className="h-8" title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Operationalised Analysis of Competing Hypotheses (ACH). Each active hypothesis is auto-scored against every new
          intel report by the LLM (15-minute cron). Verdicts are <em>supports / refutes / neutral / undetermined</em> with
          confidence + reasoning; you can override any verdict and the running tally honours your call.
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
            {loading && list.length === 0 && (
              <div className="text-xs text-muted-foreground p-3 text-center">Loading…</div>
            )}
            {!loading && list.length === 0 && (
              <div className="text-sm text-muted-foreground py-6 text-center px-3">
                No hypotheses yet. Click <strong>New hypothesis</strong> to define one.
              </div>
            )}
            {list.map((h) => {
              const sign = h.net_score > 0.1 ? 'pos' : h.net_score < -0.1 ? 'neg' : 'flat'
              return (
                <button
                  key={h.id}
                  onClick={() => setSelected(h)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md transition-colors border',
                    selected?.id === h.id ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent'
                  )}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">{h.name}</span>
                    <StatusPill status={h.status} />
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{h.evidence_count} evidence</span>
                    <span className="text-emerald-600 dark:text-emerald-400">+{h.supports_count}</span>
                    <span className="text-red-600 dark:text-red-400">−{h.refutes_count}</span>
                    <span className={cn(
                      'font-mono',
                      sign === 'pos' && 'text-emerald-600 dark:text-emerald-400',
                      sign === 'neg' && 'text-red-600 dark:text-red-400'
                    )}>
                      net {h.net_score >= 0 ? '+' : ''}{h.net_score.toFixed(2)}
                    </span>
                  </div>
                  {h.last_evaluated_at && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      last evaluated {formatRelativeTime(h.last_evaluated_at)}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {selected ? (
            <div className="flex flex-col h-full overflow-hidden">
              <div className="border-b border-border px-6 py-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
                      {selected.name} <StatusPill status={selected.status} />
                    </h2>
                    <p className="text-sm mt-1 italic">"{selected.statement}"</p>
                    {selected.anchor_canonical_value && (
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Anchored to entity: <strong className="text-foreground">{selected.anchor_canonical_value}</strong>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={editStatement} className="h-8" title="Edit statement">
                      <Edit3 className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={runCritique} className="h-8 text-amber-600 dark:text-amber-400" title="Red-team critique (LLM argues against this hypothesis)">
                      <ShieldOff className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={runKac} className="h-8 text-primary" title="Key Assumptions Check (start a stress-test of this hypothesis's assumptions)">
                      <ListTodo className="h-3.5 w-3.5" />
                    </Button>
                    {selected.status === 'active' ? (
                      <Button size="sm" variant="ghost" onClick={() => setStatus('paused')} className="h-8 text-amber-600 dark:text-amber-400" title="Pause auto-evaluation">
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    ) : selected.status === 'paused' ? (
                      <Button size="sm" variant="ghost" onClick={() => setStatus('active')} className="h-8 text-emerald-600 dark:text-emerald-400" title="Resume auto-evaluation">
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    {selected.status !== 'closed' && (
                      <Button size="sm" variant="ghost" onClick={() => setStatus('closed')} className="h-8 text-muted-foreground" title="Close hypothesis (freezes evidence as a historical record)">
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={removeHypothesis} className="h-8 text-red-600 dark:text-red-400 hover:bg-red-500/10">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  <Card><CardContent className="p-2"><div className="text-muted-foreground text-[10px]">Supports</div><div className="text-emerald-600 dark:text-emerald-400 font-semibold text-base">{selected.supports_count}</div></CardContent></Card>
                  <Card><CardContent className="p-2"><div className="text-muted-foreground text-[10px]">Refutes</div><div className="text-red-600 dark:text-red-400 font-semibold text-base">{selected.refutes_count}</div></CardContent></Card>
                  <Card><CardContent className="p-2"><div className="text-muted-foreground text-[10px]">Neutral / undet.</div><div className="font-semibold text-base">{selected.neutral_count + selected.undetermined_count}</div></CardContent></Card>
                  <Card><CardContent className="p-2"><div className="text-muted-foreground text-[10px]">Net score</div><div className={cn('font-semibold text-base font-mono', selected.net_score > 0 && 'text-emerald-600 dark:text-emerald-400', selected.net_score < 0 && 'text-red-600 dark:text-red-400')}>{selected.net_score >= 0 ? '+' : ''}{selected.net_score.toFixed(2)}</div></CardContent></Card>
                </div>
                {breakdown && selected.evidence_count > 0 && (
                  <div className="h-2 w-full rounded-full overflow-hidden bg-muted/30 flex">
                    <div className="bg-emerald-500" style={{ width: `${breakdown.supports}%` }} title={`Supports ${selected.supports_count}`} />
                    <div className="bg-red-500" style={{ width: `${breakdown.refutes}%` }} title={`Refutes ${selected.refutes_count}`} />
                    <div className="bg-muted-foreground/40" style={{ width: `${breakdown.neutral}%` }} title={`Neutral ${selected.neutral_count}`} />
                    <div className="bg-amber-500/60" style={{ width: `${breakdown.undetermined}%` }} title={`Undetermined ${selected.undetermined_count}`} />
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-auto p-4">
                {evidenceLoading && (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading evidence…
                  </div>
                )}
                {!evidenceLoading && evidence.length === 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">No evidence yet</CardTitle>
                      <CardDescription className="text-xs">
                        The auto-evaluator runs every 15 minutes against active hypotheses. Click <strong>Run evaluator now</strong> above to force a pass against the last 72 hours of intel.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                )}
                {!evidenceLoading && evidence.length > 0 && (
                  <div className="space-y-2">
                    {evidence.map((e) => {
                      const effective = e.analyst_override ?? e.verdict
                      return (
                        <div key={e.id} className="border border-border rounded-md p-3 hover:bg-accent/30 transition-colors">
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0 flex-1">
                              <button
                                onClick={() => navigate(`/library?report=${encodeURIComponent(e.intel_id)}`)}
                                className="text-sm font-medium hover:text-primary text-left truncate block"
                              >
                                {e.report_title ?? e.intel_id.slice(0, 12)}
                              </button>
                              <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                                <VerdictPill verdict={effective} overridden={!!e.analyst_override} />
                                <span>conf {(e.confidence * 100).toFixed(0)}%</span>
                                {e.report_severity && <Badge variant="outline" className="text-[9px] uppercase">{e.report_severity}</Badge>}
                                {e.report_source_name && <span>· {e.report_source_name}</span>}
                                <span>· {formatRelativeTime(e.evaluated_at)}</span>
                                {e.model && <span>· {e.model}</span>}
                              </div>
                              {e.reasoning && (
                                <div className="text-xs mt-2 text-muted-foreground italic">{e.reasoning}</div>
                              )}
                            </div>
                            {/* Override controls */}
                            <div className="flex items-center gap-0.5 shrink-0">
                              {(['supports', 'refutes', 'neutral', 'undetermined'] as const).map((v) => {
                                const m = VERDICT_META[v]
                                const Icon = m.icon
                                const active = effective === v
                                return (
                                  <button
                                    key={v}
                                    onClick={() => overrideVerdict(e.id, active && e.analyst_override ? null : v)}
                                    className={cn(
                                      'p-1 rounded',
                                      active ? cn(m.bg, m.color) : 'text-muted-foreground hover:bg-accent'
                                    )}
                                    title={active && e.analyst_override ? 'Click to clear override' : `Override to ${m.label}`}
                                  >
                                    <Icon className="h-3 w-3" />
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 px-6 text-center">
              <ListChecks className="h-10 w-10 opacity-40" />
              <div className="text-sm">Select a hypothesis to view its evidence trail.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
