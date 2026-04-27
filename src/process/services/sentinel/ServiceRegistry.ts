// ServiceRegistry — central registry every long-running service registers
// itself with at boot. SentinelSupervisor uses this registry to poll
// health, log state transitions, and trigger restarts on failure.
//
// Design:
//   - In-memory map of service descriptors (the runtime authoritative source)
//   - Mirrored to service_health table for the UI / persistence
//   - Each service implements healthCheck() + optional restart()
//   - State transitions are logged to service_restart_history
//
// A "service" is any long-running component:
//   - collectors (per-source instances)
//   - enrichment orchestrator
//   - LLM connection pool
//   - cron scheduler
//   - Tor service
//   - MCP client manager
//   - calibration loops (indicator tracker, auto-revision)

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

export type ServiceCategory = 'collector' | 'enrichment' | 'llm' | 'sync' | 'infrastructure' | 'calibration' | 'training'

export type ServiceState = 'running' | 'degraded' | 'failed' | 'stopped' | 'unknown'

export interface HealthCheckResult {
  state: ServiceState
  detail?: string
  metadata?: Record<string, unknown>
}

export interface ServiceDescriptor {
  id: string
  displayName: string
  category: ServiceCategory
  /** Returns the current health state. Should be cheap (< 100ms). */
  healthCheck: () => Promise<HealthCheckResult> | HealthCheckResult
  /** Optional restart hook. If absent, Sentinel can only mark failures, not recover. */
  restart?: () => Promise<void> | void
  /** If true, Sentinel will NEVER auto-restart this service. Manual revive only. */
  autoRestart?: boolean
}

export interface ServiceHealthRow {
  service_id: string
  display_name: string
  category: string
  state: string
  last_check_at: number | null
  last_state_change_at: number | null
  last_error: string | null
  consecutive_failures: number
  restart_count: number
  restart_disabled: number
  uptime_started_at: number | null
  metadata_json: string | null
}

export class ServiceRegistry {
  private services = new Map<string, ServiceDescriptor>()

  register(descriptor: ServiceDescriptor): void {
    if (this.services.has(descriptor.id)) {
      log.warn(`ServiceRegistry: ${descriptor.id} already registered (overwriting)`)
    }
    this.services.set(descriptor.id, descriptor)

    // Upsert the health row so the UI sees it immediately
    const db = getDatabase()
    const now = Date.now()
    try {
      db.prepare(`
        INSERT INTO service_health
          (service_id, display_name, category, state, last_state_change_at, uptime_started_at)
        VALUES (?, ?, ?, 'unknown', ?, ?)
        ON CONFLICT(service_id) DO UPDATE SET
          display_name = excluded.display_name,
          category = excluded.category
      `).run(descriptor.id, descriptor.displayName, descriptor.category, now, now)
    } catch (err) {
      log.debug(`service_health upsert failed: ${err}`)
    }
    log.info(`Sentinel: registered ${descriptor.id} (${descriptor.category})`)
  }

  unregister(id: string): void {
    this.services.delete(id)
  }

  list(): ServiceDescriptor[] {
    return Array.from(this.services.values())
  }

  get(id: string): ServiceDescriptor | undefined {
    return this.services.get(id)
  }

  /** Read the current persisted health row (returns null if unregistered). */
  getHealth(id: string): ServiceHealthRow | null {
    const row = getDatabase().prepare(
      `SELECT * FROM service_health WHERE service_id = ?`
    ).get(id) as ServiceHealthRow | undefined
    return row ?? null
  }

  /** All persisted health rows for the dashboard. */
  allHealth(): ServiceHealthRow[] {
    return getDatabase().prepare(
      `SELECT * FROM service_health ORDER BY category, display_name`
    ).all() as ServiceHealthRow[]
  }

  /** Persist a state change with delta logging. */
  recordState(id: string, result: HealthCheckResult): void {
    const db = getDatabase()
    const now = Date.now()
    const existing = this.getHealth(id)
    const stateChanged = existing?.state !== result.state
    const isFailure = result.state === 'failed' || result.state === 'degraded'

    db.prepare(`
      UPDATE service_health
      SET state = ?,
          last_check_at = ?,
          last_state_change_at = CASE WHEN state != ? THEN ? ELSE last_state_change_at END,
          last_error = ?,
          consecutive_failures = CASE
            WHEN ? = 'failed' THEN consecutive_failures + 1
            WHEN ? = 'running' THEN 0
            ELSE consecutive_failures
          END,
          metadata_json = ?
      WHERE service_id = ?
    `).run(
      result.state,
      now,
      result.state, now,
      isFailure ? (result.detail ?? null) : null,
      result.state, result.state,
      result.metadata ? JSON.stringify(result.metadata) : null,
      id
    )

    if (stateChanged) {
      log.info(`Sentinel: ${id} ${existing?.state ?? '?'} → ${result.state}${result.detail ? ` (${result.detail})` : ''}`)
    }
  }

  /** Append a restart event to history. */
  recordRestart(id: string, opts: {
    triggeredBy: 'sentinel' | 'manual' | 'health-check'
    previousState: string | null
    reason: string
    succeeded: boolean
    durationMs: number
  }): void {
    const db = getDatabase()
    try {
      db.prepare(`
        INSERT INTO service_restart_history
          (id, service_id, triggered_by, previous_state, reason, succeeded, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(generateId(), id, opts.triggeredBy, opts.previousState, opts.reason,
        opts.succeeded ? 1 : 0, opts.durationMs, Date.now())

      if (opts.succeeded) {
        db.prepare(`
          UPDATE service_health
          SET restart_count = restart_count + 1,
              uptime_started_at = ?,
              consecutive_failures = 0
          WHERE service_id = ?
        `).run(Date.now(), id)
      }
    } catch (err) { log.debug(`restart history insert failed: ${err}`) }
  }

  /** Disable auto-restart for a service (manual revive required). */
  disableAutoRestart(id: string, reason: string): void {
    const db = getDatabase()
    db.prepare(`UPDATE service_health SET restart_disabled = 1, last_error = ? WHERE service_id = ?`)
      .run(`auto-restart disabled: ${reason}`, id)
    log.warn(`Sentinel: ${id} auto-restart disabled (${reason})`)
  }

  enableAutoRestart(id: string): void {
    getDatabase().prepare(`UPDATE service_health SET restart_disabled = 0, consecutive_failures = 0 WHERE service_id = ?`).run(id)
    log.info(`Sentinel: ${id} auto-restart re-enabled`)
  }

  /** Recent restart history for the dashboard. */
  recentRestarts(limit: number = 50): Array<{
    id: string; serviceId: string; serviceDisplayName: string | null;
    triggeredBy: string; previousState: string | null; reason: string;
    succeeded: boolean; durationMs: number; createdAt: number
  }> {
    return getDatabase().prepare(`
      SELECT srh.id, srh.service_id AS serviceId, sh.display_name AS serviceDisplayName,
             srh.triggered_by AS triggeredBy, srh.previous_state AS previousState,
             srh.reason, srh.succeeded, srh.duration_ms AS durationMs,
             srh.created_at AS createdAt
      FROM service_restart_history srh
      LEFT JOIN service_health sh ON sh.service_id = srh.service_id
      ORDER BY srh.created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: string; serviceId: string; serviceDisplayName: string | null;
      triggeredBy: string; previousState: string | null; reason: string;
      succeeded: 0 | 1; durationMs: number; createdAt: number
    }>
  }
}

export const serviceRegistry = new ServiceRegistry()
