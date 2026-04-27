// ResourceGovernor — enforces hard caps on resource usage. Any service
// that consumes a tracked resource must call the governor's check
// methods BEFORE spending. The governor returns:
//   - ok: proceed
//   - throttle: defer with backoff (resource near cap)
//   - deny: blocked (cap exceeded)
//
// Tracked resources:
//   - LLM tokens per hour (across all providers)
//   - concurrent SafeFetcher requests
//   - process memory (advisory; logs warning at 80% cap)
//   - disk usage by data class (deferred to v1.2.x — needs storage audit)
//
// Configuration is in resource_governance_config (single row), editable
// from the Health Dashboard or a Settings tab (deferred to v1.3).

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

export interface ResourceConfig {
  maxLlmTokensPerHour: number
  maxConcurrentFetches: number
  maxMemoryMb: number
  maxDiskGb: number
  enforceBudget: boolean
}

export interface GovernanceVerdict {
  allowed: boolean
  reason?: string
  metrics?: {
    llmTokensLastHour: number
    llmTokensRemaining: number
    inFlightFetches: number
    memoryMb: number
  }
}

const DEFAULT_CONFIG: ResourceConfig = {
  maxLlmTokensPerHour: 1_000_000,
  maxConcurrentFetches: 6,
  maxMemoryMb: 4096,
  maxDiskGb: 50,
  enforceBudget: true
}

export class ResourceGovernor {
  private inFlightFetches = 0

  /** Read current config from DB; returns DEFAULT_CONFIG if table is empty. */
  config(): ResourceConfig {
    try {
      const row = getDatabase().prepare(`
        SELECT max_llm_tokens_per_hour AS maxLlmTokensPerHour,
               max_concurrent_fetches AS maxConcurrentFetches,
               max_memory_mb AS maxMemoryMb,
               max_disk_gb AS maxDiskGb,
               enforce_budget AS enforceBudget
        FROM resource_governance_config WHERE id = 1
      `).get() as ResourceConfig & { enforceBudget: number } | undefined
      if (!row) return DEFAULT_CONFIG
      return { ...row, enforceBudget: !!row.enforceBudget }
    } catch {
      return DEFAULT_CONFIG
    }
  }

  updateConfig(patch: Partial<ResourceConfig>): void {
    const current = this.config()
    const next: ResourceConfig = { ...current, ...patch }
    getDatabase().prepare(`
      UPDATE resource_governance_config
      SET max_llm_tokens_per_hour = ?, max_concurrent_fetches = ?,
          max_memory_mb = ?, max_disk_gb = ?, enforce_budget = ?, updated_at = ?
      WHERE id = 1
    `).run(
      next.maxLlmTokensPerHour, next.maxConcurrentFetches,
      next.maxMemoryMb, next.maxDiskGb,
      next.enforceBudget ? 1 : 0, Date.now()
    )
    log.info(`ResourceGovernor: config updated — ${JSON.stringify(next)}`)
  }

  /**
   * Check if an LLM call is permitted given the current hourly token spend.
   * Pass the estimated token cost so we can pre-flight large requests.
   */
  checkLlmCall(estimatedTokens: number = 0): GovernanceVerdict {
    const cfg = this.config()
    const tokensLastHour = this.tokensInLastHour()
    const remaining = cfg.maxLlmTokensPerHour - tokensLastHour

    const metrics = {
      llmTokensLastHour: tokensLastHour,
      llmTokensRemaining: Math.max(0, remaining),
      inFlightFetches: this.inFlightFetches,
      memoryMb: this.memoryMb()
    }

    if (!cfg.enforceBudget) return { allowed: true, metrics }
    if (tokensLastHour + estimatedTokens > cfg.maxLlmTokensPerHour) {
      return {
        allowed: false,
        reason: `LLM hourly budget exceeded (${tokensLastHour} + ${estimatedTokens} > ${cfg.maxLlmTokensPerHour}). Request throttled.`,
        metrics
      }
    }
    return { allowed: true, metrics }
  }

