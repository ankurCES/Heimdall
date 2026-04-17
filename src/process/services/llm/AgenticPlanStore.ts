import type { ChatMessage } from './LlmService'
import { generateId } from '@common/utils/id'

/**
 * Transient in-memory storage for plans pending user approval.
 *
 * The chat flow is:
 *   1. `chat:planRequest`  — orchestrator builds a plan + refined queries,
 *      stores it here keyed by planId, returns the preview to the renderer.
 *   2. Renderer shows PlanApprovalModal, user approves / reworks / cancels.
 *   3. `chat:executePlan` — looks up the plan by id, applies user edits
 *      (disabled tool calls, edited queries, approval comments), runs the
 *      approved tool calls, and synthesises the briefing.
 *
 * Plans expire after 30 min so abandoned plans don't accumulate.
 */

export interface PlanStep {
  task: string
  searchTerms: string[]
  discipline: string
}

/** A single tool invocation proposed to the user. The `id` is stable so the
 *  modal can toggle it off / edit its query and reference it in the
 *  PlanEdits payload. */
export interface ProposedToolCall {
  id: string
  tool: string                          // e.g. "vector_search", "ahmia_search", "mcp:wikipedia:search"
  group: 'internal' | 'web' | 'darkweb' | 'mcp' | 'cve' | 'domain'
  label: string                         // human-readable name shown in the modal
  reason: string                        // why we proposed this tool for this query
  query: string                         // the refined query the analyst can edit
  params?: Record<string, unknown>      // extra params (e.g. { discipline })
  enabled: boolean
}

export interface PlanPreview {
  planId: string
  sessionId: string
  query: string
  steps: PlanStep[]
  proposedCalls: ProposedToolCall[]
  reworkHistory: Array<{ feedback: string; at: number }>
  createdAt: number
}

interface StoredPlan extends PlanPreview {
  /** Snapshot of conversation history at planning time so executePlan
   *  doesn't need the renderer to re-send it. */
  history: ChatMessage[]
  connectionId?: string
}

class AgenticPlanStoreImpl {
  private plans = new Map<string, StoredPlan>()
  private readonly TTL_MS = 30 * 60_000

  put(plan: PlanPreview, history: ChatMessage[], connectionId?: string): void {
    this.plans.set(plan.planId, { ...plan, history, connectionId })
    this.prune()
  }

  /** Look up a plan; returns null if missing or expired. */
  get(planId: string): StoredPlan | null {
    const p = this.plans.get(planId)
    if (!p) return null
    if (Date.now() - p.createdAt > this.TTL_MS) {
      this.plans.delete(planId)
      return null
    }
    return p
  }

  addReworkFeedback(planId: string, feedback: string): void {
    const p = this.plans.get(planId)
    if (!p) return
    p.reworkHistory.push({ feedback, at: Date.now() })
  }

  remove(planId: string): void {
    this.plans.delete(planId)
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, p] of this.plans) {
      if (now - p.createdAt > this.TTL_MS) this.plans.delete(id)
    }
  }
}

export const agenticPlanStore = new AgenticPlanStoreImpl()

/** Convenience: build a fresh ProposedToolCall with a generated id. */
export function makeCall(
  tool: string,
  group: ProposedToolCall['group'],
  label: string,
  reason: string,
  query: string,
  params?: Record<string, unknown>
): ProposedToolCall {
  return { id: generateId(), tool, group, label, reason, query, params, enabled: true }
}
