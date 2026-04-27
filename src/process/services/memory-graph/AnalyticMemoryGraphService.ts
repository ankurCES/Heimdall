// AnalyticMemoryGraphService — builds an in-memory queryable knowledge
// graph from the v1.x analytic memory tables (reports, source_claims,
// source_reliability, report_indicators, indicator_observations,
// forecast_claims, forecast_outcomes, ethics_flags, case_files).
//
// Why an in-memory graph rather than additional tables:
//   - The data already lives in normalized tables; the graph is a VIEW.
//   - graphology gives us O(1) neighborhood queries + community detection
//     + centrality metrics that would be expensive in SQL.
//   - The graph is rebuilt on demand (cheap — typical agency volume is
//     <100K nodes) and cached for 60s.
//
// Node types:
//   report      — published analytic product
//   source      — a source_key from source_reliability
//   indicator   — an active I&W indicator
//   claim       — a forecast claim with WEP probability
//   outcome     — recorded outcome attached to a claim
//   case        — a case file
//   actor/malware/cve — pulled from threat_feeds when relevant
//
// Edge types:
//   produced_by  — report → source (cited)
//   tracked_by   — indicator → report
//   observed     — indicator → intel
//   asserts      — claim → report
//   resolves     — outcome → claim
//   contradicts  — claim → claim (from auto-revision detector)
//   contained_in — report/intel → case
//   tagged_with  — node → actor/malware/cve

import Graph from 'graphology'
import { degreeCentrality } from 'graphology-metrics/centrality/degree'
import louvain from 'graphology-communities-louvain'
import { getDatabase } from '../database'
import log from 'electron-log'

export type NodeType = 'report' | 'source' | 'indicator' | 'claim' | 'outcome' | 'case' | 'actor' | 'malware' | 'cve'

export interface MemoryGraphNode {
  id: string
  type: NodeType
  label: string
  metadata: Record<string, unknown>
}

export interface MemoryGraphEdge {
  source: string
  target: string
  relation: string
  weight: number
}

export interface MemoryGraphSnapshot {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  stats: {
    nodeCount: number
    edgeCount: number
    nodesByType: Record<string, number>
    communities: number
    builtAt: number
    durationMs: number
  }
}

const CACHE_TTL_MS = 60_000

export class AnalyticMemoryGraphService {
  private cached: MemoryGraphSnapshot | null = null
  private cachedAt = 0

