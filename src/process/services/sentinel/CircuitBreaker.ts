// CircuitBreaker — wraps a fragile operation in a state machine that
// stops calling the operation when it's clearly failing, then probes
// periodically to see if it's recovered.
//
// State diagram:
//
//   ┌──────────┐  failures >= threshold   ┌──────────┐
//   │  CLOSED  │ ─────────────────────────▶│   OPEN   │
//   │ (normal) │                           │ (refuse) │
//   └────┬─────┘                           └─────┬────┘
//        │                                       │ cool-off elapsed
//        │              ┌──────────┐  failure    │
//        │       ┌──────│HALF_OPEN │◀────────────┘
//        │       │      │ (probe)  │
//        │       │      └────┬─────┘
//        │       │  success  │
//        │   reset            ▼
//        └──────────────  CLOSED
//
// The breaker state is persisted to circuit_breaker_state so it survives
// process restarts. Each circuit is identified by a string id (typically
// "<service>:<resource>" — e.g. "llm:openai" or "fetch:example.com").

import { getDatabase } from '../database'
import log from 'electron-log'

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitConfig {
  /** Consecutive failures that flip CLOSED → OPEN. Default 5. */
  failureThreshold: number
  /** Milliseconds to wait in OPEN before transitioning to HALF_OPEN. Default 60s. */
  cooldownMs: number
  /** Successful probes in HALF_OPEN required to flip back to CLOSED. Default 1. */
  successThreshold: number
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  successThreshold: 1
}

export class CircuitOpenError extends Error {
  constructor(public circuitId: string, public openedAt: number) {
    super(`Circuit "${circuitId}" is OPEN (since ${new Date(openedAt).toISOString()}) — call refused`)
    this.name = 'CircuitOpenError'
  }
}

interface BreakerRow {
  state: string
  failure_count: number
  success_count: number
  opened_at: number | null
  half_open_at: number | null
  last_failure_at: number | null
  last_failure_message: string | null
}

class CircuitBreaker {
  private cache = new Map<string, BreakerRow>()

  private getRow(circuitId: string): BreakerRow {
    if (this.cache.has(circuitId)) return this.cache.get(circuitId)!
    const db = getDatabase()
    const row = db.prepare(
      `SELECT state, failure_count, success_count, opened_at, half_open_at,
              last_failure_at, last_failure_message
       FROM circuit_breaker_state WHERE circuit_id = ?`
    ).get(circuitId) as BreakerRow | undefined
    if (row) {
      this.cache.set(circuitId, row)
      return row
    }
    const fresh: BreakerRow = {
      state: 'closed', failure_count: 0, success_count: 0,
      opened_at: null, half_open_at: null,
      last_failure_at: null, last_failure_message: null
    }
    db.prepare(`
      INSERT INTO circuit_breaker_state
        (circuit_id, state, failure_count, success_count)
      VALUES (?, 'closed', 0, 0)
    `).run(circuitId)
    this.cache.set(circuitId, fresh)
    return fresh
  }

  private save(circuitId: string, row: BreakerRow): void {
    this.cache.set(circuitId, row)
    getDatabase().prepare(`
      UPDATE circuit_breaker_state
      SET state = ?, failure_count = ?, success_count = ?,
          opened_at = ?, half_open_at = ?, last_failure_at = ?, last_failure_message = ?
      WHERE circuit_id = ?
    `).run(
      row.state, row.failure_count, row.success_count,
      row.opened_at, row.half_open_at, row.last_failure_at, row.last_failure_message,
      circuitId
    )
  }

