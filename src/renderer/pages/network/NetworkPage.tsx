import { useEffect, useState } from 'react'
import { Network, RefreshCw, TrendingUp, GitBranch, Users, Zap, Loader2, Clock } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

/**
 * Theme 4 — Network Analysis page.
 *
 * Surfaces cached centrality and community metrics computed over the
 * intel_links graph:
 *   - Top Influencers (PageRank)     — "who is most central in the belief graph"
 *   - Top Brokers (Betweenness)      — "who sits on the most shortest paths between others"
 *   - Top Connectors (Degree)        — "who has the most direct neighbours"
 *   - Communities (Louvain)          — auto-clusters with modularity score
 *
 * Metrics are computed on demand via the Refresh button. The graph library
 * (graphology) runs entirely in the main process — no native deps.
 */

interface NetworkMetric {
  node_id: string
  node_type: string
  label: string | null
  discipline: string | null
  degree: number
  pagerank: number
  betweenness: number
  eigenvector: number
  community_id: number | null
  computed_at: number
}

interface NetworkRun {
  id: number
  started_at: number
  finished_at: number
  node_count: number
  edge_count: number
  community_count: number
  modularity: number | null
  duration_ms: number
}

interface CommunityRow {
  community_id: number
  size: number
  top_label: string | null
  top_pagerank: number
}

type Metric = 'pagerank' | 'betweenness' | 'degree' | 'eigenvector'

const METRIC_LABELS: Record<Metric, { title: string; hint: string; icon: typeof TrendingUp }> = {
  pagerank: { title: 'Top Influencers (PageRank)', hint: 'Central nodes in the belief graph — high-influence hubs', icon: TrendingUp },
  betweenness: { title: 'Top Brokers (Betweenness)', hint: 'Nodes on the most shortest paths between others — gatekeepers', icon: GitBranch },
  degree: { title: 'Top Connectors (Degree)', hint: 'Most direct neighbours — raw connectivity', icon: Zap },
  eigenvector: { title: 'Top by Eigenvector Centrality', hint: 'Connected to other well-connected nodes — "important friends"', icon: Network }
}

