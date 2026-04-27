import { useEffect, useState, useCallback } from 'react'
import { TrendingUp, Loader2, RefreshCw, Check, X, MinusCircle, AlertTriangle, Target, FileText, Award } from 'lucide-react'
import { Card } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'

/**
 * Forecast Accountability — Brier scores per WEP band + calibration curve.
 * The "did our forecasts come true?" page. Backed by ForecastAccountability
 * Service.
 */

interface ForecastClaim {
  id: string
  reportId: string
  reportTitle: string
  claimText: string
  wepTerm: string | null
  probabilityMidpoint: number | null
  confidenceLevel: string | null
  subjectEntity: string | null
  timeHorizon: string | null
  horizonEndsAt: number | null
  extractedAt: number
  outcome: string | null
  actualProbability: number | null
  brierScore: number | null
  isOverdue: boolean
}

interface Stats {
  totalClaims: number
  withOutcomes: number
  overall_brier: number | null
  by_wep: Array<{ wepTerm: string; count: number; avgBrier: number | null }>
  calibrationCurve: Array<{ predictedBucket: number; actualRate: number; n: number }>
}

const WEP_COLORS: Record<string, string> = {
  'almost no chance': 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  'very unlikely':    'bg-blue-500/10 text-blue-300 border-blue-500/30',
  'unlikely':         'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
  'roughly even chance': 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  'likely':           'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'very likely':      'bg-orange-500/10 text-orange-300 border-orange-500/30',
  'almost certainly': 'bg-red-500/10 text-red-300 border-red-500/30'
}

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  const delta = ts - Date.now()
  if (Math.abs(delta) < 60_000) return 'now'
  const future = delta > 0
  const abs = Math.abs(delta)
  if (abs < 3600_000) return `${future ? 'in ' : ''}${Math.floor(abs / 60_000)}m${future ? '' : ' ago'}`
  if (abs < 86400_000) return `${future ? 'in ' : ''}${Math.floor(abs / 3600_000)}h${future ? '' : ' ago'}`
  return `${future ? 'in ' : ''}${Math.floor(abs / 86400_000)}d${future ? '' : ' ago'}`
}

