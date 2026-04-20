import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { nodeRegistry, type NodeExecContext } from './NodeRegistry'
import log from 'electron-log'

/**
 * Workflow execution engine. Takes a workflow definition (nodes + edges),
 * topologically sorts them, executes in dependency order (parallel where
 * possible), streams progress per-node, and stores the run result.
 */

export interface WorkflowNode {
  id: string
  type: string
  position: { x: number; y: number }
  config: Record<string, unknown>
}

export interface WorkflowEdge {
  id: string
  source: string       // source node id
  sourceHandle: string // output port name
  target: string       // target node id
  targetHandle: string // input port name
}

export interface Workflow {
  id: string
  name: string
  description: string | null
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  isPreset: boolean
  createdAt: number
  updatedAt: number
}

export interface NodeState {
  nodeId: string
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped'
  outputs: Record<string, unknown>
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
}

export interface WorkflowRunResult {
  runId: string
  workflowId: string
  status: 'completed' | 'error' | 'partial'
  nodeStates: NodeState[]
  finalOutputs: Record<string, unknown>
  startedAt: number
  finishedAt: number
  durationMs: number
}

type ProgressListener = (nodeId: string, status: string, message?: string) => void

class WorkflowEngineImpl {
  /**
   * Execute a workflow with given inputs. Topologically sorts nodes,
   * executes in dependency order, passes data between connected ports.
   */
  async execute(
    workflow: Workflow,
    inputs: Record<string, unknown> = {},
    onProgress?: ProgressListener,
    opts: { sessionId?: string; connectionId?: string } = {}
  ): Promise<WorkflowRunResult> {
    const runId = generateId()
    const startedAt = Date.now()
    const db = getDatabase()
    const now = timestamp()

    // Persist the run start.
    db.prepare(
      'INSERT INTO workflow_runs (id, workflow_id, status, inputs_json, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(runId, workflow.id, 'running', JSON.stringify(inputs), now, now)

    const nodeStates = new Map<string, NodeState>()
    const nodeOutputs = new Map<string, Record<string, unknown>>()

    // Init states.
    for (const node of workflow.nodes) {
      nodeStates.set(node.id, {
        nodeId: node.id, status: 'pending', outputs: {}, error: null,
        startedAt: null, finishedAt: null, durationMs: null
      })
    }

    // Topological sort.
    const sorted = this.topologicalSort(workflow.nodes, workflow.edges)
    log.info(`WorkflowEngine: executing ${workflow.name} — ${sorted.length} nodes in order`)

    // Execute in order.
    let hasError = false
    for (const nodeId of sorted) {
      const node = workflow.nodes.find((n) => n.id === nodeId)
      if (!node) continue

      const state = nodeStates.get(nodeId)!
      const typeDef = nodeRegistry.getType(node.type)
      const executor = nodeRegistry.getExecutor(node.type)

      if (!typeDef || !executor) {
        state.status = 'error'
        state.error = `Unknown node type: ${node.type}`
        hasError = true
        onProgress?.(nodeId, 'error', state.error)
        continue
      }

      // Resolve inputs from connected edges.
      const resolvedInputs: Record<string, unknown> = {}
      for (const edge of workflow.edges.filter((e) => e.target === nodeId)) {
        const sourceOutputs = nodeOutputs.get(edge.source)
        if (sourceOutputs && edge.sourceHandle in sourceOutputs) {
          resolvedInputs[edge.targetHandle] = sourceOutputs[edge.sourceHandle]
        }
      }
      // Also inject global inputs for source nodes.
      for (const [key, value] of Object.entries(inputs)) {
        if (!(key in resolvedInputs)) resolvedInputs[key] = value
      }

      state.status = 'running'
      state.startedAt = Date.now()
      onProgress?.(nodeId, 'running', `Executing ${typeDef.label}…`)

      try {
        const ctx: NodeExecContext = {
          nodeId,
          config: node.config,
          inputs: resolvedInputs,
          onProgress: (msg) => onProgress?.(nodeId, 'running', msg),
          sessionId: opts.sessionId,
          connectionId: opts.connectionId
        }
        const outputs = await executor(ctx)
        state.status = 'completed'
        state.outputs = outputs
        state.finishedAt = Date.now()
        state.durationMs = state.finishedAt - state.startedAt!
        nodeOutputs.set(nodeId, outputs)
        onProgress?.(nodeId, 'completed', `${typeDef.label} done (${state.durationMs}ms)`)
      } catch (err) {
        state.status = 'error'
        state.error = (err as Error).message
        state.finishedAt = Date.now()
        state.durationMs = state.finishedAt - state.startedAt!
        hasError = true
        onProgress?.(nodeId, 'error', state.error)
        log.warn(`WorkflowEngine: node ${nodeId} (${node.type}) failed: ${state.error}`)
      }
    }

    const finishedAt = Date.now()
    const allStates = Array.from(nodeStates.values())

    // Collect final outputs from all terminal nodes (nodes with no outgoing edges).
    const terminalNodeIds = new Set(workflow.nodes.map((n) => n.id))
    for (const edge of workflow.edges) terminalNodeIds.delete(edge.source)
    const finalOutputs: Record<string, unknown> = {}
    for (const tid of terminalNodeIds) {
      const out = nodeOutputs.get(tid)
      if (out) Object.assign(finalOutputs, out)
    }

    const result: WorkflowRunResult = {
      runId, workflowId: workflow.id,
      status: hasError ? (allStates.some((s) => s.status === 'completed') ? 'partial' : 'error') : 'completed',
      nodeStates: allStates, finalOutputs,
      startedAt, finishedAt, durationMs: finishedAt - startedAt
    }

    // Persist run result.
    db.prepare(
      'UPDATE workflow_runs SET status = ?, outputs_json = ?, node_states_json = ?, finished_at = ? WHERE id = ?'
    ).run(result.status, JSON.stringify(finalOutputs), JSON.stringify(allStates), timestamp(), runId)

    log.info(`WorkflowEngine: ${workflow.name} ${result.status} in ${result.durationMs}ms (${allStates.filter((s) => s.status === 'completed').length}/${allStates.length} nodes)`)
    return result
  }

  /** Topological sort via Kahn's algorithm. */
  private topologicalSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
    const inDegree = new Map<string, number>()
    const adj = new Map<string, string[]>()

    for (const node of nodes) {
      inDegree.set(node.id, 0)
      adj.set(node.id, [])
    }
    for (const edge of edges) {
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
      adj.get(edge.source)?.push(edge.target)
    }

    const queue = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id)
    const result: string[] = []

