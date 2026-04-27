// AutoRevisionService — detects when newly-arrived intel contradicts a
// PUBLISHED report's key judgments and creates a pending revision row.
//
// Strategy:
//   1. Extract key judgments from each published report's body once
//      (cached in memory for the duration of the cron run).
//   2. For every new intel arrived in the last 24h, check if it
//      semantically contradicts any judgment.
//   3. Cheap pre-filter: keyword overlap between judgment + intel
//   4. Confirmation step: short LLM check returns
//      contradicts/supports/unrelated
//   5. On contradiction: insert a row in report_revisions with status=
//      'pending' so it shows up in the analyst's Revision Inbox.
//
// Revisions are NEVER auto-applied — analyst must explicitly accept,
// reject, or trigger regeneration from the inbox.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import { llmService } from '../llm/LlmService'
import log from 'electron-log'

interface PublishedReport {
  id: string
  title: string
  body_markdown: string
  generated_at: number
  judgments: string[]   // extracted key judgments
}

interface IntelRow {
  id: string
  title: string
  content: string
  created_at: number
}

const SCAN_LOOKBACK_MS = 24 * 60 * 60 * 1000
const MAX_INTEL_PER_RUN = 200
const MIN_KEYWORD_OVERLAP = 0.30  // pre-filter threshold before LLM check
const LLM_CHECK_PROMPT = `You are checking if a piece of new intelligence CONTRADICTS, SUPPORTS, or is UNRELATED to a previously-published analytic key judgment.

KEY JUDGMENT:
{{judgment}}

NEW INTELLIGENCE:
{{intel}}

Respond with EXACTLY ONE WORD: CONTRADICTS, SUPPORTS, or UNRELATED.`

export class AutoRevisionService {
  private timer: NodeJS.Timeout | null = null
  private running = false

