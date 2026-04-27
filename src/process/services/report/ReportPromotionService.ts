// Report promotion — moves chat-embedded analyst products into the
// first-class report_products table.
//
// Two modes:
//
//   1. promoteOne(messageId)
//      Manual promotion triggered by the analyst clicking "Promote to
//      Library" on a chat message. Always promotes regardless of heuristic.
//
//   2. runStartupMigration({ onProgress })
//      One-shot background migration that runs on first boot of v1.1.
//      Scans every assistant message in chat_messages, applies heuristics
//      to identify which are reports (vs. short answers / clarifications),
//      and promotes the report-shaped ones. Idempotent — tracks state in
//      report_promotion_state so it never re-runs.
//
// Heuristics for "this looks like a report":
//   - role = 'assistant'
//   - length > 1500 chars
//   - contains at least 2 of: "KEY JUDGMENTS", "EXECUTIVE SUMMARY",
//     "DISCUSSION", "RECOMMENDED ACTIONS", "INFORMATION GAPS",
//     "OUTLOOK", "ANALYTIC CAVEATS", "INDICATORS"
//
// For each promoted message we call ReportFormatter detection +
// ICD203Validator scoring so the new row carries the same metadata as
// reports generated post-v1.1.

import { getDatabase } from '../database'
import { reportLibraryService, type ReportFormat } from './ReportLibraryService'
import { reportExtractor } from '../enrichment/ReportExtractor'
import { validateReport } from './ICD203Validator'
import log from 'electron-log'

const REPORT_HEADING_PATTERNS = [
  /KEY JUDGMENTS?/i,
  /EXECUTIVE SUMMARY/i,
  /DISCUSSION\b/i,
  /RECOMMENDED (?:COLLECTION )?ACTIONS/i,
  /INFORMATION GAPS/i,
  /ANALYTIC CAVEATS/i,
  /\bOUTLOOK\b/i,
  /INDICATORS? (?:&|AND) WARNINGS/i,
  /SCOPE NOTE/i,
  /ANNEX [A-D]/
]

const MIN_REPORT_LENGTH = 1500

export interface PromotionProgress {
  status: 'pending' | 'running' | 'complete' | 'error'
  total: number
  processed: number
  promoted: number
  skipped: number
  currentTitle?: string
  lastError?: string
  startedAt?: number
  completedAt?: number
}

interface ChatMessageRow {
  id: string
  session_id: string
  role: string
  content: string
  created_at: number
}

interface PromotionStateRow {
  status: string
  total: number
  processed: number
  promoted: number
  skipped: number
  started_at: number | null
  completed_at: number | null
  last_error: string | null
}

export class ReportPromotionService {
  /** True when an assistant message looks like a generated report. */
  isReportLike(content: string): boolean {
    if (!content || content.length < MIN_REPORT_LENGTH) return false
    let hits = 0
    for (const pattern of REPORT_HEADING_PATTERNS) {
      if (pattern.test(content)) {
        hits++
        if (hits >= 2) return true
      }
    }
    return false
  }

