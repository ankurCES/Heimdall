import Graph from 'graphology'
import pagerank from 'graphology-metrics/centrality/pagerank'
import betweennessCentrality from 'graphology-metrics/centrality/betweenness'
import eigenvectorCentrality from 'graphology-metrics/centrality/eigenvector'
import { density } from 'graphology-metrics/graph'
import louvain from 'graphology-communities-louvain'
import log from 'electron-log'
import { getDatabase } from '../database'
import { resolveNodesById } from '../../bridge/enrichmentBridge'

/**
 * Theme 4 — Network Analysis & Influence Mapping.
 *
 * Loads the intel_links graph from SQLite into an in-memory graphology
 * instance, computes:
 *   - Degree (simple incident-edge count)
 *   - PageRank (iterative eigenvector of the transition matrix, α=0.85)
 *   - Betweenness centrality (Brandes algorithm, O(VE) — run on demand)
 *   - Eigenvector centrality (power iteration)
 *   - Louvain community assignments with modularity score
 *
 * Results are written to `network_metrics` (one row per node) and the run
 * itself recorded in `network_runs` so the UI can show "last refreshed
 * Xs ago / N nodes / modularity 0.47". A full recompute is initiated only
 * when the analyst clicks Refresh — the algorithms are fast but NOT free
 * and the graph doesn't change often enough to justify a cron yet.
 */

export interface NetworkRunResult {
  id: number
  started_at: number
  finished_at: number
  node_count: number
  edge_count: number
  community_count: number
  modularity: number | null
  duration_ms: number
}

export interface NetworkMetric {
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

/** Optional time filter applied at graph-load time. Both bounds in ms-epoch. */
export interface TimeWindow {
  since?: number | null
  until?: number | null
}

export class NetworkAnalysisService {
  /** In-memory graph of the last refresh, reused by link prediction. */
  private lastGraph: Graph | null = null
  private lastWindow: TimeWindow | null = null