  start(intervalMs: number = 30 * 60 * 1000): void {
    if (this.timer) return
    log.info(`AutoRevision: started (interval ${intervalMs}ms)`)
    setTimeout(() => this.runOnce().catch((e) => log.warn(`auto-revision initial: ${e}`)), 60_000)
    this.timer = setInterval(() => this.runOnce().catch((e) => log.warn(`auto-revision: ${e}`)), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runOnce(): Promise<{ scanned: number; pendingCreated: number }> {
    if (this.running) return { scanned: 0, pendingCreated: 0 }
    this.running = true
    const start = Date.now()
    try {
      const db = getDatabase()

      // Pull published reports + extract key judgments
      const publishedRows = db.prepare(`
        SELECT id, title, body_markdown, generated_at
        FROM report_products
        WHERE status = 'published'
        ORDER BY generated_at DESC
        LIMIT 200
      `).all() as Array<{ id: string; title: string; body_markdown: string; generated_at: number }>

      if (publishedRows.length === 0) return { scanned: 0, pendingCreated: 0 }

      const reports: PublishedReport[] = publishedRows.map((r) => ({
        ...r,
        judgments: this.extractKeyJudgments(r.body_markdown)
      })).filter((r) => r.judgments.length > 0)

      // Pull recent intel
      const since = Date.now() - SCAN_LOOKBACK_MS
      const intel = db.prepare(`
        SELECT id, title, content, created_at FROM intel_reports
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(since, MAX_INTEL_PER_RUN) as IntelRow[]

      let pendingCreated = 0

      for (const report of reports) {
        for (const intelItem of intel) {
          // Skip if we already have a revision for this (report, intel) pair
          const existing = db.prepare(`
            SELECT id FROM report_revisions
            WHERE report_id = ? AND trigger_intel_id = ?
          `).get(report.id, intelItem.id)
          if (existing) continue

          // Find which judgment (if any) contradicts
          for (const judgment of report.judgments) {
            const overlap = this.keywordOverlap(judgment, intelItem.content)
            if (overlap < MIN_KEYWORD_OVERLAP) continue

            // LLM contradiction check
            const verdict = await this.checkContradiction(judgment, intelItem.content)
            if (verdict !== 'CONTRADICTS') continue

            // Create pending revision
            this.insertPendingRevision(report.id, judgment, intelItem)
            pendingCreated++
            // Only flag the strongest judgment per intel — don't multi-flag
            break
          }
        }
      }

      const dur = Date.now() - start
      log.info(`AutoRevision: ${reports.length} published reports × ${intel.length} intel → ${pendingCreated} new revisions in ${dur}ms`)
      return { scanned: reports.length * intel.length, pendingCreated }
    } finally {
      this.running = false
    }
  }

  /** Extract key judgments from the report body. Heuristic — looks for
   *  numbered statements under a "KEY JUDGMENTS" heading. */
  private extractKeyJudgments(body: string): string[] {
    const sectionMatch = body.match(/KEY JUDGMENTS?[\s\S]*?(?=\n#{1,4}\s+\w|\n[A-Z\s]{8,}\n|\nDISCUSSION\b|\nDETAILED ANALYSIS\b|$)/i)
    if (!sectionMatch) return []
    const section = sectionMatch[0]
    // Match numbered judgments like "1. ..." or "1) ..."
    const items = section.match(/^\s*\d+[.)]\s+(.+(?:\n(?!\s*\d+[.)])(?!\s*$).*)*)/gm) || []
    return items.map((s) => s.replace(/^\s*\d+[.)]\s+/, '').trim().slice(0, 600))
      .filter((s) => s.length > 30)
      .slice(0, 8)
  }

  private keywordOverlap(judgment: string, intelText: string): number {
    const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to',
      'for', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'as', 'this', 'that',
      'will', 'would', 'we', 'they', 'their', 'them'])
    const tokensFrom = (s: string) => new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter((t) => t.length >= 4 && !stop.has(t))
    )
    const j = tokensFrom(judgment)
    const i = tokensFrom(intelText.slice(0, 4000))
    if (j.size === 0) return 0
    let overlap = 0
    for (const tok of j) if (i.has(tok)) overlap++
    return overlap / j.size
  }

  private async checkContradiction(judgment: string, intel: string): Promise<'CONTRADICTS' | 'SUPPORTS' | 'UNRELATED'> {
    try {
      const prompt = LLM_CHECK_PROMPT
        .replace('{{judgment}}', judgment.slice(0, 800))
        .replace('{{intel}}', intel.slice(0, 1500))
      const response = await llmService.completeForTask('planner', prompt, undefined, 32)
      const verdict = response.trim().toUpperCase()
      if (verdict.includes('CONTRADICTS')) return 'CONTRADICTS'
      if (verdict.includes('SUPPORTS')) return 'SUPPORTS'
      return 'UNRELATED'
    } catch (err) {
      log.debug(`contradiction check failed: ${err}`)
      return 'UNRELATED'
    }
  }

  private insertPendingRevision(reportId: string, judgment: string, intel: IntelRow): void {
    const db = getDatabase()
    try {
      db.prepare(`
        INSERT INTO report_revisions
          (id, report_id, trigger_type, trigger_evidence, trigger_intel_id,
           affected_judgment, status, created_at)
        VALUES (?, ?, 'contradiction', ?, ?, ?, 'pending', ?)
      `).run(
        generateId(), reportId,
        intel.content.slice(0, 500),
        intel.id,
        judgment.slice(0, 500),
        Date.now()
      )
    } catch (err) {
      log.debug(`insert revision failed: ${err}`)
    }
  }

  // ── Inbox queries ────────────────────────────────────────────────────

  pendingRevisions(): Array<{
    id: string
    reportId: string
    reportTitle: string
    triggerType: string
    affectedJudgment: string | null
    triggerEvidence: string | null
    triggerIntelId: string | null
    triggerIntelTitle: string | null
    createdAt: number
    status: string
  }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT rr.id, rr.report_id AS reportId,
             COALESCE(rp.title, '[deleted report]') AS reportTitle,
             rr.trigger_type AS triggerType,
             rr.affected_judgment AS affectedJudgment,
             rr.trigger_evidence AS triggerEvidence,
             rr.trigger_intel_id AS triggerIntelId,
             COALESCE(ir.title, NULL) AS triggerIntelTitle,
             rr.created_at AS createdAt,
             rr.status
      FROM report_revisions rr
      LEFT JOIN report_products rp ON rp.id = rr.report_id
      LEFT JOIN intel_reports ir ON ir.id = rr.trigger_intel_id
      WHERE rr.status = 'pending'
      ORDER BY rr.created_at DESC
    `).all() as ReturnType<typeof this.pendingRevisions>
  }

  acknowledge(revisionId: string, notes?: string): boolean {
    const r = getDatabase().prepare(`
      UPDATE report_revisions SET status = 'acknowledged', reviewed_at = ?, reviewer_notes = ?
      WHERE id = ? AND status = 'pending'
    `).run(Date.now(), notes ?? null, revisionId)
    return r.changes > 0
  }

  dismiss(revisionId: string, notes?: string): boolean {
    const r = getDatabase().prepare(`
      UPDATE report_revisions SET status = 'dismissed', reviewed_at = ?, reviewer_notes = ?
      WHERE id = ? AND status = 'pending'
    `).run(Date.now(), notes ?? null, revisionId)
    return r.changes > 0
  }

  pendingCount(): number {
    return (getDatabase().prepare(`SELECT COUNT(*) AS n FROM report_revisions WHERE status = 'pending'`)
      .get() as { n: number }).n
  }
}

export const autoRevisionService = new AutoRevisionService()
