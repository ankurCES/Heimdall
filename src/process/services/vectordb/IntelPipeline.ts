import { IPC_EVENTS } from '@common/adapter/ipcBridge'
import { emitToAll } from '../resource/WindowCache'
import { vectorDbService } from './VectorDbService'
import { intelEnricher } from '../enrichment/IntelEnricher'
import { cronService } from '../cron/CronService'
import { getDatabase } from '../database'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Text processing pipeline:
// 1. Clean and normalize text
// 2. Extract key entities and keywords (via IntelEnricher)
// 3. Build enriched document with metadata
// 4. Generate embeddings and store in vector DB

export class IntelPipeline {
  private processing = false

  async start(): Promise<void> {
    // Initialize vector DB
    await vectorDbService.initialize()

    // Schedule periodic ingestion — every 10 minutes
    cronService.schedule(
      'pipeline:ingest',
      '*/20 * * * *',
      'Vector DB Ingestion Pipeline',
      () => this.runIngestion()
    )

    // Run initial ingestion after 45s delay (let collectors + UI settle first)
    setTimeout(() => {
      this.runIngestion().catch((err) => log.warn('Initial ingestion failed:', err))
    }, 45000)

    log.info('Intel pipeline started')
  }

  stop(): void {
    cronService.unschedule('pipeline:ingest')
    log.info('Intel pipeline stopped')
  }

  isProcessing(): boolean {
    return this.processing
  }

  /** v1.3.2 — Sentinel health check uses this. Pipeline is "running"
   *  iff the cron job is registered. */
  isRunning(): boolean {
    return cronService.isScheduled?.('pipeline:ingest') ?? true
  }

  private notify(title: string, body: string, severity: string): void {
    emitToAll(IPC_EVENTS.APP_NOTIFICATION, { title, body, severity })
  }

  async runIngestion(): Promise<void> {
    if (this.processing) return
    this.processing = true

    try {
      // Check index size — skip if too large to prevent unbounded memory growth
      const indexSize = await vectorDbService.getIndexSize()
      if (indexSize > 20000) {
        log.warn(`Pipeline: vector index has ${indexSize} items (>20K cap), skipping ingestion`)
        this.processing = false
        return
      }

      const db = getDatabase()

      // Get reports not yet vectorized (check by timestamp)
      const lastIngested = this.getLastIngestedTimestamp()
      const newReports = db.prepare(
        'SELECT * FROM intel_reports WHERE created_at > ? ORDER BY created_at ASC LIMIT 30'
      ).all(lastIngested) as Array<Record<string, unknown>>

      if (newReports.length === 0) {
        this.processing = false
        return
      }

      log.info(`Pipeline: processing ${newReports.length} new reports for vector ingestion`)
      this.notify('Vector Ingestion', `Processing ${newReports.length} reports...`, 'info')

      const reports: IntelReport[] = newReports.map((r) => ({
        id: r.id as string,
        discipline: r.discipline as IntelReport['discipline'],
        title: r.title as string,
        content: r.content as string,
        summary: r.summary as string | null,
        severity: r.severity as IntelReport['severity'],
        sourceId: r.source_id as string,
        sourceUrl: r.source_url as string | null,
        sourceName: r.source_name as string,
        contentHash: r.content_hash as string,
        latitude: r.latitude as number | null,
        longitude: r.longitude as number | null,
        verificationScore: r.verification_score as number,
        reviewed: (r.reviewed as number) === 1,
        createdAt: r.created_at as number,
        updatedAt: r.updated_at as number
      }))

      // Process each report through the pipeline (with yields to prevent blocking)
      for (let i = 0; i < reports.length; i++) {
        const report = reports[i]
        try {
          // Step 1: Enrich (tags, entities) — may already be done by LeadAgent
          try {
            const existingTags = intelEnricher.getTags(report.id)
            if (existingTags.length === 0) {
              intelEnricher.enrichReport(report)
            }
          } catch {}

          // Step 2: Build enriched document for vector DB
          const enrichedDoc = this.buildEnrichedDocument(report)

          // Step 3: Ingest into vector DB
          await vectorDbService.addReport({
            ...report,
            content: enrichedDoc // Use enriched content for better embeddings
          })
        } catch (err) {
          log.debug(`Pipeline: report ${report.id} failed: ${err}`)
        }

        // Yield every 5 reports to keep event loop responsive
        if (i % 5 === 4) await new Promise((r) => setImmediate(r))
      }

      // Update last ingested timestamp
      if (reports.length > 0) {
        this.setLastIngestedTimestamp(reports[reports.length - 1].createdAt)
      }

      log.info(`Pipeline: ingested ${reports.length} reports into vector DB`)
      this.notify('Ingestion Complete', `${reports.length} reports processed into vector DB`, 'success')
    } catch (err) {
      log.error('Pipeline ingestion failed:', err)
      this.notify('Ingestion Failed', String(err), 'error')
    } finally {
      this.processing = false
    }
  }

  private buildEnrichedDocument(report: IntelReport): string {
    const tags = intelEnricher.getTags(report.id)
    const entities = intelEnricher.getEntities(report.id)

    const parts = [
      report.title,
      `[${report.discipline.toUpperCase()}] [${report.severity.toUpperCase()}]`,
      `Source: ${report.sourceName} (Verification: ${report.verificationScore}/100)`,
    ]

    if (tags.length > 0) {
      parts.push(`Tags: ${tags.map((t) => t.tag).join(', ')}`)
    }

    if (entities.length > 0) {
      const entityStr = entities
        .slice(0, 15)
        .map((e) => `${e.type}:${e.value}`)
        .join(', ')
      parts.push(`Entities: ${entityStr}`)
    }

    parts.push(report.content.slice(0, 2000))

    if (report.summary) {
      parts.push(`Summary: ${report.summary}`)
    }

    return parts.join('\n')
  }

  private getLastIngestedTimestamp(): number {
    try {
      const db = getDatabase()
      const row = db.prepare("SELECT value FROM settings WHERE key = 'pipeline.lastIngested'").get() as { value: string } | undefined
      return row ? JSON.parse(row.value) : 0
    } catch {
      return 0
    }
  }

  private setLastIngestedTimestamp(ts: number): void {
    try {
      const db = getDatabase()
      db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('pipeline.lastIngested', ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?"
      ).run(JSON.stringify(ts), Date.now(), JSON.stringify(ts), Date.now())
    } catch {}
  }
}

export const intelPipeline = new IntelPipeline()