  /**
   * Recompute all metrics from `intel_links`. If `window` is supplied, only
   * links whose created_at falls within the range are considered — this lets
   * the analyst see "the network as of" a given time.
   */
  refresh(window?: TimeWindow): NetworkRunResult {
    const db = getDatabase()
    const started = Date.now()

    const runIns = db.prepare(
      'INSERT INTO network_runs (started_at) VALUES (?)'
    )
    const runId = Number(runIns.run(started).lastInsertRowid)

    try {
      const g = this.buildGraph(window)

      if (g.order === 0) {
        db.prepare(
          'UPDATE network_runs SET finished_at=?, node_count=0, edge_count=0, community_count=0, duration_ms=? WHERE id=?'
        ).run(Date.now(), Date.now() - started, runId)
        return {
          id: runId, started_at: started, finished_at: Date.now(),
          node_count: 0, edge_count: 0, community_count: 0,
          modularity: null, duration_ms: Date.now() - started
        }
      }

      const V = g.order
      const E = g.size
      log.info(`network: graph loaded — ${V} nodes, ${E} edges, density=${density(g).toFixed(4)}`)

      // Centrality
      const pr = pagerank(g, { getEdgeWeight: 'weight', alpha: 0.85, maxIterations: 100 })
      const bt = betweennessCentrality(g, { getEdgeWeight: 'weight', normalized: true })
      let ev: Record<string, number> = {}
      try {
        ev = eigenvectorCentrality(g, { getEdgeWeight: 'weight', maxIterations: 200, tolerance: 1e-6 })
      } catch (err) {
        log.warn(`network: eigenvector centrality failed: ${(err as Error).message}`)
      }

      // Louvain community detection (returns modularity on the result)
      let communities: Record<string, number> = {}
      let modularity: number | null = null
      try {
        const details = louvain.detailed(g, { getEdgeWeight: 'weight' })
        communities = details.communities
        modularity = details.modularity ?? null
      } catch (err) {
        log.warn(`network: Louvain failed: ${(err as Error).message}`)
      }

      const communityCount = new Set(Object.values(communities)).size

      // Write results (transactional)
      const now = Date.now()
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM network_metrics').run()
        const ins = db.prepare(`
          INSERT INTO network_metrics
            (node_id, node_type, degree, pagerank, betweenness, eigenvector,
             community_id, label, discipline, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        g.forEachNode((id, attrs) => {
          ins.run(
            id,
            String(attrs.nodeType || 'intel'),
            g.degree(id),
            pr[id] ?? 0,
            bt[id] ?? 0,
            ev[id] ?? 0,
            communities[id] ?? null,
            String(attrs.label || '').slice(0, 200),
            attrs.discipline ?? null,
            now
          )
        })
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE network_runs SET finished_at=?, node_count=?, edge_count=?, community_count=?, modularity=?, duration_ms=? WHERE id=?'
      ).run(finished, V, E, communityCount, modularity, finished - started, runId)

      log.info(`network: refresh complete — ${V} nodes, ${E} edges, ${communityCount} communities, Q=${modularity?.toFixed(3)}, ${finished - started}ms`)

      // Retain the graph for link-prediction queries — no need to rebuild from
      // scratch for each predictLinks call. Invalidated whenever refresh runs.
      this.lastGraph = g
      this.lastWindow = window ?? null

      return {
        id: runId, started_at: started, finished_at: finished,
        node_count: V, edge_count: E, community_count: communityCount,
        modularity, duration_ms: finished - started
      }
    } catch (err) {
      const message = (err as Error).message
      db.prepare('UPDATE network_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), message, runId)
      log.error(`network: refresh failed: ${message}`)
      throw err
    }
  }

  /**
   * Load intel_links into a fresh graphology instance. Used by refresh()
   * (before centrality) and by predictLinks() to recover the graph after
   * a process restart wipes lastGraph.
   */
  private buildGraph(window?: TimeWindow): Graph {
    const db = getDatabase()
    const g = new Graph({ type: 'undirected', allowSelfLoops: false, multi: false })

    // Time-window filter. `created_at` on intel_links is populated by the
    // enricher; rows that predate that field (older migrations) fall through
    // the WHERE and are included whenever no window is supplied.
    const clauses: string[] = [
      'source_report_id IS NOT NULL',
      'target_report_id IS NOT NULL',
      'source_report_id <> target_report_id'
    ]
    const params: unknown[] = []
    if (window?.since != null) { clauses.push('created_at >= ?'); params.push(window.since) }
    if (window?.until != null) { clauses.push('created_at <= ?'); params.push(window.until) }
    const edgeRows = db.prepare(`
      SELECT source_report_id, target_report_id, link_type, strength
      FROM intel_links
      WHERE ${clauses.join(' AND ')}
    `).all(...params) as Array<{ source_report_id: string; target_report_id: string; link_type: string; strength: number | null }>

    const endpointIds = new Set<string>()
    for (const e of edgeRows) {
      endpointIds.add(e.source_report_id)
      endpointIds.add(e.target_report_id)
    }
    if (endpointIds.size === 0) return g

    const nodeMeta = resolveNodesById(db, Array.from(endpointIds))
    for (const id of endpointIds) {
      const meta = nodeMeta.get(id)
      g.addNode(id, {
        label: (meta?.title as string) || id,
        discipline: (meta?.discipline as string) || null,
        nodeType: (meta?.type as string) || 'intel'
      })
    }

    // Dedup parallel edges; weight = average strength.
    const edgeWeights = new Map<string, { sum: number; count: number }>()
    for (const e of edgeRows) {
      const [a, b] = e.source_report_id < e.target_report_id
        ? [e.source_report_id, e.target_report_id]
        : [e.target_report_id, e.source_report_id]
      if (!g.hasNode(a) || !g.hasNode(b)) continue
      const key = `${a}|${b}`
      const w = e.strength ?? 0.5
      const prev = edgeWeights.get(key)
      if (prev) { prev.sum += w; prev.count += 1 }
      else edgeWeights.set(key, { sum: w, count: 1 })
    }
    for (const [key, ws] of edgeWeights) {
      const [a, b] = key.split('|')
      if (!g.hasEdge(a, b)) {
        g.addEdge(a, b, { weight: ws.sum / ws.count })
      }
    }

    return g
  }

  /** Top N nodes by a given metric. */
  top(metric: 'pagerank' | 'betweenness' | 'degree' | 'eigenvector', limit = 20): NetworkMetric[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT node_id, node_type, label, discipline, degree, pagerank, betweenness, eigenvector,
             community_id, computed_at
      FROM network_metrics
      WHERE ${metric} > 0
      ORDER BY ${metric} DESC
      LIMIT ?
    `).all(limit) as NetworkMetric[]
  }

  /** Summary of each detected community: id, size, top member by PageRank. */
  communities(): Array<{ community_id: number; size: number; top_label: string | null; top_pagerank: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT nm.community_id,
             COUNT(*) AS size,
             (SELECT label FROM network_metrics nm2
              WHERE nm2.community_id = nm.community_id
              ORDER BY nm2.pagerank DESC LIMIT 1) AS top_label,
             (SELECT pagerank FROM network_metrics nm2
              WHERE nm2.community_id = nm.community_id
              ORDER BY nm2.pagerank DESC LIMIT 1) AS top_pagerank
      FROM network_metrics nm
      WHERE nm.community_id IS NOT NULL
      GROUP BY nm.community_id
      ORDER BY size DESC
    `).all() as Array<{ community_id: number; size: number; top_label: string | null; top_pagerank: number }>
  }

  latestRun(): NetworkRunResult | null {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, started_at, finished_at, node_count, edge_count,
             community_count, modularity, duration_ms
      FROM network_runs
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as NetworkRunResult | undefined
    return row ?? null
  }

  /** Every metric for a given node — useful for the detail pane. */
  forNode(nodeId: string): NetworkMetric | null {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT node_id, node_type, label, discipline, degree, pagerank, betweenness,
             eigenvector, community_id, computed_at
      FROM network_metrics WHERE node_id = ?
    `).get(nodeId) as NetworkMetric | undefined
    return row ?? null
  }