    while (queue.length > 0) {
      const current = queue.shift()!
      result.push(current)
      for (const neighbor of adj.get(current) || []) {
        const deg = (inDegree.get(neighbor) || 1) - 1
        inDegree.set(neighbor, deg)
        if (deg === 0) queue.push(neighbor)
      }
    }

    // If result is shorter than nodes, there's a cycle.
    if (result.length < nodes.length) {
      log.warn('WorkflowEngine: cycle detected in workflow graph')
    }

    return result
  }

  // ── Workflow CRUD ────────────────────────────────────────────────────

  saveWorkflow(workflow: Omit<Workflow, 'createdAt' | 'updatedAt'>): Workflow {
    const db = getDatabase()
    const now = timestamp()
    const existing = db.prepare('SELECT id FROM workflows WHERE id = ?').get(workflow.id)
    if (existing) {
      db.prepare(
        'UPDATE workflows SET name = ?, description = ?, nodes_json = ?, edges_json = ?, updated_at = ? WHERE id = ?'
      ).run(workflow.name, workflow.description, JSON.stringify(workflow.nodes), JSON.stringify(workflow.edges), now, workflow.id)
    } else {
      db.prepare(
        'INSERT INTO workflows (id, name, description, nodes_json, edges_json, is_preset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(workflow.id, workflow.name, workflow.description, JSON.stringify(workflow.nodes), JSON.stringify(workflow.edges), workflow.isPreset ? 1 : 0, now, now)
    }
    return { ...workflow, createdAt: now, updatedAt: now }
  }

  getWorkflow(id: string): Workflow | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as string, name: row.name as string,
      description: row.description as string | null,
      nodes: JSON.parse(row.nodes_json as string),
      edges: JSON.parse(row.edges_json as string),
      isPreset: (row.is_preset as number) === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }
  }

  listWorkflows(): Workflow[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM workflows ORDER BY is_preset DESC, updated_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row.id as string, name: row.name as string,
      description: row.description as string | null,
      nodes: JSON.parse(row.nodes_json as string),
      edges: JSON.parse(row.edges_json as string),
      isPreset: (row.is_preset as number) === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }))
  }

  deleteWorkflow(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM workflows WHERE id = ? AND is_preset = 0').run(id)
  }

  listRuns(workflowId?: string, limit: number = 20): Array<Record<string, unknown>> {
    const db = getDatabase()
    if (workflowId) {
      return db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?').all(workflowId, limit) as Array<Record<string, unknown>>
    }
    return db.prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  }
}

export const workflowEngine = new WorkflowEngineImpl()