  /** Detect which IC format a free-text report most resembles. */
  detectFormat(content: string): ReportFormat {
    const upper = content.toUpperCase()
    if (/SCOPE NOTE|NATIONAL INTELLIGENCE ESTIMATE|NIE\s*\d{4}/.test(upper)) return 'nie'
    if (/IIR\s|INTELLIGENCE INFORMATION REPORT|\(U\/\/FOUO\)\s+[1-9]\./.test(upper)) return 'iir'
    if (/CURRENT INTELLIGENCE BRIEF|PRESIDENT'S DAILY/.test(upper)) return 'pdb'
    return 'assessment'
  }

  /**
   * Promote one chat message into a report_products row. Returns the new
   * report id, or null if the message isn't promotable (e.g. role != assistant).
   */
  promoteOne(messageId: string, opts: { force?: boolean } = {}): string | null {
    const db = getDatabase()
    const msg = db.prepare(
      `SELECT id, session_id, role, content, created_at FROM chat_messages WHERE id = ?`
    ).get(messageId) as ChatMessageRow | undefined
    if (!msg) return null
    if (msg.role !== 'assistant') return null
    if (!opts.force && !this.isReportLike(msg.content)) return null

    // Skip if already promoted (we look up by source markers in tags).
    const existing = db.prepare(
      `SELECT id FROM report_products WHERE session_id = ? AND tags_json LIKE ?`
    ).get(msg.session_id, `%"src:chat:${msg.id}"%`) as { id: string } | undefined
    if (existing) return existing.id

    // Extract title + structure
    const extracted = reportExtractor.extract(msg.content)
    const title = extracted.title || `Untitled report (${new Date(msg.created_at).toISOString().slice(0, 10)})`
    const format = this.detectFormat(msg.content)

    // Compute tradecraft score
    let score: number | null = null
    let deficiencies: string[] = []
    try {
      const v = validateReport(msg.content)
      score = v.total
      deficiencies = v.deficiencies
    } catch (err) {
      log.debug(`promoteOne: tradecraft scoring failed for ${msg.id}: ${err}`)
    }

    const report = reportLibraryService.create({
      sessionId: msg.session_id,
      title: title.slice(0, 250),
      format,
      classification: 'UNCLASSIFIED//FOUO',
      bodyMarkdown: msg.content,
      tradecraftScore: score,
      tradecraftDeficiencies: deficiencies,
      generatedAt: msg.created_at,
      status: 'draft',
      tags: [`src:chat:${msg.id}`]
    })

    return report.id
  }

  /** Read the persisted promotion-migration state. */
  getState(): PromotionProgress {
    const row = getDatabase().prepare(
      `SELECT status, total, processed, promoted, skipped, started_at, completed_at, last_error
       FROM report_promotion_state WHERE id = 1`
    ).get() as PromotionStateRow | undefined
    if (!row) {
      return { status: 'pending', total: 0, processed: 0, promoted: 0, skipped: 0 }
    }
    return {
      status: row.status as PromotionProgress['status'],
      total: row.total,
      processed: row.processed,
      promoted: row.promoted,
      skipped: row.skipped,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      lastError: row.last_error ?? undefined
    }
  }

  /**
   * One-shot background migration. Idempotent — exits immediately if
   * status is already 'complete'. Caller can pass an onProgress callback
   * to receive ticks for the splash UI.
   */
  async runStartupMigration(onProgress?: (p: PromotionProgress) => void): Promise<PromotionProgress> {
    const db = getDatabase()
    const state = this.getState()
    if (state.status === 'complete') {
      return state
    }

    // Find candidate messages — assistant role + min length. We pre-filter
    // by length here to keep the count meaningful for the progress bar
    // (skipped-by-heuristic still counts toward `processed`).
    const rows = db.prepare(
      `SELECT id, session_id, role, content, created_at
       FROM chat_messages
       WHERE role = 'assistant' AND length(content) >= ?
       ORDER BY created_at ASC`
    ).all(MIN_REPORT_LENGTH) as ChatMessageRow[]

    const total = rows.length

    if (total === 0) {
      // Nothing to migrate — short-circuit to complete.
      const finalState: PromotionProgress = {
        status: 'complete', total: 0, processed: 0, promoted: 0, skipped: 0,
        startedAt: Date.now(), completedAt: Date.now()
      }
      this.persistState(finalState)
      onProgress?.(finalState)
      return finalState
    }

    const startedAt = Date.now()
    this.persistState({
      status: 'running', total, processed: 0, promoted: 0, skipped: 0, startedAt
    })

    let promoted = 0
    let skipped = 0
    const PROGRESS_THROTTLE_MS = 250
    let lastTick = 0

    for (let i = 0; i < rows.length; i++) {
      const msg = rows[i]
      const heading = this.firstHeading(msg.content) || `Untitled (${msg.id.slice(0, 8)})`
      try {
        const newId = this.promoteOne(msg.id, { force: false })
        if (newId) promoted++
        else skipped++
      } catch (err) {
        log.warn(`promotion of ${msg.id} failed: ${err}`)
        skipped++
      }

      const now = Date.now()
      const isLast = i === rows.length - 1
      if (now - lastTick >= PROGRESS_THROTTLE_MS || isLast) {
        lastTick = now
        const progress: PromotionProgress = {
          status: 'running',
          total,
          processed: i + 1,
          promoted,
          skipped,
          currentTitle: heading,
          startedAt
        }
        this.persistState(progress)
        onProgress?.(progress)
      }
    }

    const completedAt = Date.now()
    const finalState: PromotionProgress = {
      status: 'complete', total, processed: total, promoted, skipped,
      startedAt, completedAt
    }
    this.persistState(finalState)
    onProgress?.(finalState)
    log.info(`Report promotion migration complete: ${promoted} promoted, ${skipped} skipped (of ${total} candidates) in ${completedAt - startedAt}ms`)
    return finalState
  }

  /** Best-effort title hint from a message — first heading or first line. */
  private firstHeading(content: string): string | null {
    const heading = content.match(/^#{1,3}\s+(.+)$/m)
    if (heading) return heading[1].trim().slice(0, 80)
    const firstLine = content.split('\n').find((l) => l.trim().length > 10)
    return firstLine ? firstLine.trim().slice(0, 80) : null
  }

  private persistState(p: PromotionProgress): void {
    const db = getDatabase()
    db.prepare(`
      UPDATE report_promotion_state
      SET status = ?, total = ?, processed = ?, promoted = ?, skipped = ?,
          started_at = ?, completed_at = ?, last_error = ?
      WHERE id = 1
    `).run(
      p.status, p.total, p.processed, p.promoted, p.skipped,
      p.startedAt ?? null, p.completedAt ?? null, p.lastError ?? null
    )
  }

  /** Reset the migration state — for testing only. */
  resetForTesting(): void {
    getDatabase().prepare(
      `UPDATE report_promotion_state SET status='pending', total=0, processed=0,
       promoted=0, skipped=0, started_at=NULL, completed_at=NULL, last_error=NULL
       WHERE id = 1`
    ).run()
  }
}

export const reportPromotionService = new ReportPromotionService()