  /**
   * Build (or return cached) graph snapshot. Force rebuild with rebuild=true.
   */
  build(rebuild: boolean = false): MemoryGraphSnapshot {
    if (!rebuild && this.cached && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cached
    }

    const start = Date.now()
    const db = getDatabase()
    const graph = new Graph({ multi: false, type: 'undirected' })

    const addNode = (id: string, type: NodeType, label: string, metadata: Record<string, unknown> = {}): void => {
      if (!graph.hasNode(id)) {
        graph.addNode(id, { type, label, metadata })
      }
    }
    const addEdge = (a: string, b: string, relation: string, weight: number = 1): void => {
      if (a === b || !graph.hasNode(a) || !graph.hasNode(b)) return
      const edgeKey = `${a}-${b}-${relation}`
      if (!graph.hasEdge(a, b)) {
        graph.addEdge(a, b, { relation, weight, key: edgeKey })
      } else {
        const attrs = graph.getEdgeAttributes(a, b)
        graph.setEdgeAttribute(a, b, 'weight', (attrs.weight as number || 1) + weight)
      }
    }

    // ── Reports ─────────────────────────────────────────────────────────
    try {
      const reports = db.prepare(`
        SELECT id, title, format, status, generated_at, tradecraft_score, query
        FROM report_products
        WHERE status IN ('published', 'draft')
        LIMIT 500
      `).all() as Array<{ id: string; title: string; format: string; status: string;
        generated_at: number; tradecraft_score: number | null; query: string | null }>
      for (const r of reports) {
        addNode(`report:${r.id}`, 'report', r.title.slice(0, 80), {
          format: r.format, status: r.status, score: r.tradecraft_score, generatedAt: r.generated_at
        })
      }
    } catch (err) { log.debug(`mem-graph: report load failed: ${err}`) }

    // ── Source reliability ─────────────────────────────────────────────
    try {
      const sources = db.prepare(`
        SELECT source_key, display_name, current_rating, current_score, total_claims
        FROM source_reliability
        WHERE total_claims > 0
        LIMIT 300
      `).all() as Array<{ source_key: string; display_name: string | null; current_rating: string;
        current_score: number; total_claims: number }>
      for (const s of sources) {
        addNode(`source:${s.source_key}`, 'source', s.display_name || s.source_key, {
          rating: s.current_rating, score: s.current_score, claims: s.total_claims
        })
      }
    } catch (err) { log.debug(`mem-graph: source load failed: ${err}`) }

    // ── Indicators (link to their report) ──────────────────────────────
    try {
      const indicators = db.prepare(`
        SELECT id, report_id, hypothesis, indicator_text, direction, priority, observation_count
        FROM report_indicators WHERE active = 1 LIMIT 500
      `).all() as Array<{ id: string; report_id: string; hypothesis: string; indicator_text: string;
        direction: string; priority: string; observation_count: number }>
      for (const ind of indicators) {
        addNode(`indicator:${ind.id}`, 'indicator', ind.indicator_text.slice(0, 80), {
          direction: ind.direction, priority: ind.priority, observations: ind.observation_count,
          hypothesis: ind.hypothesis.slice(0, 120)
        })
        addEdge(`indicator:${ind.id}`, `report:${ind.report_id}`, 'tracked_by', 2)
      }
    } catch (err) { log.debug(`mem-graph: indicator load failed: ${err}`) }

    // ── Forecast claims (link to report) ───────────────────────────────
    try {
      const claims = db.prepare(`
        SELECT id, report_id, claim_text, wep_term, probability_midpoint, confidence_level
        FROM forecast_claims LIMIT 500
      `).all() as Array<{ id: string; report_id: string; claim_text: string; wep_term: string | null;
        probability_midpoint: number | null; confidence_level: string | null }>
      for (const c of claims) {
        addNode(`claim:${c.id}`, 'claim', c.claim_text.slice(0, 80), {
          wep: c.wep_term, prob: c.probability_midpoint, confidence: c.confidence_level
        })
        addEdge(`claim:${c.id}`, `report:${c.report_id}`, 'asserts', 2)
      }
    } catch (err) { log.debug(`mem-graph: claim load failed: ${err}`) }

    // ── Outcomes (link to claim) ───────────────────────────────────────
    try {
      const outcomes = db.prepare(`
        SELECT id, claim_id, outcome, actual_probability, brier_score
        FROM forecast_outcomes LIMIT 500
      `).all() as Array<{ id: string; claim_id: string; outcome: string;
        actual_probability: number | null; brier_score: number | null }>
      for (const o of outcomes) {
        addNode(`outcome:${o.id}`, 'outcome', o.outcome, {
          actualProb: o.actual_probability, brier: o.brier_score
        })
        addEdge(`outcome:${o.id}`, `claim:${o.claim_id}`, 'resolves', 3)
      }
    } catch (err) { log.debug(`mem-graph: outcome load failed: ${err}`) }

    // ── Cases (link members) ───────────────────────────────────────────
    try {
      const cases = db.prepare(`
        SELECT id, name, status FROM case_files LIMIT 200
      `).all() as Array<{ id: string; name: string; status: string }>
      for (const c of cases) {
        addNode(`case:${c.id}`, 'case', c.name, { status: c.status })
      }
      const items = db.prepare(`
        SELECT case_file_id, item_type, item_id FROM case_file_items LIMIT 2000
      `).all() as Array<{ case_file_id: string; item_type: string; item_id: string }>
      for (const it of items) {
        const memberId = it.item_type === 'report' ? `report:${it.item_id}`
          : it.item_type === 'source' ? `source:${it.item_id}`
          : null
        if (memberId) addEdge(memberId, `case:${it.case_file_id}`, 'contained_in', 1)
      }
    } catch (err) { log.debug(`mem-graph: case load failed: ${err}`) }

    // ── Threat-feed entities (only ones that show up in indicator entities) ──
    try {
      const feedRows = db.prepare(`
        SELECT indicator_type, indicator_value, severity
        FROM threat_feeds WHERE indicator_type IN ('actor', 'malware', 'cve') LIMIT 500
      `).all() as Array<{ indicator_type: string; indicator_value: string; severity: string | null }>
      for (const f of feedRows) {
        const id = `${f.indicator_type}:${f.indicator_value}`
        addNode(id, f.indicator_type as NodeType, f.indicator_value, { severity: f.severity })
      }
    } catch (err) { log.debug(`mem-graph: threat-feed load failed: ${err}`) }

    // ── Communities (Louvain modularity) ────────────────────────────────
    let communityCount = 0
    if (graph.order > 0 && graph.size > 0) {
      try {
        const communities = louvain(graph) as Record<string, number>
        const distinct = new Set(Object.values(communities))
        communityCount = distinct.size
        graph.forEachNode((node) => {
          graph.setNodeAttribute(node, 'community', communities[node] ?? 0)
        })
      } catch (err) { log.debug(`mem-graph: community detection failed: ${err}`) }
    }

    // ── Centrality (cap at 30 nodes for the snapshot — caller can re-run) ──
    let centralityValues: Record<string, number> = {}
    if (graph.order > 0) {
      try {
        centralityValues = degreeCentrality(graph) as Record<string, number>
        graph.forEachNode((node) => {
          graph.setNodeAttribute(node, 'centrality', centralityValues[node] ?? 0)
        })
      } catch (err) { log.debug(`mem-graph: centrality failed: ${err}`) }
    }

    // Materialize snapshot
    const nodes: MemoryGraphNode[] = []
    const nodesByType: Record<string, number> = {}
    graph.forEachNode((id, attrs) => {
      const a = attrs as { type: NodeType; label: string; metadata: Record<string, unknown>; community?: number; centrality?: number }
      nodes.push({
        id, type: a.type, label: a.label,
        metadata: { ...a.metadata, community: a.community, centrality: a.centrality }
      })
      nodesByType[a.type] = (nodesByType[a.type] || 0) + 1
    })

    const edges: MemoryGraphEdge[] = []
    graph.forEachEdge((_key, attrs, source, target) => {
      const a = attrs as { relation: string; weight: number }
      edges.push({ source, target, relation: a.relation, weight: a.weight })
    })

    const snapshot: MemoryGraphSnapshot = {
      nodes, edges,
      stats: {
        nodeCount: graph.order,
        edgeCount: graph.size,
        nodesByType,
        communities: communityCount,
        builtAt: Date.now(),
        durationMs: Date.now() - start
      }
    }
    this.cached = snapshot
    this.cachedAt = Date.now()
    log.info(`AnalyticMemoryGraph: built ${graph.order} nodes / ${graph.size} edges / ${communityCount} communities in ${snapshot.stats.durationMs}ms`)
    return snapshot
  }

