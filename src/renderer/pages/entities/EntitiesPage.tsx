import { useEffect, useState } from 'react'
import { Users, RefreshCw, Loader2, Tag, FileText, ChevronRight, Clock } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

interface CanonicalEntity {
  id: string
  entity_type: string
  canonical_value: string
  normalized_value: string
  alias_count: number
  mention_count: number
}

interface AliasRow {
  entity_value: string
  mention_count: number
}

interface ReportRow {
  report_id: string
  mention_count: number
}

interface PolGrid {
  entity_id: string
  canonical_value: string | null
  entity_type: string | null
  window_days: number
  total_mentions: number
  grid: number[][]
  day_totals: number[]
  hour_totals: number[]
  peak_cell: number
}

interface ResolutionRun {
  id: number
  started_at: number
  finished_at: number
  raw_count: number
  cluster_count: number
  similarity_threshold: number
  duration_ms: number
}

/**
 * Theme 4.6 — canonical entities page.
 *
 * Rolls raw intel_entities rows into resolved identities via the
 * EntityResolutionService and exposes:
 *   - top entities by mention count (filterable by type)
 *   - per-entity alias explorer (raw variants collapsed into one identity)
 *   - per-entity report list (where the identity was mentioned)
 */
export function EntitiesPage() {
  const [run, setRun] = useState<ResolutionRun | null>(null)
  const [types, setTypes] = useState<Array<{ entity_type: string; count: number }>>([])
  const [activeType, setActiveType] = useState<string | null>(null)
  const [top, setTop] = useState<CanonicalEntity[]>([])
  const [selected, setSelected] = useState<CanonicalEntity | null>(null)
  const [aliases, setAliases] = useState<AliasRow[]>([])
  const [reports, setReports] = useState<ReportRow[]>([])
  const [pol, setPol] = useState<PolGrid | null>(null)
  const [resolving, setResolving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [latest, typesRows] = await Promise.all([
        window.heimdall.invoke('entity:latest'),
        window.heimdall.invoke('entity:types')
      ]) as [ResolutionRun | null, Array<{ entity_type: string; count: number }>]
      setRun(latest)
      setTypes(typesRows)
      await loadTop(activeType)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  async function loadTop(type: string | null) {
    try {
      const rows = await window.heimdall.invoke('entity:top', { type, limit: 100 }) as CanonicalEntity[]
      setTop(rows)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function runResolve() {
    setResolving(true)
    setError(null)
    try {
      await window.heimdall.invoke('entity:resolve')
      await loadAll()
      if (selected) {
        // Selection may have been renamed or merged — clear it.
        setSelected(null); setAliases([]); setReports([])
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setResolving(false)
    }
  }

  const selectEntity = async (e: CanonicalEntity) => {
    setSelected(e)
    setAliases([]); setReports([]); setPol(null)
    try {
      const [a, r, p] = await Promise.all([
        window.heimdall.invoke('entity:aliases', e.id),
        window.heimdall.invoke('entity:reports', { id: e.id, limit: 25 }),
        window.heimdall.invoke('entity:pol', { id: e.id, window_days: 90 })
      ]) as [AliasRow[], ReportRow[], PolGrid]
      setAliases(a)
      setReports(r)
      setPol(p)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const switchType = async (type: string | null) => {
    setActiveType(type)
    setSelected(null); setAliases([]); setReports([])
    await loadTop(type)
  }

  const empty = !run || run.cluster_count === 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Entity Resolution</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Aliases of the same real-world identity collapsed across the intel corpus.
            Clustering uses Jaro-Winkler similarity (with name normalisation
            and per-type thresholds) and a union-find to merge near-duplicates.
            Exact-structure types (IP, hash, email, CVE, URL) never fuzzy-merge.
          </p>
        </div>
        <Button onClick={runResolve} disabled={resolving}>
          {resolving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          {run ? 'Re-resolve' : 'Run resolution'}
        </Button>
      </div>

      {/* Run stats */}
      <div className="px-6 py-3 border-b border-border">
        <Card>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Stat label="Raw entities" value={run?.raw_count ?? 0} />
            <Stat label="Canonical identities" value={run?.cluster_count ?? 0} />
            <Stat
              label="Collapse ratio"
              value={run && run.raw_count > 0
                ? `${((1 - run.cluster_count / run.raw_count) * 100).toFixed(1)}%`
                : '—'}
              hint="how much we merged"
            />
            <Stat label="Duration" value={run?.duration_ms != null ? `${run.duration_ms} ms` : '—'} />
            <Stat label="Last run" value={run ? formatRelativeTime(run.finished_at) : 'never'} />
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">
          {error}
        </div>
      )}

      {empty && !loading ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <Card className="max-w-md">
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>No canonical entities yet. Click <strong>Run resolution</strong> to cluster raw extracted entities.</p>
              <p className="text-xs mt-2 opacity-70">
                Entities come from <code className="font-mono">intel_entities</code>, populated by the regex extractors
                in <code className="font-mono">IntelEnricher</code> whenever reports are enriched.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex">
          {/* Left — filter + list */}
          <div className="w-1/2 border-r border-border flex flex-col overflow-hidden">
            {/* Type chips */}
            <div className="p-3 border-b border-border flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => void switchType(null)}
                className={cn(
                  'text-xs px-2 py-1 rounded border',
                  activeType === null
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent/30'
                )}
              >All types</button>
              {types.map((t) => (
                <button
                  key={t.entity_type}
                  onClick={() => void switchType(t.entity_type)}
                  className={cn(
                    'text-xs px-2 py-1 rounded border font-mono',
                    activeType === t.entity_type
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent/30'
                  )}
                >
                  {t.entity_type} <span className="opacity-70">({t.count})</span>
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto">
              {top.map((e) => (
                <button
                  key={e.id}
                  onClick={() => void selectEntity(e)}
                  className={cn(
                    'w-full text-left px-4 py-2 border-b border-border/40 text-sm hover:bg-accent/30 flex items-center gap-3',
                    selected?.id === e.id && 'bg-accent/50'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{e.canonical_value}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{e.entity_type}</Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {e.alias_count} alias{e.alias_count === 1 ? '' : 'es'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-mono font-semibold">{e.mention_count}</div>
                    <div className="text-[9px] text-muted-foreground uppercase tracking-wider">mentions</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              ))}
              {top.length === 0 && (
                <div className="p-6 text-center text-xs text-muted-foreground">No entities for this type.</div>
              )}
            </div>
          </div>

          {/* Right — detail pane */}
          <div className="flex-1 overflow-auto">
            {selected ? (
              <div className="p-6 space-y-4">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="font-mono">{selected.entity_type}</Badge>
                    <h2 className="text-lg font-semibold">{selected.canonical_value}</h2>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Normalised: <code className="font-mono">{selected.normalized_value}</code>
                    <span className="mx-2">·</span>
                    <code className="font-mono">{selected.id}</code>
                  </p>
                </div>

                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                      <CardTitle className="text-sm">Aliases rolled up</CardTitle>
                    </div>
                    <CardDescription className="text-xs">
                      Every raw <code className="font-mono">intel_entities</code> row whose normalized value
                      landed in this cluster.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {aliases.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Loading…</p>
                    ) : (
                      <ul className="space-y-1">
                        {aliases.map((a) => (
                          <li key={a.entity_value} className="flex items-center gap-2 text-xs py-1 border-b border-border/30 last:border-0">
                            <span className="flex-1 truncate">{a.entity_value}</span>
                            <span className="font-mono text-muted-foreground">{a.mention_count}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <CardTitle className="text-sm">Pattern of life</CardTitle>
                    </div>
                    <CardDescription className="text-xs">
                      Mention density by day-of-week × hour-of-day over the last {pol?.window_days ?? 90} days
                      (local time). {pol?.total_mentions ?? 0} total mentions, peak cell {pol?.peak_cell ?? 0}.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {pol && pol.total_mentions > 0 ? (
                      <PolHeatmap grid={pol.grid} peak={pol.peak_cell} />
                    ) : (
                      <p className="text-xs text-muted-foreground">No mentions in the window — pattern will appear once the entity has ≥1 timestamped report.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      <CardTitle className="text-sm">Mentioned in reports</CardTitle>
                    </div>
                    <CardDescription className="text-xs">
                      Top 25 reports that contain this identity.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {reports.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No reports matched.</p>
                    ) : (
                      <ul className="space-y-0.5">
                        {reports.map((r) => (
                          <li key={r.report_id} className="flex items-center gap-2 text-xs py-1 border-b border-border/30 last:border-0 font-mono">
                            <span className="flex-1 truncate">{r.report_id}</span>
                            <span className="text-muted-foreground">{r.mention_count} mention{r.mention_count === 1 ? '' : 's'}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Users className="h-10 w-10 mb-2 opacity-30" />
                <p className="text-sm">Select an entity to see its aliases and reports</p>
              </div>
            )}
          </div>
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

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * 7×24 heatmap. Peak-normalised amber gradient — analyst can eyeball the
 * "working hours" shape (weekday 9-17 spike) vs coordinated-inauthentic
 * patterns (uniform, or graveyard-shift clustering).
 */
function PolHeatmap({ grid, peak }: { grid: number[][]; peak: number }) {
  const hours = Array.from({ length: 24 }, (_, i) => i)
  return (
    <div className="space-y-1">
      <div className="flex gap-[1px] pl-8 text-[8px] text-muted-foreground font-mono">
        {hours.map((h) => (
          <div key={h} className="w-4 text-center">{h % 3 === 0 ? h.toString().padStart(2, '0') : ''}</div>
        ))}
      </div>
      {grid.map((row, dow) => (
        <div key={dow} className="flex items-center gap-[1px]">
          <div className="w-8 text-[9px] text-muted-foreground font-mono">{DAY_LABELS[dow]}</div>
          {row.map((count, h) => {
            const intensity = peak > 0 ? count / peak : 0
            const bg = count === 0
              ? 'rgba(148,163,184,0.06)'
              : `rgba(251,146,60,${0.15 + intensity * 0.75})`
            return (
              <div
                key={h}
                className="w-4 h-4 rounded-sm"
                style={{ background: bg }}
                title={`${DAY_LABELS[dow]} ${h.toString().padStart(2, '0')}:00 — ${count} mention${count === 1 ? '' : 's'}`}
              />
            )
          })}
        </div>
      ))}
      <div className="flex items-center gap-1.5 pt-1 text-[9px] text-muted-foreground">
        <span>0</span>
        <div className="flex-1 h-1 rounded" style={{ background: 'linear-gradient(to right, rgba(148,163,184,0.06), rgba(251,146,60,0.9))' }} />
        <span>{peak}</span>
      </div>
    </div>
  )
}
