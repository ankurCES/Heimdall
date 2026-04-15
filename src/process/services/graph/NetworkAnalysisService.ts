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

export class NetworkAnalysisService {
  /**
   * Recompute all metrics from the current state of intel_links. Overwrites
   * network_metrics in full. Returns a summary row from network_runs.
   */
  refresh(): NetworkRunResult {
    const db = getDatabase()
    const started = Date.now()

    const runIns = db.prepare(
      'INSERT INTO network_runs (started_at) VALUES (?)'
    )
    const runId = Number(runIns.run(started).lastInsertRowid)

    try {
      // Build graph: undirected for centrality + Louvain. Self-loops skipped.
      const g = new Graph({ type: 'undirected', allowSelfLoops: false, multi: false })

      const edgeRows = db.prepare(`
        SELECT source_report_id, target_report_id, link_type, strength
        FROM intel_links
        WHERE source_report_id IS NOT NULL AND target_report_id IS NOT NULL
          AND source_report_id <> target_report_id
      `).all() as Array<{ source_report_id: string; target_report_id: string; link_type: string; strength: number | null }>

      const endpointIds = new Set<string>()
      for (const e of edgeRows) {
        endpointIds.add(e.source_report_id)
        endpointIds.add(e.target_report_id)
      }

      if (endpointIds.size === 0) {
        db.prepare(
          'UPDATE network_runs SET finished_at=?, node_count=0, edge_count=0, community_count=0, duration_ms=? WHERE id=?'
        ).run(Date.now(), Date.now() - started, runId)
        return {
          id: runId, started_at: started, finished_at: Date.now(),
          node_count: 0, edge_count: 0, community_count: 0,
          modularity: null, duration_ms: Date.now() - started
        }
      }

      const nodeMeta = resolveNodesById(db, Array.from(endpointIds))

      // Add nodes
      for (const id of endpointIds) {
        const meta = nodeMeta.get(id)
        g.addNode(id, {
          label: (meta?.title as string) || id,
          discipline: (meta?.discipline as string) || null,
          nodeType: (meta?.type as string) || 'intel'
        })
      }

      // Add edges (dedup since we forced undirected + multi=false).
      // Weight = average strength across parallel link rows.
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
}

export const networkAnalysisService = new NetworkAnalysisService()
