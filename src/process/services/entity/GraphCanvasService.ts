// GraphCanvasService — v1.8.0 cross-entity link analysis workspace.
//
// The analyst's canvas is a living snapshot of the entity graph:
// seed N entities, expand neighbours via co-mentions, prune what
// doesn't matter, save for resumption. This service handles the
// persistence and the "expand" operation; the layout (force
// simulation positions) lives in the renderer.
//
// Design choices:
//   - Nodes + edges stored as JSON blobs on graph_canvases. The
//     canvas is fundamentally a snapshot the analyst mutates
//     freely; normalising into separate tables would mean a
//     write storm on every drag.
//   - "expand" reuses EntityCoMentionService.getCoMentions() so the
//     edge logic is identical to the v1.7.1 sidebar — same
//     deterministic intel_entities-based join, never wrong.
//   - A canvas can be loaded incrementally: seedFromEntity()
//     returns just the seed + its top neighbours so the renderer
//     gets a usable graph after one round-trip; subsequent
//     expand() calls grow the graph from any selected node.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { entityCoMentionService } from './EntityCoMentionService'

export interface GraphNode {
  id: string                  // canonical_id
  label: string               // canonical_value
  entity_type: string
  mention_count: number
  /** Soft "anchor" flag set by the renderer when the analyst pins a
   *  node so subsequent expansions don't replace it. */
  pinned?: boolean
  /** Time the node was added to the canvas. Used to fade-in newly-
   *  expanded neighbours. */
  added_at: number
}

export interface GraphEdge {
  source: string              // canonical_id
  target: string              // canonical_id
  shared_reports: number
  co_mention_count: number
  last_co_mentioned_at: number
}

export interface GraphCanvas {
  id: string
  name: string
  description: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout_json: string | null  // opaque blob the renderer manages
  created_at: number
  updated_at: number
}

export interface ExpandResult {
  added_nodes: GraphNode[]
  added_edges: GraphEdge[]
  /** Existing edges that now have a target inside the canvas — the
   *  expand pulled in a node that closes a triangle. Useful for the
   *  renderer to highlight new connections to already-visible
   *  nodes. */
  closed_edges: GraphEdge[]
}

const DEFAULT_EXPAND_LIMIT = 10

