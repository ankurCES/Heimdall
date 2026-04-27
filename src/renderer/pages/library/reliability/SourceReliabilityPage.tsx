import { useEffect, useState, useCallback } from 'react'
import { Server, Loader2, RefreshCw, ChevronRight, X, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'

/**
 * Source Reliability page — every source's track record + Admiralty
 * rating computed from its claim history. Click a source to see its
 * recent claims with confirm/contradict status.
 */

interface Source {
  sourceKey: string
  displayName: string | null
  currentRating: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
  currentScore: number
  totalClaims: number
  confirmedClaims: number
  contradictedClaims: number
  unverifiedClaims: number
  lastEvaluatedAt: number | null
}

interface Claim {
  id: string
  claimText: string
  status: string
  assertedAt: number
  evaluatedAt: number | null
}

const RATING_COLORS: Record<string, string> = {
  A: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
  B: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  C: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  D: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
  E: 'bg-red-500/10 text-red-300 border-red-500/30',
  F: 'bg-slate-500/10 text-slate-400 border-slate-500/30'
}

const RATING_LABELS: Record<string, string> = {
  A: 'Completely reliable', B: 'Usually reliable', C: 'Fairly reliable',
  D: 'Not usually reliable', E: 'Unreliable', F: 'Cannot be judged'
}

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  if (delta < 7 * 86400_000) return `${Math.floor(delta / 86400_000)}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}

export function SourceReliabilityPage() {
  const [sources, setSources] = useState<Source[]>([])
  const [stats, setStats] = useState<{ totalSources: number; byRating: Record<string, number> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [recomputing, setRecomputing] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [claims, setClaims] = useState<Claim[]>([])
  const [ratingFilter, setRatingFilter] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, st] = await Promise.all([
        window.heimdall.invoke('sources:reliability_list', {
          ratings: ratingFilter.size > 0 ? Array.from(ratingFilter) : undefined
        }) as Promise<{ ok: boolean; sources?: Source[] }>,
        window.heimdall.invoke('sources:reliability_stats') as Promise<{ ok: boolean; totalSources: number; byRating: Record<string, number> }>
      ])
      if (list.ok) setSources(list.sources || [])
      if (st.ok) setStats({ totalSources: st.totalSources, byRating: st.byRating })
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [ratingFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!selectedKey) { setClaims([]); return }
    (async () => {
      try {
        const r = await window.heimdall.invoke('sources:reliability_claims', selectedKey) as { ok: boolean; claims?: Claim[] }
        if (r.ok) setClaims(r.claims || [])
      } catch { /* */ }
    })()
  }, [selectedKey])

  const recompute = async () => {
    setRecomputing(true)
    toast.info('Recomputing all source ratings…')
    try {
      const r = await window.heimdall.invoke('sources:reliability_recompute') as { ok: boolean; updated?: number }
      if (r.ok) toast.success(`Recomputed ${r.updated} source ratings`)
    } catch (err) { toast.error(String(err)) }
    setRecomputing(false)
    load()
  }

  const toggle = (set: Set<string>, value: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value); else next.add(value)
    setter(next)
  }

  const markClaim = async (claimId: string, status: 'confirmed' | 'contradicted') => {
    try {
      await window.heimdall.invoke('sources:reliability_mark', { claimId, status })
      toast.success(`Claim marked ${status}`)
      // reload claims
      if (selectedKey) {
        const r = await window.heimdall.invoke('sources:reliability_claims', selectedKey) as { ok: boolean; claims?: Claim[] }
        if (r.ok) setClaims(r.claims || [])
      }
    } catch (err) { toast.error(String(err)) }
  }

  const selected = sources.find((s) => s.sourceKey === selectedKey) ?? null

  return (
    <div className="flex h-full">
      <div className={`${selectedKey ? 'w-1/2' : 'w-full'} flex flex-col border-r border-border transition-all`}>
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3">
              <Server className="w-6 h-6 text-blue-400" />
              <div>
                <h1 className="text-xl font-semibold">Source Reliability</h1>
                <p className="text-xs text-muted-foreground">
                  Live Admiralty ratings from each source's claim history.
                </p>
              </div>
            </div>
            <Button onClick={recompute} disabled={recomputing} size="sm">
              {recomputing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Recompute now
            </Button>
          </div>
          {stats && (
            <div className="grid grid-cols-7 gap-2 text-xs">
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Sources</div>
                <div className="text-lg font-semibold">{stats.totalSources}</div>
              </div>
              {(['A', 'B', 'C', 'D', 'E', 'F'] as const).map((r) => (
                <div key={r} className={`border rounded px-3 py-2 ${RATING_COLORS[r]}`}>
                  <div className="text-muted-foreground text-[10px]">Rating {r}</div>
                  <div className="text-lg font-semibold">{stats.byRating[r] || 0}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-3 flex-wrap text-xs">
            <span className="text-muted-foreground">Filter:</span>
            {(['A', 'B', 'C', 'D', 'E', 'F'] as const).map((r) => (
              <button key={r} onClick={() => toggle(ratingFilter, r, setRatingFilter)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${ratingFilter.has(r) ? RATING_COLORS[r] : 'border-border text-muted-foreground hover:bg-accent'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}
          {!loading && sources.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <Server className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No source reliability data yet.</p>
              <p className="text-xs mt-2 opacity-70">Sources accumulate claims as collectors run; ratings are recomputed nightly.</p>
            </div>
          )}
          {sources.length > 0 && (
            <div className="divide-y divide-border">
              {sources.map((s) => (
                <button key={s.sourceKey}
                  onClick={() => setSelectedKey(s.sourceKey === selectedKey ? null : s.sourceKey)}
                  className={`w-full text-left px-6 py-3 hover:bg-accent/30 flex items-start gap-3 ${selectedKey === s.sourceKey ? 'bg-accent/40 border-l-2 border-l-blue-400' : ''}`}
                >
                  <div className="w-8 text-center">
                    <Badge className={`text-base font-bold ${RATING_COLORS[s.currentRating]}`}>{s.currentRating}</Badge>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{s.displayName || s.sourceKey}</div>
                    <div className="text-xs text-muted-foreground">
                      {RATING_LABELS[s.currentRating]} · score {s.currentScore.toFixed(2)} ·
                      {' '}{s.totalClaims} claims
                      {s.confirmedClaims > 0 && <span className="text-emerald-300"> · {s.confirmedClaims} confirmed</span>}
                      {s.contradictedClaims > 0 && <span className="text-red-300"> · {s.contradictedClaims} contradicted</span>}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="w-1/2 flex flex-col">
          <div className="border-b border-border px-6 py-4 flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Badge className={`text-base font-bold ${RATING_COLORS[selected.currentRating]}`}>{selected.currentRating}</Badge>
                <h2 className="text-lg font-semibold truncate">{selected.displayName || selected.sourceKey}</h2>
              </div>
              <p className="text-xs text-muted-foreground">{RATING_LABELS[selected.currentRating]} · last evaluated {formatTime(selected.lastEvaluatedAt)}</p>
              <div className="grid grid-cols-4 gap-2 mt-3 text-xs">
                <div className="border border-border rounded px-2 py-1.5">
                  <div className="text-muted-foreground">Total</div>
                  <div className="font-semibold">{selected.totalClaims}</div>
                </div>
                <div className="border border-border rounded px-2 py-1.5">
                  <div className="text-muted-foreground">Confirmed</div>
                  <div className="font-semibold text-emerald-300">{selected.confirmedClaims}</div>
                </div>
                <div className="border border-border rounded px-2 py-1.5">
                  <div className="text-muted-foreground">Contradicted</div>
                  <div className="font-semibold text-red-300">{selected.contradictedClaims}</div>
                </div>
                <div className="border border-border rounded px-2 py-1.5">
                  <div className="text-muted-foreground">Unverified</div>
                  <div className="font-semibold text-slate-400">{selected.unverifiedClaims}</div>
                </div>
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelectedKey(null)}><X className="w-3.5 h-3.5" /></Button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="text-xs text-muted-foreground mb-2 uppercase">Recent claims ({claims.length})</div>
            {claims.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No claims yet from this source.</p>
            ) : (
              <div className="space-y-2">
                {claims.map((c) => (
                  <div key={c.id} className="border border-border rounded p-3 text-sm">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Clock className="w-3 h-3" />
                      <span>{formatTime(c.assertedAt)}</span>
                      <Badge variant="outline" className={`text-[9px] ${
                        c.status === 'confirmed' ? 'text-emerald-300 border-emerald-500/30'
                        : c.status === 'contradicted' ? 'text-red-300 border-red-500/30'
                        : 'text-amber-300 border-amber-500/30'
                      }`}>
                        {c.status}
                      </Badge>
                    </div>
                    <div className="text-xs">{c.claimText}</div>
                    {c.status === 'unverified' && (
                      <div className="flex gap-1 mt-2">
                        <Button size="sm" variant="outline" onClick={() => markClaim(c.id, 'confirmed')}
                          className="h-6 text-[10px] text-emerald-300">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => markClaim(c.id, 'contradicted')}
                          className="h-6 text-[10px] text-red-300">
                          <XCircle className="w-3 h-3 mr-1" /> Contradict
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