export function ForecastAccountabilityPage() {
  const [claims, setClaims] = useState<ForecastClaim[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'pending' | 'overdue' | 'scored'>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, s] = await Promise.all([
        window.heimdall.invoke('forecast:claims') as Promise<{ ok: boolean; claims?: ForecastClaim[] }>,
        window.heimdall.invoke('forecast:stats') as Promise<{ ok: boolean } & Stats>
      ])
      if (c.ok && c.claims) setClaims(c.claims)
      if (s.ok) setStats({
        totalClaims: s.totalClaims, withOutcomes: s.withOutcomes,
        overall_brier: s.overall_brier, by_wep: s.by_wep,
        calibrationCurve: s.calibrationCurve
      })
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const recordOutcome = async (claimId: string, outcome: 'occurred' | 'not_occurred' | 'partial' | 'undetermined') => {
    try {
      const r = await window.heimdall.invoke('forecast:record_outcome', { claimId, outcome }) as
        { ok: boolean; brierScore?: number; error?: string }
      if (r.ok) {
        toast.success(r.brierScore !== undefined ? `Recorded — Brier ${r.brierScore.toFixed(3)}` : 'Recorded')
        load()
      } else { toast.error(r.error || 'Failed') }
    } catch (err) { toast.error(String(err)) }
  }

  const autoRecord = async () => {
    toast.info('Scanning indicator hits for auto-record candidates…')
    try {
      const r = await window.heimdall.invoke('forecast:auto_record') as { ok: boolean; recorded?: number }
      if (r.ok) toast.success(`Auto-recorded ${r.recorded} outcome(s)`)
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const filtered = claims.filter((c) => {
    if (filter === 'pending') return c.outcome === null && !c.isOverdue
    if (filter === 'overdue') return c.isOverdue
    if (filter === 'scored') return c.outcome !== null
    return true
  })

  // Brier score interpretation
  const interpretBrier = (b: number | null) =>
    b === null ? '—' :
    b < 0.05 ? 'Excellent' :
    b < 0.15 ? 'Good' :
    b < 0.25 ? 'Fair' : 'Poor'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b border-border px-6 py-4 sticky top-0 bg-background z-10">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Award className="w-6 h-6 text-amber-400" />
            <div>
              <h1 className="text-xl font-semibold">Forecast Accountability</h1>
              <p className="text-xs text-muted-foreground">
                Did our predictions come true? Brier scores measure how well-calibrated our analyst+model is.
              </p>
            </div>
          </div>
          <Button onClick={autoRecord} size="sm" variant="outline">
            <RefreshCw className="w-4 h-4 mr-1" /> Auto-record from I&amp;W
          </Button>
        </div>

        {stats && (
          <div className="grid grid-cols-4 gap-2 text-xs">
            <Card className="px-3 py-2">
              <div className="text-muted-foreground">Total claims</div>
              <div className="text-2xl font-semibold">{stats.totalClaims}</div>
            </Card>
            <Card className="px-3 py-2">
              <div className="text-muted-foreground">With outcomes</div>
              <div className="text-2xl font-semibold">{stats.withOutcomes}</div>
            </Card>
            <Card className="px-3 py-2">
              <div className="text-muted-foreground">Overall Brier score</div>
              <div className={`text-2xl font-semibold ${
                stats.overall_brier === null ? 'text-muted-foreground' :
                stats.overall_brier < 0.15 ? 'text-emerald-300' :
                stats.overall_brier < 0.25 ? 'text-amber-300' : 'text-red-300'
              }`}>
                {stats.overall_brier !== null ? stats.overall_brier.toFixed(3) : '—'}
              </div>
              <div className="text-[9px] text-muted-foreground">{interpretBrier(stats.overall_brier)} (lower is better)</div>
            </Card>
            <Card className="px-3 py-2">
              <div className="text-muted-foreground">WEP bands used</div>
              <div className="text-2xl font-semibold">{stats.by_wep.length}</div>
            </Card>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Per-WEP Brier breakdown + calibration curve */}
        {stats && stats.by_wep.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <div className="px-4 py-2 border-b border-border">
                <div className="text-sm font-semibold">Brier by WEP band</div>
                <div className="text-[10px] text-muted-foreground">Lower = better calibration</div>
              </div>
              <div className="px-4 py-3 space-y-2">
                {stats.by_wep.map((band) => {
                  const filled = band.count
                  const colorClass = WEP_COLORS[band.wepTerm] || 'bg-slate-500/10 text-slate-300 border-slate-500/30'
                  return (
                    <div key={band.wepTerm} className="flex items-center gap-3 text-xs">
                      <Badge variant="outline" className={`text-[10px] capitalize w-44 justify-center ${colorClass}`}>
                        {band.wepTerm}
                      </Badge>
                      <span className="font-mono w-12 text-right">{filled}</span>
                      <span className="font-mono w-16 text-right text-muted-foreground">
                        {band.avgBrier !== null ? band.avgBrier.toFixed(3) : '—'}
                      </span>
                      <div className="flex-1 h-1.5 bg-card border border-border rounded-full overflow-hidden">
                        <div className={`h-full ${
                          band.avgBrier === null ? 'bg-slate-400/30' :
                          band.avgBrier < 0.15 ? 'bg-emerald-400' :
                          band.avgBrier < 0.25 ? 'bg-amber-400' : 'bg-red-400'
                        }`} style={{ width: band.avgBrier !== null ? `${Math.min(100, band.avgBrier * 200)}%` : '5%' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>

            <Card>
              <div className="px-4 py-2 border-b border-border">
                <div className="text-sm font-semibold">Calibration curve</div>
                <div className="text-[10px] text-muted-foreground">Predicted vs. actual rate. Diagonal = perfect.</div>
              </div>
              <div className="px-4 py-3">
                <svg viewBox="0 0 100 100" className="w-full h-48">
                  {/* axes */}
                  <line x1="10" y1="90" x2="100" y2="90" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                  <line x1="10" y1="0" x2="10" y2="90" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                  {/* perfect calibration diagonal */}
                  <line x1="10" y1="90" x2="100" y2="0" stroke="rgba(34,197,94,0.4)" strokeWidth="0.5" strokeDasharray="2,2" />
                  {/* actual data points */}
                  {stats.calibrationCurve.map((p, i) => {
                    const x = 10 + p.predictedBucket * 90
                    const y = 90 - p.actualRate * 90
                    const radius = Math.max(1, Math.min(4, Math.log10(p.n + 1) * 2))
                    return (
                      <circle key={i} cx={x} cy={y} r={radius} fill="#06b6d4" opacity={0.8}>
                        <title>predicted {Math.round(p.predictedBucket * 100)}% → actual {Math.round(p.actualRate * 100)}% (n={p.n})</title>
                      </circle>
                    )
                  })}
                  {/* axis labels */}
                  <text x="55" y="99" textAnchor="middle" fontSize="3" fill="rgba(255,255,255,0.5)">Predicted probability</text>
                </svg>
                {stats.calibrationCurve.length === 0 && (
                  <p className="text-xs text-muted-foreground italic text-center py-8">
                    No outcomes recorded yet. Record some forecasts as occurred/not_occurred to build the calibration curve.
                  </p>
                )}
              </div>
            </Card>
          </div>
        )}

        {/* Filter chips */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Show:</span>
          {(['all', 'pending', 'overdue', 'scored'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-[10px] px-3 py-1 rounded border capitalize transition-colors ${
                filter === f ? 'bg-amber-500/20 text-amber-200 border-amber-500/40'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}>
              {f}
              {f === 'overdue' && claims.filter((c) => c.isOverdue).length > 0 && (
                <Badge variant="outline" className="ml-1 text-[9px] bg-red-500/20 text-red-200 border-red-500/30">
                  {claims.filter((c) => c.isOverdue).length}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {loading && <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}
        {!loading && filtered.length === 0 && (
          <div className="text-center text-muted-foreground py-12">
            <Target className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No claims match this filter.</p>
            <p className="text-xs mt-2 opacity-70">Forecast claims are extracted automatically when reports are published.</p>
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((c) => (
              <Card key={c.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {c.wepTerm && (
                        <Badge variant="outline" className={`text-[10px] capitalize ${WEP_COLORS[c.wepTerm]}`}>
                          {c.wepTerm} ({Math.round((c.probabilityMidpoint || 0) * 100)}%)
                        </Badge>
                      )}
                      {c.confidenceLevel && (
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {c.confidenceLevel} confidence
                        </Badge>
                      )}
                      {c.timeHorizon && (
                        <span className="text-[10px] text-muted-foreground font-mono">⏱ {c.timeHorizon}</span>
                      )}
                      {c.isOverdue && (
                        <Badge variant="outline" className="text-[10px] bg-red-500/10 text-red-300 border-red-500/30">
                          <AlertTriangle className="w-3 h-3 mr-1 inline" /> overdue
                        </Badge>
                      )}
                      {c.outcome && (
                        <Badge variant="outline" className={`text-[10px] capitalize ${
                          c.outcome === 'occurred' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                          : c.outcome === 'not_occurred' ? 'bg-red-500/10 text-red-300 border-red-500/30'
                          : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        }`}>
                          {c.outcome.replace('_', ' ')}
                        </Badge>
                      )}
                      {c.brierScore !== null && (
                        <span className="text-[10px] font-mono text-muted-foreground">Brier {c.brierScore.toFixed(3)}</span>
                      )}
                    </div>
                    <p className="text-sm">{c.claimText}</p>
                    <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2">
                      <FileText className="w-2.5 h-2.5" />
                      <span className="truncate">{c.reportTitle}</span>
                      {c.horizonEndsAt && <span>· horizon {formatTime(c.horizonEndsAt)}</span>}
                    </div>
                  </div>
                  {!c.outcome && (
                    <div className="flex flex-col gap-1 items-end shrink-0">
                      <Button size="sm" variant="outline" onClick={() => recordOutcome(c.id, 'occurred')} className="h-6 text-[10px] text-emerald-300">
                        <Check className="w-3 h-3 mr-1" /> Occurred
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => recordOutcome(c.id, 'not_occurred')} className="h-6 text-[10px] text-red-300">
                        <X className="w-3 h-3 mr-1" /> Did not
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => recordOutcome(c.id, 'undetermined')} className="h-6 text-[10px] text-muted-foreground">
                        <MinusCircle className="w-3 h-3 mr-1" /> Unclear
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
