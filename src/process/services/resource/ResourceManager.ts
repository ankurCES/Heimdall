import log from 'electron-log'

const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

export class ResourceManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  start(): void {
    if (this.running) return
    this.running = true

    // First cleanup after 2 minutes
    setTimeout(() => this.runCleanup(), 120_000)

    this.timer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL)
    log.info('ResourceManager: started (cleanup every 5 min)')
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log.info('ResourceManager: stopped')
  }

  async runCleanup(): Promise<void> {
    const before = process.memoryUsage()

    try {
      // 1. WAL checkpoint
      this.walCheckpoint()

      // 2. Prune rate limiter stale buckets
      this.pruneRateLimiter()

      // 3. Prune robots cache
      this.pruneRobotsCache()

      // 4. Prune old sync_log entries (> 30 days)
      this.pruneSyncLog()

      // 5. PERF (v1.3.2 — finding D1): retention for audit_log + tool_call_logs.
      // Both tables grow ~10-50k rows/day under normal collector activity
      // and have no other prune. The chained variant audit_log_chained is
      // intentionally untouched (tamper-evident).
      this.pruneAuditLog()
      this.pruneToolCallLogs()
      this.pruneInMemoryCaches()

      // PERF (v1.3.2 — finding D6): removed dead `global.gc()` call.
      // Electron doesn't expose --expose-gc by default, so this was a no-op
      // in production and a 50-200ms pause-the-world in dev when it did fire.
    } catch (err) {
      log.debug(`ResourceManager cleanup error: ${err}`)
    }

    const after = process.memoryUsage()
    const freedMB = ((before.heapUsed - after.heapUsed) / 1024 / 1024).toFixed(1)

    log.info(
      `ResourceManager: cleanup done | heap: ${(after.heapUsed / 1024 / 1024).toFixed(0)}MB ` +
      `| rss: ${(after.rss / 1024 / 1024).toFixed(0)}MB | freed: ${freedMB}MB`
    )
  }

  getStats(): { heapUsedMB: number; rssMB: number; externalMB: number } {
    const mem = process.memoryUsage()
    return {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024)
    }
  }

  private walCheckpoint(): void {
    try {
      const { getDatabase } = require('../database')
      const db = getDatabase()
      db.pragma('wal_checkpoint(PASSIVE)')
    } catch {}
  }

  private pruneRateLimiter(): void {
    try {
      const { safeFetcher } = require('../../collectors/SafeFetcher')
      safeFetcher.pruneStale()
    } catch {}
  }

  private pruneRobotsCache(): void {
    try {
      const { safeFetcher } = require('../../collectors/SafeFetcher')
      safeFetcher.pruneRobotsCache()
    } catch {}
  }

  private pruneSyncLog(): void {
    try {
      const { getDatabase } = require('../database')
      const db = getDatabase()
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
      const result = db.prepare('DELETE FROM sync_log WHERE synced_at < ?').run(thirtyDaysAgo)
      if (result.changes > 0) {
        log.info(`ResourceManager: pruned ${result.changes} old sync_log entries`)
      }
    } catch {}
  }

  /** PERF v1.3.2 D1: drop audit rows >30d. The chained variant is preserved. */
  private pruneAuditLog(): void {
    try {
      const { getDatabase } = require('../database')
      const db = getDatabase()
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const r = db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff)
      if (r.changes > 0) log.info(`ResourceManager: pruned ${r.changes} audit_log rows`)
    } catch { /* table may not exist on fresh installs */ }
  }

  /** PERF v1.3.2 D1: drop tool_call_logs >30d. */
  private pruneToolCallLogs(): void {
    try {
      const { getDatabase } = require('../database')
      const db = getDatabase()
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const r = db.prepare('DELETE FROM tool_call_logs WHERE created_at < ?').run(cutoff)
      if (r.changes > 0) log.info(`ResourceManager: pruned ${r.changes} tool_call_logs rows`)
    } catch { /* */ }
  }

  /**
   * PERF v1.3.2 D2: trim long-running in-memory caches that don't have
   * their own eviction. KnowledgeGraphContext + QueryPlanner LLM caches
   * accumulate per-query entries forever otherwise.
   */
  private pruneInMemoryCaches(): void {
    try {
      const m = require('../llm/KnowledgeGraphContext') as {
        knowledgeGraphContext?: { _CACHE_PRUNE?: () => void }
      }
      m.knowledgeGraphContext?._CACHE_PRUNE?.()
    } catch { /* */ }
    try {
      const m = require('../intel/QueryPlanner') as {
        queryPlanner?: { _CACHE_PRUNE?: () => void }
      }
      m.queryPlanner?._CACHE_PRUNE?.()
    } catch { /* */ }
  }
}

export const resourceManager = new ResourceManager()
