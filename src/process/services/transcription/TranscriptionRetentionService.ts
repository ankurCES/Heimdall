// TranscriptionRetentionService — v1.5.0 storage hygiene + compliance.
//
// Long-running deployments accumulate transcripts. Surveillance feeds,
// daily standups, automated meeting recorders — left running, the
// transcripts table grows linearly and the userData/recordings/
// directory follows along. Compliance frameworks (NIST 800-53, GDPR
// art. 5.1.e) explicitly forbid keeping personal data longer than
// necessary, so we need a defensible retention story.
//
// What this service does:
//   - Reads `transcription.retentionDays` from settings every tick
//     (default 0 = "keep forever"; off by design)
//   - Deletes transcript rows whose ingested_at < cutoff
//   - Deletes the underlying recording file when source_kind = 'file'
//     AND the path is inside <userData>/recordings/ (we never delete
//     analyst-supplied paths outside our managed dir)
//   - Audit-logs each purge with a sha256 prefix of the original
//     full_text for provenance
//
// Cron is daily by default (02:30 server time). Skipped entirely when
// retentionDays <= 0 so the service is genuinely a no-op for analysts
// who don't opt in.

import { app } from 'electron'
import path from 'path'
import { unlink } from 'fs/promises'
import crypto from 'crypto'
import log from 'electron-log'
import { getDatabase, isDatabaseReady } from '../database'
import { settingsService } from '../settings/SettingsService'
import { auditService } from '../audit/AuditService'
import { cronService } from '../cron/CronService'

interface RetentionRow {
  id: string
  source_path: string
  source_kind: string
  full_text: string | null
  ingested_at: number
}

const DEFAULT_CRON = '30 2 * * *'   // 02:30 daily

export class TranscriptionRetentionService {
  private cronId = 'transcription-retention-purge'
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    cronService.schedule(this.cronId, DEFAULT_CRON, 'Transcription retention purge', async () => {
      await this.runPurge().catch((err) =>
        log.warn(`transcription-retention: purge failed: ${(err as Error).message}`)
      )
    })
  }

  stop(): void {
    if (!this.started) return
    cronService.unschedule(this.cronId)
    this.started = false
  }

  /** One-shot purge that the cron tick (and the manual "Purge now"
   *  button) calls. Idempotent. Returns counts for the UI. */
  async runPurge(): Promise<{ ok: boolean; deleted: number; freedFiles: number; reason?: string }> {
    if (!isDatabaseReady()) return { ok: false, deleted: 0, freedFiles: 0, reason: 'db not ready' }
    const days = settingsService.get<number>('transcription.retentionDays') ?? 0
    if (!days || days <= 0) {
      return { ok: true, deleted: 0, freedFiles: 0, reason: 'retention disabled' }
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const db = getDatabase()
    const stale = db.prepare(`
      SELECT id, source_path, source_kind, full_text, ingested_at
      FROM transcripts WHERE ingested_at < ?
    `).all(cutoff) as RetentionRow[]
    if (stale.length === 0) return { ok: true, deleted: 0, freedFiles: 0 }

    log.info(`transcription-retention: ${stale.length} transcript(s) older than ${days}d — purging`)

    const recordingsRoot = path.join(app.getPath('userData'), 'recordings')
    let freedFiles = 0
    const del = db.prepare('DELETE FROM transcripts WHERE id = ?')
    const tx = db.transaction((rows: RetentionRow[]) => {
      for (const row of rows) del.run(row.id)
    })
    tx(stale)

    for (const row of stale) {
      // Only delete files we own (under userData/recordings/). Analyst-
      // supplied paths from `Choose file…` or drag-drop are left alone.
      if (row.source_kind === 'file' && row.source_path.startsWith(recordingsRoot)) {
        try {
          await unlink(row.source_path)
          freedFiles++
        } catch (err) {
          log.debug(`transcription-retention: file unlink failed for ${row.source_path}: ${(err as Error).message}`)
        }
      }
      try {
        const hashPrefix = crypto.createHash('sha256')
          .update(row.full_text ?? '').digest('hex').slice(0, 16)
        auditService.log('transcript.retention_purged', {
          transcript_id: row.id, age_days: Math.floor((Date.now() - row.ingested_at) / 86_400_000),
          content_sha256_prefix: hashPrefix
        })
      } catch { /* */ }
    }

    log.info(`transcription-retention: deleted ${stale.length} row(s), ${freedFiles} file(s) freed`)
    return { ok: true, deleted: stale.length, freedFiles }
  }
}

export const transcriptionRetention = new TranscriptionRetentionService()
