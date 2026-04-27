// SentinelSupervisor — the main watchdog. Polls the ServiceRegistry every
// 30s, evaluates each service's health, and triggers restart on failure
// with bounded retry (3 consecutive failures → restart; 5 restarts in
// 10min → disable auto-restart and require manual revive).
//
// Snapshots aggregate health into health_snapshots for the dashboard's
// historical chart (24h retention).

import { serviceRegistry, type ServiceState } from './ServiceRegistry'
import { getDatabase } from '../database'
import log from 'electron-log'

interface RestartTracking {
  recentRestartTimestamps: number[]   // ring of restart times in last 10 min
}

const POLL_INTERVAL_MS = 30_000
const SNAPSHOT_INTERVAL_MS = 60_000
const FAILURE_THRESHOLD_FOR_RESTART = 3
const MAX_RESTARTS_PER_WINDOW = 5
const RESTART_WINDOW_MS = 10 * 60 * 1000
const RESTART_TIMEOUT_MS = 30_000

export class SentinelSupervisor {
  private pollTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private retentionTimer: NodeJS.Timeout | null = null
  private restartTracking = new Map<string, RestartTracking>()
  private polling = false

  start(): void {
    if (this.pollTimer) return
    log.info('SentinelSupervisor: starting')

    // First poll after 5s to let services settle
    setTimeout(() => this.poll().catch((e) => log.warn(`sentinel poll: ${e}`)), 5_000)

    this.pollTimer = setInterval(
      () => this.poll().catch((e) => log.warn(`sentinel poll: ${e}`)),
      POLL_INTERVAL_MS
    )

    this.snapshotTimer = setInterval(
      () => this.takeSnapshot().catch((e) => log.debug(`sentinel snapshot: ${e}`)),
      SNAPSHOT_INTERVAL_MS
    )

    // Hourly retention cleanup
    this.retentionTimer = setInterval(
      () => this.pruneOldData().catch((e) => log.debug(`sentinel prune: ${e}`)),
      60 * 60 * 1000
    )
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    this.pollTimer = null
    this.snapshotTimer = null
    this.retentionTimer = null
    log.info('SentinelSupervisor: stopped')
  }

