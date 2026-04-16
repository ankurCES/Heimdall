import log from 'electron-log'
import Graph from 'graphology'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { resolveNodesById } from '../../bridge/enrichmentBridge'

/**
 * Theme 4.5 + Cross-cutting D.
 *
 *  4.5  Influence propagation simulator — drop a seed node, simulate
 *       how a claim spreads via the intel_links graph under an
 *       independent-cascade model. Returns per-step activation + the
 *       chokepoint nodes whose removal most reduces total spread.
 *
 *  D    Agent reasoning-graph nodes — persistence layer. Every agent
 *       tool call (and intermediate reasoning summary) is stored as a
 *       reasoning_nodes row with parent pointer so analysts can audit
 *       "why did the model reach this conclusion". No runtime wiring
 *       here — the ToolCallingAgent can log nodes via logReasoning().
 */

// ─── 4.5 influence propagation ──────────────────────────────────────
export interface PropagationStep {
  step: number
  newly_activated: string[]
  cumulative: string[]
}

export class InfluenceService {
  private loadGraph(): Graph {
    const db = getDatabase()
    const g = new Graph({ type: 'undirected', allowSelfLoops: false, multi: false })
    const rows = db.prepare(`
      SELECT source_report_id AS s, target_report_id AS t, strength
      FROM intel_links
      WHERE source_report_id IS NOT NULL AND target_report_id IS NOT NULL
        AND source_report_id <> target_report_id
    `).all() as Array<{ s: string; t: string; strength: number | null }>
    const endpoints = new Set<string>()
    for (const r of rows) { endpoints.add(r.s); endpoints.add(r.t) }
    const meta = resolveNodesById(db, Array.from(endpoints))
    for (const id of endpoints) {
      const m = meta.get(id)
      g.addNode(id, { label: (m?.title as string) || id })
    }
    for (const r of rows) {
      if (!g.hasNode(r.s) || !g.hasNode(r.t)) continue
      if (g.hasEdge(r.s, r.t)) continue
      g.addEdge(r.s, r.t, { p: Math.max(0.05, Math.min(0.95, r.strength ?? 0.5)) })
    }
    return g
  }

  /**
   * Independent-cascade simulation. Each active node tries each neighbour
   * once with per-edge probability p; successes join the next step's
   * active set. Deterministic with seeded random if desired (for
   * reproducibility); here we average over `trials` runs.
   */
  simulate(seedNodeId: string, opts: { max_steps?: number; trials?: number; seed?: number } = {}): {
    seed: { id: string; label: string | null }
    total_reached: number
    total_nodes: number
    steps: PropagationStep[]
    chokepoints: Array<{ node_id: string; label: string; reached_without: number }>
  } {
    const g = this.loadGraph()
    if (!g.hasNode(seedNodeId)) {
      throw new Error(`Seed node ${seedNodeId} not in intel_links graph`)
    }
    const maxSteps = opts.max_steps ?? 6
    const trials = opts.trials ?? 100

    // Seeded LCG PRNG for reproducibility.
    let state = opts.seed ?? 0x1234ABCD
    const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0xffffffff }

    // Average-trial reach — returns activation counts per node across runs.
    const reach = new Map<string, number>()
    let avgTotalReach = 0
    for (let trial = 0; trial < trials; trial++) {
      const active = new Set<string>([seedNodeId])
      let frontier = new Set<string>([seedNodeId])
      for (let step = 1; step <= maxSteps && frontier.size > 0; step++) {
        const next = new Set<string>()
        for (const u of frontier) {
          for (const v of g.neighbors(u)) {
            if (active.has(v)) continue
            const p = g.getEdgeAttribute(u, v, 'p') as number
            if (rnd() < p) { next.add(v); active.add(v) }
          }
        }
        frontier = next
      }
      for (const n of active) reach.set(n, (reach.get(n) ?? 0) + 1)
      avgTotalReach += active.size
    }
    avgTotalReach = avgTotalReach / trials

