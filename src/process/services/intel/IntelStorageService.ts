import { getDatabase } from '../database'
import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '@common/adapter/ipcBridge'
import type { IntelReport } from '@common/types/intel'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import log from 'electron-log'

export class IntelStorageService {
  private memoryDir: string

  constructor() {
    this.memoryDir = join(app.getPath('home'), '.heimdall', 'memory')
  }

  store(reports: IntelReport[]): IntelReport[] {
    if (!reports || reports.length === 0) return []

    // Filter out reports with missing/blank required fields
    reports = reports.filter((r) =>
      r && r.id && r.title?.trim() && r.content?.trim() && r.discipline && r.severity
    )

    const db = getDatabase()
    const stored: IntelReport[] = []

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO intel_reports
        (id, discipline, title, content, summary, severity, source_id, source_url,
         source_name, content_hash, latitude, longitude, verification_score,
         reviewed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const checkStmt = db.prepare(
      'SELECT id FROM intel_reports WHERE content_hash = ?'
    )

    const tx = db.transaction(() => {
      for (const report of reports) {
        // Dedup by content hash
        const existing = checkStmt.get(report.contentHash)
        if (existing) continue

        insertStmt.run(
          report.id,
          report.discipline,
          report.title,
          report.content,
          report.summary,
          report.severity,
          report.sourceId,
          report.sourceUrl,
          report.sourceName,
          report.contentHash,
          report.latitude,
          report.longitude,
          report.verificationScore,
          report.reviewed ? 1 : 0,
          report.createdAt,
          report.updatedAt
        )
        stored.push(report)
      }
    })

    tx()

    if (stored.length > 0) {
      log.info(`Stored ${stored.length} new reports (${reports.length - stored.length} duplicates skipped)`)
      this.emitNewReports(stored)
      this.exportToMarkdown(stored)
      this.syncToObsidian(stored)
      this.evaluateAlerts(stored)
      this.enrichReports(stored)
    }

    return stored
  }

  private emitNewReports(reports: IntelReport[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_EVENTS.INTEL_NEW_REPORTS, reports)
    }
  }

  private enrichReports(reports: IntelReport[]): void {
    import('../enrichment/IntelEnricher').then(({ intelEnricher }) => {
      for (const report of reports) {
        try {
          intelEnricher.enrichReport(report)
        } catch (err) {
          log.debug(`Enrichment failed for ${report.id}: ${err}`)
        }
      }
    }).catch(() => {})
  }

  private exportToMarkdown(reports: IntelReport[]): void {
    for (const report of reports) {
      try {
        const date = new Date(report.createdAt)
        const dateStr = date.toISOString().split('T')[0]
        const dir = join(this.memoryDir, report.discipline, dateStr)
        mkdirSync(dir, { recursive: true })

        const filename = `${report.id.slice(0, 8)}-${this.slugify(report.title)}.md`
        const filepath = join(dir, filename)

        const md = this.formatMarkdown(report)
        writeFileSync(filepath, md, 'utf-8')
      } catch (err) {
        log.warn(`Failed to export report ${report.id} to markdown:`, err)
      }
    }
  }

  private formatMarkdown(report: IntelReport): string {
    const date = new Date(report.createdAt).toISOString()
    const geo = report.latitude && report.longitude
      ? `\n- **Location**: ${report.latitude}, ${report.longitude}`
      : ''

    return `---
id: ${report.id}
discipline: ${report.discipline}
severity: ${report.severity}
source: ${report.sourceName}
verification_score: ${report.verificationScore}
created: ${date}
---

# ${report.title}

**Severity**: ${report.severity.toUpperCase()}
**Discipline**: ${report.discipline.toUpperCase()}
**Source**: ${report.sourceName}${report.sourceUrl ? ` ([link](${report.sourceUrl}))` : ''}
**Verification Score**: ${report.verificationScore}/100${geo}
**Collected**: ${date}

---

${report.content}

${report.summary ? `\n## Summary\n\n${report.summary}\n` : ''}
`
  }

  private evaluateAlerts(reports: IntelReport[]): void {
    import('../alerts/AlertEngine').then(({ alertEngine }) => {
      for (const report of reports) {
        alertEngine.evaluate(report).catch((err) => {
          log.warn(`Alert evaluation failed for ${report.id}: ${err}`)
        })
      }
    }).catch(() => {})
  }

  private syncToObsidian(reports: IntelReport[]): void {
    // Fire and forget — don't block storage pipeline
    import('../obsidian/ObsidianService').then(({ obsidianService }) => {
      for (const report of reports) {
        const date = new Date(report.createdAt)
        const dateStr = date.toISOString().split('T')[0]
        const filename = `${report.id.slice(0, 8)}-${this.slugify(report.title)}.md`
        const relPath = `${report.discipline}/${dateStr}/${filename}`
        const md = this.formatMarkdown(report)

        obsidianService.syncReport(relPath, md).catch(() => {
          // Silent fail — obsidian may not be configured
        })
      }
    }).catch(() => {})
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
  }
}

export const intelStorageService = new IntelStorageService()