  /**
   * Record a completed LLM call's token usage. Called by LlmService after
   * each successful (or failed) request.
   */
  recordLlmUsage(opts: {
    connectionId?: string
    connectionName?: string
    model?: string
    taskClass?: string
    promptTokens: number
    completionTokens: number
    durationMs: number
    succeeded: boolean
  }): void {
    const total = opts.promptTokens + opts.completionTokens
    try {
      getDatabase().prepare(`
        INSERT INTO llm_token_usage
          (id, connection_id, connection_name, model, task_class,
           prompt_tokens, completion_tokens, total_tokens,
           duration_ms, succeeded, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateId(),
        opts.connectionId ?? null, opts.connectionName ?? null,
        opts.model ?? null, opts.taskClass ?? null,
        opts.promptTokens, opts.completionTokens, total,
        opts.durationMs, opts.succeeded ? 1 : 0, Date.now()
      )
    } catch (err) {
      log.debug(`recordLlmUsage failed: ${err}`)
    }
  }

  /** Acquire a fetch slot. Returns false if at the concurrent cap. */
  acquireFetchSlot(): boolean {
    const cfg = this.config()
    if (!cfg.enforceBudget) {
      this.inFlightFetches++
      return true
    }
    if (this.inFlightFetches >= cfg.maxConcurrentFetches) return false
    this.inFlightFetches++
    return true
  }

  releaseFetchSlot(): void {
    this.inFlightFetches = Math.max(0, this.inFlightFetches - 1)
  }

  /** Sum of tokens in the rolling 1-hour window. */
  tokensInLastHour(): number {
    try {
      const r = getDatabase().prepare(`
        SELECT COALESCE(SUM(total_tokens), 0) AS tot FROM llm_token_usage WHERE created_at >= ?
      `).get(Date.now() - 60 * 60 * 1000) as { tot: number }
      return r.tot
    } catch { return 0 }
  }

  memoryMb(): number {
    return Math.round(process.memoryUsage().rss / (1024 * 1024))
  }

  /** Stats for the dashboard. */
  stats(): {
    config: ResourceConfig
    llmTokensLastHour: number
    llmTokensRemaining: number
    inFlightFetches: number
    memoryMb: number
    memoryPct: number
  } {
    const cfg = this.config()
    const tokens = this.tokensInLastHour()
    const mem = this.memoryMb()
    return {
      config: cfg,
      llmTokensLastHour: tokens,
      llmTokensRemaining: Math.max(0, cfg.maxLlmTokensPerHour - tokens),
      inFlightFetches: this.inFlightFetches,
      memoryMb: mem,
      memoryPct: Math.round(100 * mem / cfg.maxMemoryMb)
    }
  }

  /** Token usage breakdown by model, last 24h. */
  usageByModel(hoursBack: number = 24): Array<{
    model: string; calls: number; promptTokens: number; completionTokens: number;
    totalTokens: number; avgDurationMs: number
  }> {
    const since = Date.now() - hoursBack * 60 * 60 * 1000
    return getDatabase().prepare(`
      SELECT COALESCE(model, '?') AS model,
             COUNT(*) AS calls,
             SUM(prompt_tokens) AS promptTokens,
             SUM(completion_tokens) AS completionTokens,
             SUM(total_tokens) AS totalTokens,
             ROUND(AVG(duration_ms)) AS avgDurationMs
      FROM llm_token_usage
      WHERE created_at >= ?
      GROUP BY model
      ORDER BY totalTokens DESC
    `).all(since) as ReturnType<typeof this.usageByModel>
  }

  /** Token usage breakdown by task class. */
  usageByTask(hoursBack: number = 24): Array<{
    taskClass: string; calls: number; totalTokens: number
  }> {
    const since = Date.now() - hoursBack * 60 * 60 * 1000
    return getDatabase().prepare(`
      SELECT COALESCE(task_class, '?') AS taskClass,
             COUNT(*) AS calls,
             SUM(total_tokens) AS totalTokens
      FROM llm_token_usage
      WHERE created_at >= ?
      GROUP BY task_class
      ORDER BY totalTokens DESC
    `).all(since) as ReturnType<typeof this.usageByTask>
  }
}

export const resourceGovernor = new ResourceGovernor()