    // Produce a single representative trace for the UI.
    const active = new Set<string>([seedNodeId])
    let frontier = new Set<string>([seedNodeId])
    const steps: PropagationStep[] = [{ step: 0, newly_activated: [seedNodeId], cumulative: [seedNodeId] }]
    let traceState = (opts.seed ?? 0xCAFEBEEF) >>> 0
    const traceRnd = () => { traceState = (traceState * 1664525 + 1013904223) >>> 0; return traceState / 0xffffffff }
    for (let step = 1; step <= maxSteps && frontier.size > 0; step++) {
      const next = new Set<string>()
      for (const u of frontier) {
        for (const v of g.neighbors(u)) {
          if (active.has(v)) continue
          const p = g.getEdgeAttribute(u, v, 'p') as number
          if (traceRnd() < p) { next.add(v); active.add(v) }
        }
      }
      steps.push({ step, newly_activated: Array.from(next), cumulative: Array.from(active) })
      frontier = next
    }

    // Chokepoint estimate — for the top 25 reached nodes (excluding seed),
    // simulate removing each one and report the spread drop.
    const topReached = Array.from(reach.entries())
      .filter(([id]) => id !== seedNodeId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)

    const chokepoints: Array<{ node_id: string; label: string; reached_without: number }> = []
    for (const [id] of topReached) {
      const sub = g.copy()
      sub.dropNode(id)
      // Single-trial quick estimate — cheap enough.
      const a = new Set<string>([seedNodeId])
      let f = new Set<string>([seedNodeId])
      for (let step = 1; step <= maxSteps && f.size > 0; step++) {
        const nxt = new Set<string>()
        for (const u of f) {
          if (!sub.hasNode(u)) continue
          for (const v of sub.neighbors(u)) {
            if (a.has(v)) continue
            const p = sub.getEdgeAttribute(u, v, 'p') as number
            if (rnd() < p) { nxt.add(v); a.add(v) }
          }
        }
        f = nxt
      }
      chokepoints.push({
        node_id: id,
        label: (g.getNodeAttribute(id, 'label') as string) || id,
        reached_without: a.size
      })
    }
    chokepoints.sort((a, b) => a.reached_without - b.reached_without)

    const seedLabel = (g.getNodeAttribute(seedNodeId, 'label') as string) || null
    log.info(`influence: seed=${seedNodeId} avg_reach=${avgTotalReach.toFixed(1)}/${g.order} chokepoints=${chokepoints.length}`)

    return {
      seed: { id: seedNodeId, label: seedLabel },
      total_reached: Math.round(avgTotalReach),
      total_nodes: g.order,
      steps,
      chokepoints: chokepoints.slice(0, 10)
    }
  }
}
export const influenceService = new InfluenceService()

// ─── D reasoning-graph nodes ────────────────────────────────────────
export class ReasoningGraphService {
  /**
   * Log a reasoning step. Called from the ToolCallingAgent and the
   * Analyst Council. parent_id links to the prior step (null for roots).
   * payload is a free-form JSON blob (tool args, citations, etc).
   */
  log(args: { session_id?: string | null; parent_id?: string | null; kind: string; summary: string; payload?: unknown }): string {
    const db = getDatabase()
    const id = generateId()
    db.prepare(`
      INSERT INTO reasoning_nodes (id, session_id, parent_id, kind, summary, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, args.session_id ?? null, args.parent_id ?? null, args.kind,
      args.summary.slice(0, 2000),
      args.payload ? JSON.stringify(args.payload).slice(0, 20000) : null, Date.now())
    return id
  }

  forSession(sessionId: string, limit = 500): Array<{ id: string; parent_id: string | null; kind: string; summary: string; payload: string | null; created_at: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, parent_id, kind, summary, payload, created_at
      FROM reasoning_nodes WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
    `).all(sessionId, limit) as Array<{ id: string; parent_id: string | null; kind: string; summary: string; payload: string | null; created_at: number }>
  }

  byKind(kind: string, limit = 100): Array<{ id: string; session_id: string | null; parent_id: string | null; kind: string; summary: string; created_at: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, session_id, parent_id, kind, summary, created_at
      FROM reasoning_nodes WHERE kind = ? ORDER BY created_at DESC LIMIT ?
    `).all(kind, limit) as Array<{ id: string; session_id: string | null; parent_id: string | null; kind: string; summary: string; created_at: number }>
  }
}
export const reasoningGraphService = new ReasoningGraphService()