  /** Run a single poll cycle. */
  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const services = serviceRegistry.list()
      for (const svc of services) {
        try {
          const result = await this.runHealthCheck(svc.id, svc.healthCheck)
          serviceRegistry.recordState(svc.id, result)

          // Restart logic — only if the service is failed AND we have a restart hook
          // AND auto-restart is enabled AND we've crossed the failure threshold.
          if (result.state === 'failed' && svc.restart && svc.autoRestart !== false) {
            const health = serviceRegistry.getHealth(svc.id)
            if (!health || health.restart_disabled) continue
            if (health.consecutive_failures >= FAILURE_THRESHOLD_FOR_RESTART) {
              if (this.shouldRestart(svc.id)) {
                await this.attemptRestart(svc.id, svc.displayName, svc.restart, health.state)
              } else {
                serviceRegistry.disableAutoRestart(svc.id, `${MAX_RESTARTS_PER_WINDOW} restarts in 10 min — circuit broken`)
              }
            }
          }
        } catch (err) {
          // Health check itself crashed — record as failed
          serviceRegistry.recordState(svc.id, {
            state: 'failed',
            detail: `healthCheck() threw: ${(err as Error).message}`
          })
        }
      }
    } finally {
      this.polling = false
    }
  }

  /** Run one health check with a timeout so a stuck check can't hang the loop. */
  private async runHealthCheck(serviceId: string, fn: () => Promise<unknown> | unknown): Promise<{ state: ServiceState; detail?: string; metadata?: Record<string, unknown> }> {
    return Promise.race([
      Promise.resolve(fn()).then((r) => r as { state: ServiceState; detail?: string; metadata?: Record<string, unknown> }),
      new Promise<{ state: ServiceState; detail: string }>((_, reject) =>
        setTimeout(() => reject(new Error('healthCheck timeout (5s)')), 5000))
    ]).catch((err) => ({
      state: 'failed' as ServiceState,
      detail: `${serviceId} health check failed: ${(err as Error).message}`
    }))
  }

  private shouldRestart(serviceId: string): boolean {
    const t = this.restartTracking.get(serviceId) ?? { recentRestartTimestamps: [] }
    const now = Date.now()
    // Drop entries outside the window
    t.recentRestartTimestamps = t.recentRestartTimestamps.filter((ts) => now - ts < RESTART_WINDOW_MS)
    this.restartTracking.set(serviceId, t)
    return t.recentRestartTimestamps.length < MAX_RESTARTS_PER_WINDOW
  }

  private async attemptRestart(
    serviceId: string,
    displayName: string,
    restartFn: () => Promise<void> | void,
    previousState: string
  ): Promise<void> {
    const start = Date.now()
    const tracking = this.restartTracking.get(serviceId) ?? { recentRestartTimestamps: [] }
    tracking.recentRestartTimestamps.push(start)
    this.restartTracking.set(serviceId, tracking)

    log.info(`Sentinel: attempting restart of ${displayName} (${serviceId})`)
    let succeeded = false
    let reason = 'consecutive failures threshold reached'
    try {
      await Promise.race([
        Promise.resolve(restartFn()),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('restart timeout')), RESTART_TIMEOUT_MS))
      ])
      succeeded = true
      log.info(`Sentinel: ${serviceId} restarted successfully in ${Date.now() - start}ms`)
    } catch (err) {
      reason = `restart failed: ${(err as Error).message}`
      log.warn(`Sentinel: ${serviceId} restart failed — ${reason}`)
    }

    serviceRegistry.recordRestart(serviceId, {
      triggeredBy: 'sentinel',
      previousState,
      reason,
      succeeded,
      durationMs: Date.now() - start
    })
  }

  /** Manual restart trigger from the UI. */
  async manualRestart(serviceId: string): Promise<{ ok: boolean; error?: string }> {
    const svc = serviceRegistry.get(serviceId)
    if (!svc) return { ok: false, error: 'service not registered' }
    if (!svc.restart) return { ok: false, error: 'service has no restart hook' }

    const start = Date.now()
    const health = serviceRegistry.getHealth(serviceId)
    try {
      await svc.restart()
      serviceRegistry.recordRestart(serviceId, {
        triggeredBy: 'manual',
        previousState: health?.state ?? null,
        reason: 'manual revive from UI',
        succeeded: true,
        durationMs: Date.now() - start
      })
      // Re-enable auto-restart if it was circuit-broken
      if (health?.restart_disabled) serviceRegistry.enableAutoRestart(serviceId)
      return { ok: true }
    } catch (err) {
      serviceRegistry.recordRestart(serviceId, {
        triggeredBy: 'manual',
        previousState: health?.state ?? null,
        reason: `manual restart failed: ${(err as Error).message}`,
        succeeded: false,
        durationMs: Date.now() - start
      })
      return { ok: false, error: (err as Error).message }
    }
  }

  /** Take an aggregate health snapshot. */
  async takeSnapshot(): Promise<void> {
    const db = getDatabase()
    const all = serviceRegistry.allHealth()
    const running = all.filter((h) => h.state === 'running').length
    const degraded = all.filter((h) => h.state === 'degraded').length
    const failed = all.filter((h) => h.state === 'failed').length

    // Best-effort runtime metrics
    const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024))

    // Token usage in last hour
    const sinceHr = Date.now() - 60 * 60 * 1000
    const tokenRow = db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) AS tot
      FROM llm_token_usage WHERE created_at >= ?
    `).get(sinceHr) as { tot: number }

    // Enrichment queue depth (best-effort: count pending intel_reports
    // that haven't been enriched). Soft-fails if column doesn't exist.
    let queueDepth = 0
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM intel_reports WHERE enrichment_status IS NULL OR enrichment_status = 'pending'`).get() as { n: number }
      queueDepth = r.n
    } catch { /* */ }

    db.prepare(`
      INSERT INTO health_snapshots
        (taken_at, services_running, services_degraded, services_failed,
         collectors_pending, enrichment_queue_depth, memory_mb, llm_tokens_last_hour)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(Date.now(), running, degraded, failed, queueDepth, memoryMb, tokenRow.tot)
  }

  /** Drop snapshots older than 24h + LLM token usage older than 30d. */
  async pruneOldData(): Promise<void> {
    const db = getDatabase()
    const snapCutoff = Date.now() - 24 * 60 * 60 * 1000
    const usageCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const restartCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    db.prepare(`DELETE FROM health_snapshots WHERE taken_at < ?`).run(snapCutoff)
    db.prepare(`DELETE FROM llm_token_usage WHERE created_at < ?`).run(usageCutoff)
    db.prepare(`DELETE FROM service_restart_history WHERE created_at < ?`).run(restartCutoff)
  }

  /** Snapshots for the dashboard chart. */
  recentSnapshots(limit: number = 60): Array<{
    takenAt: number; servicesRunning: number; servicesDegraded: number;
    servicesFailed: number; enrichmentQueueDepth: number;
    memoryMb: number | null; llmTokensLastHour: number
  }> {
    return getDatabase().prepare(`
      SELECT taken_at AS takenAt, services_running AS servicesRunning,
             services_degraded AS servicesDegraded, services_failed AS servicesFailed,
             enrichment_queue_depth AS enrichmentQueueDepth, memory_mb AS memoryMb,
             llm_tokens_last_hour AS llmTokensLastHour
      FROM health_snapshots
      ORDER BY taken_at DESC
      LIMIT ?
    `).all(limit) as ReturnType<typeof this.recentSnapshots>
  }
}

export const sentinelSupervisor = new SentinelSupervisor()
