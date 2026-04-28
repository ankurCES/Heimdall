// WorkspacePage — v1.9.6 analytical workspace home.
//
// One-glance view across every analytical surface introduced in
// Phase 10 (v1.9.0 → v1.9.5):
//   - Hypotheses with their net support score
//   - Recent critiques + their status
//   - KAC checks flagging vulnerable assumptions
//   - Estimates approaching deadline / overdue
//   - Recent comparisons and chronologies
//
// Each card is read-only with a "→ Open" link to the dedicated
// surface. Quick-create buttons at the top.

import { useEffect, useState, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  Brain, Plus, ListChecks, Scale, History as HistoryIcon, ShieldOff,
  ListTodo, Gauge, ArrowRight, Loader2, AlertTriangle, ThumbsUp, ThumbsDown,
  CheckCircle2, XCircle, Minus, CircleHelp, AlertOctagon, Calendar
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { promptDialog } from '@renderer/components/PromptDialog'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

interface Hypothesis {
  id: string
  name: string
  status: 'active' | 'paused' | 'closed'
  evidence_count: number
  supports_count: number
  refutes_count: number
  net_score: number
  updated_at: number
}

interface Critique {
  id: string
  parent_kind: string
  parent_label: string | null
  status: 'generating' | 'ready' | 'error'
  updated_at: number
}

interface KacItem {
  status: 'well_supported' | 'supported_caveats' | 'unsupported' | 'vulnerable'
}

interface KacCheck {
  id: string
  name: string
  parent_kind: string | null
  parent_label: string | null
  items: KacItem[]
  counts: { well_supported: number; supported_caveats: number; unsupported: number; vulnerable: number }
  updated_at: number
}

interface Estimate {
  id: string
  statement: string
  wep: 'almost_certain' | 'very_likely' | 'likely' | 'even_chance' | 'unlikely' | 'very_unlikely' | 'almost_no_chance'
  status: 'open' | 'resolved_correct' | 'resolved_partial' | 'resolved_wrong' | 'resolved_unknowable'
  deadline_at: number | null
  updated_at: number
}

interface CalibrationStats {
  total: number
  open: number
  resolved: number
  brier_score: number | null
}

interface Comparison {
  id: string
  name: string
  kind: 'entities' | 'time_windows'
  status: string
  generated_at: number
}

interface Chronology {
  id: string
  name: string
  event_count: number
  updated_at: number
}

const WEP_PCT: Record<Estimate['wep'], number> = {
  almost_certain: 95, very_likely: 85, likely: 65, even_chance: 50,
  unlikely: 35, very_unlikely: 15, almost_no_chance: 5
}

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-md border border-border p-2 bg-card">
      <div className={cn('text-[10px] uppercase tracking-wide text-muted-foreground', color)}>{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  )
}

function NetScoreBadge({ score }: { score: number }) {
  const positive = score > 0.1
  const negative = score < -0.1
  const Icon = positive ? ThumbsUp : negative ? ThumbsDown : Minus
  return (
    <Badge className={cn(
      'text-[10px] inline-flex items-center gap-1',
      positive ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : negative ? 'bg-red-500/15 text-red-600 dark:text-red-400'
      : 'bg-muted/40 text-muted-foreground'
    )}>
      <Icon className="h-3 w-3" /> {score >= 0 ? '+' : ''}{score.toFixed(2)}
    </Badge>
  )
}

function SectionHeader({ icon: Icon, title, to, count }: { icon: typeof Brain; title: string; to: string; count?: number }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {count != null && <Badge variant="outline" className="text-[10px]">{count}</Badge>}
      </div>
      <Link to={to} className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5">
        Open <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  )
}