export function NetworkPage() {
  const [run, setRun] = useState<NetworkRun | null>(null)
  const [top, setTop] = useState<Record<Metric, NetworkMetric[]>>({
    pagerank: [], betweenness: [], degree: [], eigenvector: []
  })
  const [communities, setCommunities] = useState<CommunityRow[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    setError(null)
    try {
      const [latest, pr, bt, deg, ev, comms] = await Promise.all([
        window.heimdall.invoke('network:latest'),
        window.heimdall.invoke('network:top', { metric: 'pagerank', limit: 20 }),
        window.heimdall.invoke('network:top', { metric: 'betweenness', limit: 20 }),
        window.heimdall.invoke('network:top', { metric: 'degree', limit: 20 }),
        window.heimdall.invoke('network:top', { metric: 'eigenvector', limit: 20 }),
        window.heimdall.invoke('network:communities')
      ]) as [NetworkRun | null, NetworkMetric[], NetworkMetric[], NetworkMetric[], NetworkMetric[], CommunityRow[]]
      setRun(latest)
      setTop({ pagerank: pr, betweenness: bt, degree: deg, eigenvector: ev })
      setCommunities(comms)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  async function refresh() {
    setRefreshing(true)
    setError(null)
    try {
      await window.heimdall.invoke('network:refresh')
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setRefreshing(false)
    }
  }

  const empty = !run || run.node_count === 0

  return (
    <div className="flex flex-col h-full overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Network Analysis</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Centrality metrics and community detection over the relationship
            graph. PageRank ranks by influence in the belief graph; betweenness
            flags brokers sitting on the most shortest paths; Louvain clusters
            the graph into communities with a modularity score (Q &gt; 0.3 ≈ meaningful structure).
          </p>
        </div>
        <Button onClick={refresh} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          {run ? 'Recompute' : 'Compute now'}
        </Button>
      </div>

      {/* Run summary */}
      <Card>
        <CardContent className="p-4 grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
          <Stat label="Nodes" value={run?.node_count ?? 0} />
          <Stat label="Edges" value={run?.edge_count ?? 0} />
          <Stat label="Communities" value={run?.community_count ?? 0} />
          <Stat
            label="Modularity (Q)"
            value={run?.modularity != null ? run.modularity.toFixed(3) : '—'}
            hint={run?.modularity != null && run.modularity > 0.3 ? 'meaningful structure' : undefined}
          />
          <Stat label="Duration" value={run?.duration_ms != null ? `${run.duration_ms} ms` : '—'} />
          <Stat
            label="Last run"
            value={run ? formatRelativeTime(run.finished_at) : 'never'}
          />
        </CardContent>
      </Card>

      {error && (
        <div className="text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">
          {error}
        </div>
      )}

      {empty && !loading && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm">
            <Network className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No network metrics yet. Click <strong>Compute now</strong> to run a first analysis.</p>
            <p className="text-xs mt-2 opacity-70">
              Requires at least a handful of <code className="font-mono">intel_links</code> — if the graph is sparse,
              centrality will be near-zero and communities won't emerge.
            </p>
          </CardContent>
        </Card>
      )}

      {!empty && (
        <>
          {/* Centrality panels */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopPanel metric="pagerank" rows={top.pagerank} />
            <TopPanel metric="betweenness" rows={top.betweenness} />
            <TopPanel metric="degree" rows={top.degree} />
            <TopPanel metric="eigenvector" rows={top.eigenvector} />
          </div>

          {/* Communities */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Communities (Louvain)</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Each community is a group of densely interconnected nodes. The representative label is the
                community member with the highest PageRank.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {communities.length === 0 ? (
                <p className="text-xs text-muted-foreground">No communities detected (graph may be too sparse).</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b border-border">
                        <th className="text-left py-2 font-medium">Community</th>
                        <th className="text-left py-2 font-medium">Size</th>
                        <th className="text-left py-2 font-medium">Representative node</th>
                        <th className="text-right py-2 font-medium">PageRank</th>
                      </tr>
                    </thead>
                    <tbody>
                      {communities.map((c) => (
                        <tr key={c.community_id} className="border-b border-border/40 hover:bg-accent/30">
                          <td className="py-1.5">
                            <Badge variant="outline" className="font-mono text-[10px]">
                              C{c.community_id}
                            </Badge>
                          </td>
                          <td className="py-1.5 text-xs">{c.size} nodes</td>
                          <td className="py-1.5 text-xs truncate max-w-md">{c.top_label || '—'}</td>
                          <td className="py-1.5 text-right text-xs font-mono">{c.top_pagerank.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-semibold font-mono">{value}</div>
      {hint && <div className="text-[10px] text-emerald-400 mt-0.5">{hint}</div>}
    </div>
  )
}

function TopPanel({ metric, rows }: { metric: Metric; rows: NetworkMetric[] }) {
  const meta = METRIC_LABELS[metric]
  const Icon = meta.icon
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-sm">{meta.title}</CardTitle>
        </div>
        <CardDescription className="text-[10px]">{meta.hint}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No data.</p>
        ) : (
          <ol className="space-y-0.5">
            {rows.map((r, i) => (
              <li key={r.node_id} className="flex items-center gap-2 py-1 border-b border-border/30 last:border-0 text-xs">
                <span className="w-6 text-muted-foreground text-right font-mono">{i + 1}.</span>
                <span className="flex-1 truncate" title={r.label ?? r.node_id}>{r.label || r.node_id}</span>
                {r.discipline && <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{r.discipline}</Badge>}
                {r.community_id != null && (
                  <Badge variant="secondary" className="text-[9px] py-0 px-1 font-mono">C{r.community_id}</Badge>
                )}
                <span className={cn('w-16 text-right font-mono', metric === 'degree' ? '' : 'text-primary')}>
                  {metric === 'degree' ? r.degree : (r as unknown as Record<Metric, number>)[metric].toFixed(4)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