export class GraphCanvasService {
  /** List every saved canvas (newest-modified first). */
  list(): Array<Pick<GraphCanvas, 'id' | 'name' | 'description' | 'created_at' | 'updated_at'> & { node_count: number; edge_count: number }> {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT id, name, description, created_at, updated_at, nodes_json, edges_json
      FROM graph_canvases
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; name: string; description: string | null; created_at: number; updated_at: number; nodes_json: string; edges_json: string }>
    return rows.map((r) => {
      let n = 0, e = 0
      try { n = (JSON.parse(r.nodes_json) as unknown[]).length } catch { /* */ }
      try { e = (JSON.parse(r.edges_json) as unknown[]).length } catch { /* */ }
      return {
        id: r.id, name: r.name, description: r.description,
        created_at: r.created_at, updated_at: r.updated_at,
        node_count: n, edge_count: e
      }
    })
  }

  get(id: string): GraphCanvas | null {
    const row = getDatabase().prepare(`SELECT * FROM graph_canvases WHERE id = ?`).get(id) as { id: string; name: string; description: string | null; nodes_json: string; edges_json: string; layout_json: string | null; created_at: number; updated_at: number } | undefined
    if (!row) return null
    let nodes: GraphNode[] = []
    let edges: GraphEdge[] = []
    try { nodes = JSON.parse(row.nodes_json) as GraphNode[] } catch { /* */ }
    try { edges = JSON.parse(row.edges_json) as GraphEdge[] } catch { /* */ }
    return {
      id: row.id, name: row.name, description: row.description,
      nodes, edges, layout_json: row.layout_json,
      created_at: row.created_at, updated_at: row.updated_at
    }
  }

  /** Create a brand-new canvas seeded with the given canonical entity
   *  and its top-N co-mentioned neighbours (pre-populates the graph
   *  so the analyst lands on something useful instead of a blank
   *  canvas with one node). */
  createFromEntity(args: { name: string; canonicalId: string; expandLimit?: number; description?: string }): GraphCanvas {
    const db = getDatabase()
    const seedRow = db.prepare(`
      SELECT id, entity_type, canonical_value, mention_count
      FROM canonical_entities WHERE id = ?
    `).get(args.canonicalId) as { id: string; entity_type: string; canonical_value: string; mention_count: number } | undefined
    if (!seedRow) throw new Error(`Canonical entity not found: ${args.canonicalId}`)

    const now = Date.now()
    const nodes: GraphNode[] = [{
      id: seedRow.id,
      label: seedRow.canonical_value,
      entity_type: seedRow.entity_type,
      mention_count: seedRow.mention_count,
      pinned: true,                     // seed is anchored
      added_at: now
    }]
    const edges: GraphEdge[] = []

    const expanded = entityCoMentionService.getCoMentions(args.canonicalId, args.expandLimit ?? DEFAULT_EXPAND_LIMIT)
    if (expanded) {
      for (const e of expanded.edges) {
        nodes.push({
          id: e.canonical_id,
          label: e.canonical_value,
          entity_type: e.entity_type,
          mention_count: 0,             // we don't have it in the co-mention edge; renderer can backfill if needed
          added_at: now
        })
        edges.push({
          source: seedRow.id,
          target: e.canonical_id,
          shared_reports: e.shared_reports,
          co_mention_count: e.co_mention_count,
          last_co_mentioned_at: e.last_co_mentioned_at
        })
      }
    }

    const id = generateId()
    db.prepare(`
      INSERT INTO graph_canvases
        (id, name, description, nodes_json, edges_json, layout_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(id, args.name.trim(), args.description?.trim() ?? null,
           JSON.stringify(nodes), JSON.stringify(edges), now, now)

    log.info(`graph-canvas: created '${args.name}' seeded with ${seedRow.canonical_value} + ${edges.length} neighbour(s)`)
    return this.get(id)!
  }

  /** Expand a node already on the canvas: pull its top-N co-mentioned
   *  entities, add the missing ones to the canvas, and persist the
   *  updated graph. Returns the delta so the renderer can animate
   *  fade-ins. */
  expand(args: { canvasId: string; canonicalId: string; expandLimit?: number }): ExpandResult {
    const canvas = this.get(args.canvasId)
    if (!canvas) throw new Error(`Canvas not found: ${args.canvasId}`)

    const expanded = entityCoMentionService.getCoMentions(args.canonicalId, args.expandLimit ?? DEFAULT_EXPAND_LIMIT)
    if (!expanded) return { added_nodes: [], added_edges: [], closed_edges: [] }

    const existingIds = new Set(canvas.nodes.map((n) => n.id))
    const existingEdgeKeys = new Set(canvas.edges.map((e) => edgeKey(e.source, e.target)))
    const now = Date.now()
    const addedNodes: GraphNode[] = []
    const addedEdges: GraphEdge[] = []
    const closedEdges: GraphEdge[] = []

    for (const e of expanded.edges) {
      const isNewNode = !existingIds.has(e.canonical_id)
      if (isNewNode) {
        const node: GraphNode = {
          id: e.canonical_id,
          label: e.canonical_value,
          entity_type: e.entity_type,
          mention_count: 0,
          added_at: now
        }
        addedNodes.push(node)
        existingIds.add(e.canonical_id)
      }
      const edge: GraphEdge = {
        source: args.canonicalId,
        target: e.canonical_id,
        shared_reports: e.shared_reports,
        co_mention_count: e.co_mention_count,
        last_co_mentioned_at: e.last_co_mentioned_at
      }
      const key = edgeKey(edge.source, edge.target)
      if (!existingEdgeKeys.has(key)) {
        addedEdges.push(edge)
        existingEdgeKeys.add(key)
        if (!isNewNode) closedEdges.push(edge)
      }
    }

    if (addedNodes.length === 0 && addedEdges.length === 0) {
      // Nothing new — don't touch the row.
      return { added_nodes: [], added_edges: [], closed_edges: [] }
    }

    const newNodes = canvas.nodes.concat(addedNodes)
    const newEdges = canvas.edges.concat(addedEdges)
    getDatabase().prepare(`
      UPDATE graph_canvases SET nodes_json = ?, edges_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(newNodes), JSON.stringify(newEdges), now, args.canvasId)

    log.info(`graph-canvas: expanded ${args.canonicalId} on '${canvas.name}' — +${addedNodes.length} node(s), +${addedEdges.length} edge(s) (${closedEdges.length} closed triangles)`)
    return { added_nodes: addedNodes, added_edges: addedEdges, closed_edges: closedEdges }
  }

  /** Replace the whole canvas (used when the renderer mutates layout
   *  positions or the analyst removes a node). */
  save(args: { id: string; name?: string; description?: string; nodes?: GraphNode[]; edges?: GraphEdge[]; layout_json?: string | null }): GraphCanvas {
    const cur = this.get(args.id)
    if (!cur) throw new Error(`Canvas not found: ${args.id}`)
    const next: GraphCanvas = {
      ...cur,
      name: args.name ?? cur.name,
      description: args.description ?? cur.description,
      nodes: args.nodes ?? cur.nodes,
      edges: args.edges ?? cur.edges,
      layout_json: args.layout_json !== undefined ? args.layout_json : cur.layout_json,
      updated_at: Date.now()
    }
    getDatabase().prepare(`
      UPDATE graph_canvases
      SET name = ?, description = ?, nodes_json = ?, edges_json = ?, layout_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name, next.description,
      JSON.stringify(next.nodes), JSON.stringify(next.edges),
      next.layout_json, next.updated_at, args.id
    )
    return next
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM graph_canvases WHERE id = ?`).run(id)
  }
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export const graphCanvasService = new GraphCanvasService()
