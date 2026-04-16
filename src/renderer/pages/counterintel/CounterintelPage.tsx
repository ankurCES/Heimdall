import { useEffect, useState } from 'react'
import { ShieldAlert, RefreshCw, Loader2, Radio, FileWarning, Flag, AlertTriangle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

interface DeceptionFlag { code: string; severity: 'low' | 'med' | 'high'; points: number; reason: string }

interface SuspiciousReport {
  report_id: string; title: string; source_name: string; discipline: string;
  severity: string; created_at: number; overall_score: number; flag_count: number; flags: DeceptionFlag[]
}

interface StateMediaReport {
  report_id: string; title: string; source_name: string; source_url: string | null;
  discipline: string; severity: string; created_at: number;
  bias_direction: string; bias_note: string | null
}

interface CounterintelRun {
  id: number; started_at: number; finished_at: number;
  reports_scored: number; avg_score: number; high_flag_count: number; duration_ms: number
}

interface BiasFlag { id: string; match_type: string; match_value: string; bias_direction: string; note: string | null }

type Tab = 'suspicious' | 'state_media' | 'bias_list' | 'source_trust'

interface SourceTrust {
  source_id: string
  reliability_grade: string
  deception_hits: number
  last_demoted_at: number | null
  demotion_reason: string | null
  original_grade: string | null
}

const SEVERITY_BADGE: Record<string, string> = {
  high: 'bg-red-500/15 border-red-500/40 text-red-300',
  med: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
  low: 'bg-slate-500/15 border-slate-500/40 text-slate-300'
}

const BIAS_COLOR: Record<string, string> = {
  'pro-kremlin': 'bg-red-500/15 border-red-500/40 text-red-300',
  'pro-beijing': 'bg-amber-500/15 border-amber-500/40 text-amber-300',
  'pro-tehran': 'bg-green-500/15 border-green-500/40 text-green-300',
  'pro-pyongyang': 'bg-blue-500/15 border-blue-500/40 text-blue-300',
  'pro-hezbollah': 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  'pro-ankara': 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
}

export function CounterintelPage() {
  const [run, setRun] = useState<CounterintelRun | null>(null)
  const [tab, setTab] = useState<Tab>('suspicious')
  const [suspicious, setSuspicious] = useState<SuspiciousReport[]>([])
  const [stateMedia, setStateMedia] = useState<StateMediaReport[]>([])
  const [biasList, setBiasList] = useState<BiasFlag[]>([])
  const [sourceTrust, setSourceTrust] = useState<SourceTrust[]>([])
  const [selected, setSelected] = useState<SuspiciousReport | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setError(null)
    try {
      const [latest, top, sm, bias, trust] = await Promise.all([
        window.heimdall.invoke('ci:latest'),
        window.heimdall.invoke('ci:top', { limit: 100 }),
        window.heimdall.invoke('ci:state_media', { limit: 100 }),
        window.heimdall.invoke('ci:bias_list'),
        window.heimdall.invoke('tradecraft:source_trust')
      ]) as [CounterintelRun | null, SuspiciousReport[], StateMediaReport[], BiasFlag[], SourceTrust[]]
      setRun(latest); setSuspicious(top); setStateMedia(sm); setBiasList(bias); setSourceTrust(trust)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function analyze(rescoreAll = false) {
    setAnalyzing(true)
    setError(null)
    try {
      await window.heimdall.invoke('ci:analyze', { rescore_all: rescoreAll })
      setSelected(null)
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setAnalyzing(false)
    }
  }

  const empty = !run || run.reports_scored === 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Counter-intelligence</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Linguistic deception scoring over report content (hedges,
            over-precision, unqualified certainty, passive-voice overuse,
            emotional loading, zero attribution) plus flagging of reports
            from known state-aligned sources. Complements STANAG 2511
            source reliability — that rates the <em>source</em>; these flags
            rate the <em>text</em>.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void analyze(false)} disabled={analyzing} variant="outline">
            {analyzing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Score new
          </Button>
          <Button onClick={() => void analyze(true)} disabled={analyzing}>
            {analyzing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Re-score all
          </Button>
        </div>
      </div>

      {/* Run stats */}
      <div className="px-6 py-3 border-b border-border">
        <Card>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Stat label="Reports scored" value={run?.reports_scored ?? 0} />
            <Stat label="Avg score" value={run?.avg_score != null ? run.avg_score.toFixed(1) : '—'} />
            <Stat
              label="High-flag (≥40)"
              value={run?.high_flag_count ?? 0}
              hint={run?.reports_scored ? `${((run.high_flag_count / run.reports_scored) * 100).toFixed(1)}% of scored` : undefined}
            />
            <Stat label="Duration" value={run?.duration_ms != null ? `${run.duration_ms} ms` : '—'} />
            <Stat label="Last run" value={run ? formatRelativeTime(run.finished_at) : 'never'} />
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      {/* Tabs */}
      <div className="px-6 pt-3 border-b border-border flex items-center gap-1">
        <TabBtn active={tab === 'suspicious'} onClick={() => setTab('suspicious')} icon={FileWarning} label={`Most flagged (${suspicious.length})`} />
        <TabBtn active={tab === 'state_media'} onClick={() => setTab('state_media')} icon={Radio} label={`State-aligned sources (${stateMedia.length})`} />
        <TabBtn active={tab === 'bias_list'} onClick={() => setTab('bias_list')} icon={Flag} label={`Bias watchlist (${biasList.length})`} />
        <TabBtn active={tab === 'source_trust'} onClick={() => setTab('source_trust')} icon={ShieldAlert} label={`Source trust (${sourceTrust.length})`} />
      </div>

      {empty && !analyzing && tab !== 'bias_list' ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <Card className="max-w-md">
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              <ShieldAlert className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>No deception scores yet. Click <strong>Score new</strong> to analyze the current corpus.</p>
              <p className="text-xs mt-2 opacity-70">
                On ~20k reports expect the batch to finish in seconds — the heuristics are pure regex + word counts.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : tab === 'suspicious' ? (
        <div className="flex-1 overflow-hidden flex">
          <div className="w-1/2 border-r border-border overflow-auto">
            {suspicious.map((r) => (
              <button
                key={r.report_id}
                onClick={() => setSelected(r)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b border-border/40 text-sm hover:bg-accent/30',
                  selected?.report_id === r.report_id && 'bg-accent/50'
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={cn(
                    'shrink-0 h-8 w-12 rounded flex items-center justify-center text-xs font-mono font-bold border',
                    r.overall_score >= 60 ? 'bg-red-500/15 border-red-500/40 text-red-300' :
                    r.overall_score >= 40 ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' :
                    r.overall_score >= 20 ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300' :
                    'bg-slate-500/15 border-slate-500/40 text-slate-300'
                  )}>
                    {r.overall_score}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{r.title}</div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{r.discipline}</Badge>
                      <span className="text-[10px] text-muted-foreground">{r.source_name}</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">{formatRelativeTime(r.created_at)}</span>
                    </div>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {r.flags.slice(0, 4).map((f) => (
                        <span key={f.code} className={cn(
                          'text-[9px] px-1 py-0.5 rounded border font-mono',
                          SEVERITY_BADGE[f.severity] || SEVERITY_BADGE.low
                        )}>
                          {f.code}
                        </span>
                      ))}
                      {r.flags.length > 4 && <span className="text-[9px] text-muted-foreground">+{r.flags.length - 4}</span>}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto">
            {selected ? (
              <div className="p-6 space-y-4">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="font-mono">{selected.discipline}</Badge>
                    <Badge variant="outline">{selected.severity}</Badge>
                    <span className="text-xs text-muted-foreground ml-2">{selected.source_name}</span>
                  </div>
                  <h2 className="text-lg font-semibold mt-1.5">{selected.title}</h2>
                  <p className="text-xs text-muted-foreground mt-1 font-mono">{selected.report_id}</p>
                </div>

                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2 flex-wrap">
                      <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-sm">Overall deception score</CardTitle>
                      <div className={cn(
                        'px-2 py-0.5 rounded font-mono font-bold border ml-auto',
                        selected.overall_score >= 60 ? 'bg-red-500/15 border-red-500/40 text-red-300' :
                        selected.overall_score >= 40 ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' :
                        'bg-slate-500/15 border-slate-500/40 text-slate-300'
                      )}>
                        {selected.overall_score} / 100
                      </div>
                    </div>
                    <CardDescription className="text-xs">
                      Sum of individual heuristic flag points, capped at 100. No single flag is decisive —
                      analyst review required.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {selected.flags.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No flags raised.</p>
                    ) : (
                      <ul className="space-y-2">
                        {selected.flags.map((f) => (
                          <li key={f.code} className="flex items-start gap-2 text-xs p-2 rounded border border-border bg-card/30">
                            <span className={cn(
                              'shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border',
                              SEVERITY_BADGE[f.severity] || SEVERITY_BADGE.low
                            )}>
                              {f.severity.toUpperCase()}
                            </span>
                            <div className="flex-1">
                              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">{f.code}</div>
                              <div>{f.reason}</div>
                            </div>
                            <span className="shrink-0 text-muted-foreground font-mono">+{f.points}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <FileWarning className="h-10 w-10 mb-2 opacity-30" />
                <p className="text-sm">Select a report to see its flag breakdown</p>
              </div>
            )}
          </div>
        </div>
      ) : tab === 'state_media' ? (
        <div className="flex-1 overflow-auto">
          {stateMedia.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No reports from state-aligned sources in the current corpus.
            </div>
          ) : (
            <div>
              {stateMedia.map((r) => (
                <div key={r.report_id} className="px-6 py-3 border-b border-border/40 hover:bg-accent/20">
                  <div className="flex items-start gap-3">
                    <span className={cn(
                      'shrink-0 text-[10px] px-2 py-0.5 rounded font-mono font-bold border uppercase tracking-wider',
                      BIAS_COLOR[r.bias_direction] || 'bg-muted text-muted-foreground border-border'
                    )}>
                      {r.bias_direction.replace(/^pro-/, '')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{r.title}</div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap text-[10px] text-muted-foreground">
                        <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{r.discipline}</Badge>
                        <span>{r.source_name}</span>
                        {r.bias_note && <span className="italic">— {r.bias_note}</span>}
                        <span className="ml-auto">{formatRelativeTime(r.created_at)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Flag className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">State-media bias watchlist</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Sources known to be aligned with a state position per Freedom House, RSF, EU vs Disinfo,
                and Stanford Internet Observatory assessments. Matches are <em>case-insensitive substrings</em>
                on either <code className="font-mono">source_name</code> or <code className="font-mono">source_url</code>.
                Seeded from code on first launch; extend via direct DB edit for now.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left py-2 font-medium">Direction</th>
                    <th className="text-left py-2 font-medium">Match type</th>
                    <th className="text-left py-2 font-medium">Value</th>
                    <th className="text-left py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {biasList.map((b) => (
                    <tr key={b.id} className="border-b border-border/40">
                      <td className="py-1.5">
                        <span className={cn(
                          'text-[10px] px-2 py-0.5 rounded font-mono font-bold border uppercase tracking-wider',
                          BIAS_COLOR[b.bias_direction] || 'bg-muted text-muted-foreground border-border'
                        )}>
                          {b.bias_direction.replace(/^pro-/, '')}
                        </span>
                      </td>
                      <td className="py-1.5 text-xs text-muted-foreground font-mono">{b.match_type}</td>
                      <td className="py-1.5 text-xs font-mono">{b.match_value}</td>
                      <td className="py-1.5 text-xs text-muted-foreground italic">{b.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'source_trust' && (
        <div className="flex-1 overflow-auto p-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Source trust ledger</CardTitle>
              </div>
              <CardDescription className="text-xs">
                STANAG 2511 reliability grades, with auto-downgrade every 3
                high-severity deception hits. Demoting a source here haircuts
                every report's verification score by 30% and logs the event
                to credibility_events + the audit chain.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {sourceTrust.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No sources tracked yet — the ledger populates on the first deception hit.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left py-2 font-medium">Source ID</th>
                      <th className="text-left py-2 font-medium">Grade</th>
                      <th className="text-right py-2 font-medium">Deception hits</th>
                      <th className="text-left py-2 font-medium">Demoted</th>
                      <th className="text-left py-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sourceTrust.map((s) => (
                      <tr key={s.source_id} className="border-b border-border/40">
                        <td className="py-1.5 text-xs font-mono">{s.source_id}</td>
                        <td className="py-1.5">
                          <span className={cn(
                            'text-[10px] px-2 py-0.5 rounded font-mono font-bold border',
                            s.reliability_grade === 'A' || s.reliability_grade === 'B'
                              ? 'border-emerald-500/40 text-emerald-300'
                              : s.reliability_grade === 'C' || s.reliability_grade === 'D'
                              ? 'border-amber-500/40 text-amber-300'
                              : 'border-red-500/40 text-red-300'
                          )}>{s.reliability_grade}{s.original_grade && s.original_grade !== s.reliability_grade ? ` (was ${s.original_grade})` : ''}</span>
                        </td>
                        <td className="py-1.5 text-right text-xs font-mono">{s.deception_hits}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">
                          {s.last_demoted_at ? formatRelativeTime(s.last_demoted_at) : '—'}
                        </td>
                        <td className="py-1.5 text-xs text-muted-foreground italic">{s.demotion_reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-semibold font-mono">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5 italic">{hint}</div>}
    </div>
  )
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Flag; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-2 text-xs border-b-2 -mb-px flex items-center gap-1.5',
        active ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}