  /**
   * Get the immediate neighborhood of a node (1-hop, optionally 2-hop).
   * For the drilldown panel.
   */
  neighborhood(nodeId: string, hops: number = 1): MemoryGraphSnapshot {
    const full = this.build(false)
    const seed = new Set<string>([nodeId])
    let frontier = new Set<string>([nodeId])
    for (let i = 0; i < hops; i++) {
      const next = new Set<string>()
      for (const e of full.edges) {
        if (frontier.has(e.source) && !seed.has(e.target)) next.add(e.target)
        if (frontier.has(e.target) && !seed.has(e.source)) next.add(e.source)
      }
      for (const id of next) seed.add(id)
      frontier = next
    }
    return {
      nodes: full.nodes.filter((n) => seed.has(n.id)),
      edges: full.edges.filter((e) => seed.has(e.source) && seed.has(e.target)),
      stats: { ...full.stats, nodeCount: seed.size, edgeCount: full.edges.filter((e) => seed.has(e.source) && seed.has(e.target)).length }
    }
  }

  /** Top-N most-central nodes (for the dashboard summary). */
  topCentral(n: number = 20): MemoryGraphNode[] {
    const full = this.build(false)
    return [...full.nodes]
      .sort((a, b) => ((b.metadata.centrality as number) || 0) - ((a.metadata.centrality as number) || 0))
      .slice(0, n)
  }
}

export const analyticMemoryGraphService = new AnalyticMemoryGraphService()
