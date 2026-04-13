import { BrowserWindow } from 'electron'
import { getDatabase } from '../database'
import { intelEnricher } from './IntelEnricher'
import { vectorDbService } from '../vectordb/VectorDbService'
import { syncManager } from '../sync/SyncManager'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Multica-style background enrichment pipeline
// Polls for unenriched reports every 5s, processes with concurrency limit

const POLL_INTERVAL = 15000    // 15 seconds (was 5s — reduces DB churn 3x)
const MAX_CONCURRENT = 3       // Semaphore limit (was 5 — reduces CPU pressure)
const BATCH_SIZE = 50          // Reports per poll cycle

export class EnrichmentOrchestrator {
  private running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private activeCount = 0
  private stats = { queued: 0, enriched: 0, failed: 0, vectorized: 0 }

  start(): void {
    if (this.running) return
    this.running = true

    log.info('EnrichmentOrchestrator: starting background pipeline')

    // Initial run after 30s delay (let collectors finish first cycle)
    setTimeout(() => this.poll(), 30000)

    // Then poll every 5s
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL)
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    log.info(`EnrichmentOrchestrator: stopped (enriched: ${this.stats.enriched}, vectorized: ${this.stats.vectorized})`)
  }

  private async poll(): Promise<void> {
    if (!this.running || this.activeCount >= MAX_CONCURRENT) return

    try {
      const db = getDatabase()

      // Claim unenriched reports (no tags yet)
      const unenriched = db.prepare(`
        SELECT r.* FROM intel_reports r
        LEFT JOIN intel_tags t ON r.id = t.report_id
        WHERE t.report_id IS NULL
        ORDER BY r.created_at DESC
        LIMIT ?
      `).all(BATCH_SIZE) as Array<Record<string, unknown>>

      if (unenriched.length === 0) return

      this.stats.queued = unenriched.length
      syncManager.updateJob('enrichment', {
        status: 'running',
        total: unenriched.length,
        current: 0,
        progress: 0
      })

      this.emitProgress()

      // Process in batches respecting semaphore
      const available = MAX_CONCURRENT - this.activeCount
      const batch = unenriched.slice(0, available)

      const promises = batch.map(async (row) => {
        this.activeCount++
        try {
          const report = this.mapReport(row)

          // 1. Enrich (tags, entities, links, corroboration)
          intelEnricher.enrichReport(report)
          this.stats.enriched++

          // 2. Vectorize
          try {
            await vectorDbService.addReport(report)
            this.stats.vectorized++
          } catch {}

          syncManager.incrementProgress('enrichment')
        } catch (err) {
          this.stats.failed++
          log.debug(`Enrichment failed for ${row.id}: ${err}`)
        } finally {
          this.activeCount--
        }
      })

      await Promise.allSettled(promises)

      // Check if all done
      const remaining = db.prepare(`
        SELECT COUNT(*) as c FROM intel_reports r
        LEFT JOIN intel_tags t ON r.id = t.report_id
        WHERE t.report_id IS NULL
      `).get() as { c: number }

      if (remaining.c === 0) {
        syncManager.updateJob('enrichment', { status: 'completed' })
      }

      this.emitProgress()
    } catch (err) {
      log.debug(`EnrichmentOrchestrator poll error: ${err}`)
    }
  }

  getStats() {
    return { ...this.stats, active: this.activeCount, running: this.running }
  }

  private emitProgress(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('enrichment:progress', this.stats)
    }
  }

  private mapReport(row: Record<string, unknown>): IntelReport {
    return {
      id: row.id as string,
      discipline: row.discipline as IntelReport['discipline'],
      title: row.title as string,
      content: row.content as string,
      summary: row.summary as string | null,
      severity: row.severity as IntelReport['severity'],
      sourceId: row.source_id as string,
      sourceUrl: row.source_url as string | null,
      sourceName: row.source_name as string,
      contentHash: row.content_hash as string,
      latitude: row.latitude as number | null,
      longitude: row.longitude as number | null,
      verificationScore: row.verification_score as number,
      reviewed: (row.reviewed as number) === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number
    }
  }
}

export const enrichmentOrchestrator = new EnrichmentOrchestrator()