  /**
   * Wrap an async operation in the circuit breaker. Throws CircuitOpenError
   * if the breaker is OPEN. Forwards any other thrown error through.
   */
  async run<T>(circuitId: string, fn: () => Promise<T>, config?: Partial<CircuitConfig>): Promise<T> {
    const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    let row = this.getRow(circuitId)
    const now = Date.now()

    // Maybe transition OPEN → HALF_OPEN if cooldown has elapsed
    if (row.state === 'open' && row.opened_at && now - row.opened_at >= cfg.cooldownMs) {
      row = { ...row, state: 'half_open', half_open_at: now, success_count: 0 }
      this.save(circuitId, row)
      log.info(`CircuitBreaker: ${circuitId} OPEN → HALF_OPEN (cooldown elapsed)`)
    }

    if (row.state === 'open') {
      throw new CircuitOpenError(circuitId, row.opened_at ?? now)
    }

    // Run the operation
    try {
      const result = await fn()
      this.recordSuccess(circuitId, cfg)
      return result
    } catch (err) {
      this.recordFailure(circuitId, err as Error, cfg)
      throw err
    }
  }

  private recordSuccess(circuitId: string, cfg: CircuitConfig): void {
    let row = this.getRow(circuitId)
    if (row.state === 'closed') {
      // Reset failure counter on success
      if (row.failure_count > 0) {
        row = { ...row, failure_count: 0, last_failure_message: null }
        this.save(circuitId, row)
      }
      return
    }
    if (row.state === 'half_open') {
      row = { ...row, success_count: row.success_count + 1 }
      if (row.success_count >= cfg.successThreshold) {
        row = {
          ...row, state: 'closed', failure_count: 0,
          opened_at: null, half_open_at: null
        }
        log.info(`CircuitBreaker: ${circuitId} HALF_OPEN → CLOSED (recovered)`)
      }
      this.save(circuitId, row)
    }
  }

  private recordFailure(circuitId: string, error: Error, cfg: CircuitConfig): void {
    let row = this.getRow(circuitId)
    const now = Date.now()
    const newFailureCount = row.failure_count + 1
    const message = error.message.slice(0, 500)

    if (row.state === 'half_open') {
      // Probe failed — back to OPEN
      row = {
        ...row, state: 'open', opened_at: now,
        half_open_at: null, failure_count: newFailureCount,
        success_count: 0, last_failure_at: now, last_failure_message: message
      }
      log.warn(`CircuitBreaker: ${circuitId} HALF_OPEN → OPEN (probe failed: ${message})`)
    } else {
      row = {
        ...row, failure_count: newFailureCount,
        last_failure_at: now, last_failure_message: message
      }
      if (newFailureCount >= cfg.failureThreshold) {
        row = { ...row, state: 'open', opened_at: now }
        log.warn(`CircuitBreaker: ${circuitId} CLOSED → OPEN (${newFailureCount} consecutive failures: ${message})`)
      }
    }
    this.save(circuitId, row)
  }

  /** Manually reset a circuit to CLOSED (operator override). */
  reset(circuitId: string): void {
    this.cache.delete(circuitId)
    const fresh: BreakerRow = {
      state: 'closed', failure_count: 0, success_count: 0,
      opened_at: null, half_open_at: null,
      last_failure_at: null, last_failure_message: null
    }
    this.save(circuitId, fresh)
    log.info(`CircuitBreaker: ${circuitId} manually reset to CLOSED`)
  }

  /** Get all circuits + their state for the dashboard. */
  list(): Array<{ circuitId: string; state: CircuitState; failureCount: number;
                  openedAt: number | null; lastFailureAt: number | null;
                  lastFailureMessage: string | null }> {
    return getDatabase().prepare(`
      SELECT circuit_id AS circuitId, state, failure_count AS failureCount,
             opened_at AS openedAt, last_failure_at AS lastFailureAt,
             last_failure_message AS lastFailureMessage
      FROM circuit_breaker_state
      ORDER BY
        CASE state WHEN 'open' THEN 0 WHEN 'half_open' THEN 1 ELSE 2 END,
        last_failure_at DESC NULLS LAST
    `).all() as Array<{
      circuitId: string; state: CircuitState; failureCount: number;
      openedAt: number | null; lastFailureAt: number | null;
      lastFailureMessage: string | null
    }>
  }
}

export const circuitBreaker = new CircuitBreaker()