export function WorkspacePage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([])
  const [critiques, setCritiques] = useState<Critique[]>([])
  const [kacChecks, setKacChecks] = useState<KacCheck[]>([])
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [calibration, setCalibration] = useState<CalibrationStats | null>(null)
  const [comparisons, setComparisons] = useState<Comparison[]>([])
  const [chronologies, setChronologies] = useState<Chronology[]>([])

  const load = useCallback(async () => {
    try {
      const [h, cr, k, e, calib, comp, chr] = await Promise.all([
        window.heimdall.invoke('hypothesis:list') as Promise<Hypothesis[]>,
        window.heimdall.invoke('critique:list', { limit: 50 }) as Promise<Critique[]>,
        window.heimdall.invoke('kac:list') as Promise<KacCheck[]>,
        window.heimdall.invoke('estimate:list') as Promise<Estimate[]>,
        window.heimdall.invoke('estimate:calibration') as Promise<CalibrationStats>,
        window.heimdall.invoke('comparison:list', { limit: 10 }) as Promise<Comparison[]>,
        window.heimdall.invoke('chronology:list') as Promise<Chronology[]>
      ])
      setHypotheses(h); setCritiques(cr); setKacChecks(k); setEstimates(e)
      setCalibration(calib); setComparisons(comp); setChronologies(chr)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const quickCreateHypothesis = async () => {
    const name = await promptDialog({ label: 'Hypothesis name', validate: (v) => v.trim().length < 3 ? 'Too short' : null })
    if (!name) return
    const statement = await promptDialog({ label: 'Statement', multiline: true, validate: (v) => v.trim().length < 10 ? 'Too short' : null })
    if (!statement) return
    try {
      await window.heimdall.invoke('hypothesis:create', { name, statement })
      toast.success('Hypothesis created')
      navigate('/hypotheses')
    } catch (e) { toast.error((e as Error).message) }
  }

  const quickCreateChronology = async () => {
    const name = await promptDialog({ label: 'Chronology name', validate: (v) => v.trim().length < 3 ? 'Too short' : null })
    if (!name) return
    try {
      await window.heimdall.invoke('chronology:create', { name })
      toast.success('Chronology created')
      navigate('/chronologies')
    } catch (e) { toast.error((e as Error).message) }
  }

  // Top 5 active hypotheses by activity
  const topHypotheses = hypotheses
    .filter((h) => h.status === 'active')
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 5)

  // Recent 5 critiques
  const recentCritiques = critiques
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 5)

  // KAC checks with at least one vulnerable assumption, sorted by vulnerable count
  const vulnerableChecks = kacChecks
    .filter((c) => c.counts.vulnerable > 0)
    .sort((a, b) => b.counts.vulnerable - a.counts.vulnerable)
    .slice(0, 5)

  // Open estimates: overdue first, then by deadline ascending, then no-deadline last
  const now = Date.now()
  const openEstimates = estimates
    .filter((e) => e.status === 'open')
    .sort((a, b) => {
      const ad = a.deadline_at ?? Infinity
      const bd = b.deadline_at ?? Infinity
      return ad - bd
    })
    .slice(0, 5)
  const overdueCount = estimates.filter((e) => e.status === 'open' && e.deadline_at && e.deadline_at < now).length

  const recentComparisons = comparisons.slice(0, 4)
  const recentChronologies = chronologies.slice(0, 4)

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-7xl mx-auto space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold">Analyst Workspace</h1>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              One-glance view across the analytical surfaces. Click "Open" on any card to drill in.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={quickCreateHypothesis}>
              <Plus className="h-3 w-3 mr-1" /> Hypothesis
            </Button>
            <Button size="sm" variant="outline" onClick={quickCreateChronology}>
              <Plus className="h-3 w-3 mr-1" /> Chronology
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate('/comparisons')}>
              <Plus className="h-3 w-3 mr-1" /> Comparison
            </Button>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-md border border-red-500/30 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Top stat strip */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <StatPill label="Active hyp." value={hypotheses.filter((h) => h.status === 'active').length} />
          <StatPill label="Critiques" value={critiques.length} />
          <StatPill label="KAC checks" value={kacChecks.length} />
          <StatPill label="Open est." value={calibration?.open ?? 0} />
          <StatPill
            label="Overdue"
            value={overdueCount}
            color={overdueCount > 0 ? 'text-amber-600 dark:text-amber-400' : ''}
          />
          <StatPill
            label="Brier"
            value={calibration?.brier_score != null ? calibration.brier_score.toFixed(3) : '—'}
          />
        </div>

        {loading && (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading workspace…
          </div>
        )}

        {!loading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Hypotheses card */}
            <Card>
              <CardHeader className="pb-2">
                <SectionHeader icon={ListChecks} title="Active hypotheses" to="/hypotheses" count={hypotheses.filter((h) => h.status === 'active').length} />
              </CardHeader>
              <CardContent className="pt-0">
                {topHypotheses.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4">No active hypotheses. Create one to start the auto-evaluator.</div>
                ) : (
                  <div className="space-y-1.5">
                    {topHypotheses.map((h) => (
                      <Link key={h.id} to="/hypotheses" className="block rounded p-2 hover:bg-accent transition-colors">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{h.name}</div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {h.evidence_count} evidence · {h.supports_count}↑ {h.refutes_count}↓ · updated {formatRelativeTime(h.updated_at)}
                            </div>
                          </div>
                          <NetScoreBadge score={h.net_score} />
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Critiques card */}
            <Card>
              <CardHeader className="pb-2">
                <SectionHeader icon={ShieldOff} title="Recent critiques" to="/critiques" count={critiques.length} />
              </CardHeader>
              <CardContent className="pt-0">
                {recentCritiques.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4">No critiques yet. Run one from any hypothesis or comparison.</div>
                ) : (
                  <div className="space-y-1.5">
                    {recentCritiques.map((c) => (
                      <Link key={c.id} to="/critiques" className="block rounded p-2 hover:bg-accent transition-colors">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px] capitalize shrink-0">{c.parent_kind}</Badge>
                          <span className="flex-1 text-sm truncate">{c.parent_label || '(untitled)'}</span>
                          {c.status === 'generating' && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
                          {c.status === 'ready' && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                          {c.status === 'error' && <XCircle className="h-3 w-3 text-red-500" />}
                          <span className="text-[10px] text-muted-foreground">{formatRelativeTime(c.updated_at)}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Vulnerable assumptions card */}
            <Card>
              <CardHeader className="pb-2">
                <SectionHeader icon={ListTodo} title="Vulnerable assumptions" to="/assumptions" count={vulnerableChecks.length} />
              </CardHeader>
              <CardContent className="pt-0">
                {vulnerableChecks.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4">
                    {kacChecks.length === 0 ? 'No KAC checks yet.' : 'No assumptions currently flagged vulnerable. Good or untested.'}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {vulnerableChecks.map((k) => (
                      <Link key={k.id} to="/assumptions" className="block rounded p-2 hover:bg-accent transition-colors">
                        <div className="flex items-center gap-2">
                          <AlertOctagon className="h-3.5 w-3.5 text-red-500 shrink-0" />
                          <span className="flex-1 text-sm truncate">{k.name}</span>
                          <Badge className="text-[10px] bg-red-500/15 text-red-600 dark:text-red-400">
                            {k.counts.vulnerable} vuln
                          </Badge>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground pl-5">
                          {k.counts.well_supported} ok · {k.counts.supported_caveats} caveat · {k.counts.unsupported} untested
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Estimates / due soon card */}
            <Card>
              <CardHeader className="pb-2">
                <SectionHeader icon={Gauge} title="Estimates due soon" to="/estimates" count={openEstimates.length} />
              </CardHeader>
              <CardContent className="pt-0">
                {overdueCount > 0 && (
                  <div className="mb-2 flex items-center gap-2 p-2 rounded border border-amber-500/40 bg-amber-500/10 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    <span><strong>{overdueCount}</strong> overdue — resolve to keep calibration honest.</span>
                  </div>
                )}
                {openEstimates.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4">No open estimates.</div>
                ) : (
                  <div className="space-y-1.5">
                    {openEstimates.map((e) => {
                      const overdue = e.deadline_at != null && e.deadline_at < now
                      return (
                        <Link key={e.id} to="/estimates" className="block rounded p-2 hover:bg-accent transition-colors">
                          <div className="flex items-start gap-2">
                            <Badge className="text-[10px] bg-primary/15 text-primary shrink-0 mt-0.5">{WEP_PCT[e.wep]}%</Badge>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm truncate">{e.statement}</div>
                              <div className="mt-0.5 text-[10px] text-muted-foreground flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {e.deadline_at ? new Date(e.deadline_at).toISOString().slice(0, 10) : 'no deadline'}
                                {overdue && <span className="text-amber-600 dark:text-amber-400 font-medium">· OVERDUE</span>}
                              </div>
                            </div>
                          </div>
                        </Link>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Comparisons card */}
            <Card>
              <CardHeader className="pb-2">
                <SectionHeader icon={Scale} title="Recent comparisons" to="/comparisons" count={comparisons.length} />
              </CardHeader>
              <CardContent className="pt-0">
                {recentComparisons.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4">No comparisons yet.</div>
                ) : (
                  <div className="space-y-1.5">
                    {recentComparisons.map((c) => (
                      <Link key={c.id} to="/comparisons" className="block rounded p-2 hover:bg-accent transition-colors">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 text-sm truncate">{c.name}</span>
                          <Badge variant="outline" className="text-[10px]">{c.kind === 'entities' ? 'entities' : 'time'}</Badge>
                          {c.status === 'generating' && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
                          {c.status === 'ready' && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                          {c.status === 'error' && <XCircle className="h-3 w-3 text-red-500" />}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{formatRelativeTime(c.generated_at)}</div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Chronologies card */}
            <Card>
              <CardHeader className="pb-2">
                <SectionHeader icon={HistoryIcon} title="Recent chronologies" to="/chronologies" count={chronologies.length} />
              </CardHeader>
              <CardContent className="pt-0">
                {recentChronologies.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4">No chronologies yet.</div>
                ) : (
                  <div className="space-y-1.5">
                    {recentChronologies.map((c) => (
                      <Link key={c.id} to="/chronologies" className="block rounded p-2 hover:bg-accent transition-colors">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 text-sm truncate">{c.name}</span>
                          <Badge variant="outline" className="text-[10px]">{c.event_count} events</Badge>
                          <span className="text-[10px] text-muted-foreground">{formatRelativeTime(c.updated_at)}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