  /** Node search — simple label LIKE used by the link-prediction picker. */
  searchNodes(query: string, limit = 20): NetworkMetric[] {
    if (!query || query.trim().length < 2) return []
    const db = getDatabase()
    const q = `%${query.trim().toLowerCase()}%`
    return db.prepare(`
      SELECT node_id, node_type, label, discipline, degree, pagerank, betweenness, eigenvector, community_id, computed_at
      FROM network_metrics
      WHERE lower(label) LIKE ? OR lower(node_id) LIKE ?
      ORDER BY pagerank DESC
      LIMIT ?
    `).all(q, q, limit) as NetworkMetric[]
  }

  /**
   * Link prediction — Adamic-Adar. For every candidate node Y that is NOT
   * currently connected to the source X, score
   *
   *     AA(X, Y) = Σ_{z ∈ N(X) ∩ N(Y)}  1 / log(|N(z)|)
   *
   * The intuition: common neighbours with low degree are stronger evidence
   * of a hidden connection than common neighbours that are connected to
   * everyone (a hub is a weak signal). Runs purely in-memory over
   * `this.lastGraph` — must be called AFTER at least one refresh().
   *
   * Search space is bounded to 2-hop neighbours of X (any candidate Y at
   * greater distance has zero common neighbours and contributes nothing).
   */
  predictLinks(nodeId: string, limit = 20): Array<{
    node_id: string; label: string | null; score: number; common: number; community_id: number | null; discipline: string | null
  }> {
    // Rebuild the graph on demand if the process restarted since the last
    // refresh. Cheap — ~1-2s for a 200K-edge graph; much faster than waiting
    // through the 2-minute centrality recompute.
    if (!this.lastGraph) {
      this.lastGraph = this.buildGraph()
    }
    const g = this.lastGraph
    if (!g.hasNode(nodeId)) {
      throw new Error(`Node ${nodeId} is not in the current graph`)
    }

    // Neighbours of X as a Set for O(1) membership checks.
    const neighX = new Set(g.neighbors(nodeId))

    // Enumerate 2-hop neighbours as candidates.
    const candidates = new Map<string, { common: string[] }>()
    for (const z of neighX) {
      for (const y of g.neighbors(z)) {
        if (y === nodeId) continue
        if (neighX.has(y)) continue // already directly connected
        const entry = candidates.get(y)
        if (entry) entry.common.push(z)
        else candidates.set(y, { common: [z] })
      }
    }

    const db = getDatabase()
    const scored: Array<{ node_id: string; label: string | null; score: number; common: number; community_id: number | null; discipline: string | null }> = []
    for (const [y, { common }] of candidates) {
      let aa = 0
      for (const z of common) {
        const d = g.degree(z)
        if (d > 1) aa += 1 / Math.log(d)
      }
      if (aa <= 0) continue
      scored.push({ node_id: y, label: null, score: aa, common: common.length, community_id: null, discipline: null })
    }
    scored.sort((a, b) => b.score - a.score)
    const topK = scored.slice(0, limit)

    // Resolve labels / community / discipline from the cache — one query
    // rather than per-row.
    if (topK.length > 0) {
      const placeholders = topK.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT node_id, label, community_id, discipline FROM network_metrics
        WHERE node_id IN (${placeholders})
      `).all(...topK.map((r) => r.node_id)) as Array<{ node_id: string; label: string | null; community_id: number | null; discipline: string | null }>
      const byId = new Map(rows.map((r) => [r.node_id, r]))
      for (const r of topK) {
        const meta = byId.get(r.node_id)
        if (meta) {
          r.label = meta.label
          r.community_id = meta.community_id
          r.discipline = meta.discipline
        }
      }
    }

    return topK
  }

  /** Window of the last refresh, if any. */
  lastWindowUsed(): TimeWindow | null {
    return this.lastWindow
  }
}

export const networkAnalysisService = new NetworkAnalysisService()
