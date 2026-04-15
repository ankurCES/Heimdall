import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export interface HumintReport {
  id: string
  sessionId: string
  analystNotes: string
  findings: string
  confidence: string
  sourceReportIds: string[]
  toolCallsUsed: string[]
  status: string
  createdAt: number
  updatedAt: number
}

export class HumintService {
  createFromSession(sessionId: string, confidence: string = 'medium'): HumintReport | null {
    const db = getDatabase()
    const now = timestamp()

    // Get all messages from this session
    const messages = db.prepare(
      'SELECT role, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as Array<{ role: string; content: string; created_at: number }>

    if (messages.length === 0) return null

    // Extract analyst notes (human messages)
    const analystNotes = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n---\n\n')

    // Extract findings (assistant messages)
    const findings = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n\n---\n\n')

    // Extract tool calls from assistant messages
    const toolCalls: string[] = []
    for (const msg of messages) {
      const toolMatches = msg.content.match(/\*\*\[Tool: (\w+)\]\*\*/g) || []
      for (const match of toolMatches) {
        const name = match.replace(/\*\*\[Tool: |\]\*\*/g, '')
        if (!toolCalls.includes(name)) toolCalls.push(name)
      }
    }

    // Find source intel IDs mentioned in messages
    const sourceIds: string[] = []
    const allText = messages.map((m) => m.content).join(' ')
    const keywords = allText.toLowerCase().match(/\b[a-z]{5,}\b/g)?.filter((w, i, a) => a.indexOf(w) === i).slice(0, 5) || []
    if (keywords.length > 0) {
      const clauses = keywords.map(() => 'LOWER(title) LIKE ?').join(' OR ')
      const vals = keywords.map((k) => `%${k}%`)
      const matches = db.prepare(`SELECT id FROM intel_reports WHERE ${clauses} LIMIT 20`).all(...vals) as Array<{ id: string }>
      sourceIds.push(...matches.map((m) => m.id))
    }

    // Generate title from first user message
    const firstUserMsg = messages.find((m) => m.role === 'user')?.content || 'HUMINT Report'
    const title = `HUMINT: ${firstUserMsg.slice(0, 80)}`

    // UPSERT semantics — one HUMINT per chat session. If a report already exists
    // for this sessionId, reuse its id and update in place. This keeps the graph
    // node identity stable across repeated "Record HUMINT" clicks.
    const existing = db.prepare('SELECT id, created_at FROM humint_reports WHERE session_id = ?').get(sessionId) as { id: string; created_at: number } | undefined
    const id = existing?.id || generateId()
    const createdAt = existing?.created_at || now
    const isUpdate = !!existing

    // Pre-fetch data needed inside the transaction (queries that read tables
    // we'll also write to inside the tx — better-sqlite3 transactions are
    // synchronous so reads that depend on prior writes inside the tx are fine,
    // but reads we do AFTER the tx body should be done up-front).
    const prelimReports = db.prepare(
      'SELECT id, title FROM preliminary_reports WHERE session_id = ?'
    ).all(sessionId) as Array<{ id: string; title: string }>

    const otherHumints = db.prepare(
      'SELECT id, findings FROM humint_reports WHERE session_id != ? LIMIT 50'
    ).all(sessionId) as Array<{ id: string; findings: string }>

    const myWords = new Set(findings.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])

    // Atomic write — everything below either commits as a unit or rolls back.
    // Without this transaction, a partial failure mid-loop would leave the
    // humint_reports row inserted but with truncated link sets, breaking
    // the graph and the upsert-by-session invariant.
    const linkInsertStmt = db.prepare(
      'INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )

    db.transaction(() => {
      if (isUpdate) {
        db.prepare(`
          UPDATE humint_reports
          SET analyst_notes = ?, findings = ?, confidence = ?,
              source_report_ids = ?, tool_calls_used = ?, updated_at = ?
          WHERE id = ?
        `).run(analystNotes, findings, confidence, JSON.stringify(sourceIds), JSON.stringify(toolCalls), now, id)

        // Clear outgoing links so we don't accumulate stale citations on each update
        db.prepare(`DELETE FROM intel_links WHERE source_report_id = ? AND link_type IN ('humint_source','humint_preliminary','humint_cross_session')`).run(id)
      } else {
        db.prepare(`
          INSERT INTO humint_reports (id, session_id, analyst_notes, findings, confidence, source_report_ids, tool_calls_used, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
        `).run(id, sessionId, analystNotes, findings, confidence, JSON.stringify(sourceIds), JSON.stringify(toolCalls), createdAt, now)
      }

      // Create links from HUMINT to source intel
      for (const srcId of sourceIds.slice(0, 15)) {
        linkInsertStmt.run(
          generateId(), id, srcId, 'humint_source', 0.85, 'Source intel for HUMINT report', now
        )
      }

      // Link to preliminary reports from the same session
      for (const prelim of prelimReports) {
        linkInsertStmt.run(
          generateId(), id, prelim.id, 'humint_preliminary', 0.95, `HUMINT based on preliminary report: ${prelim.title.slice(0, 50)}`, now
        )
      }

      // Cross-reference with HUMINT from other sessions — find shared keywords
      for (const other of otherHumints) {
        const otherWords = other.findings.toLowerCase().match(/\b[a-z]{5,}\b/g) || []
        const overlap = otherWords.filter((w) => myWords.has(w)).length
        if (overlap >= 5) {
          linkInsertStmt.run(
            generateId(), id, other.id, 'humint_cross_session', Math.min(0.9, overlap * 0.1),
            `Cross-session HUMINT connection (${overlap} shared keywords)`, now
          )
        }
      }
    })()

    // (Kuzu dual-write removed in v0.4 — SQLite is the only graph store.)

    // Refresh tags — drop confidence / tool-specific tags before re-inserting so
    // repeated updates don't accumulate stale tool:X tags from past invocations
    if (isUpdate) {
      db.prepare(`DELETE FROM intel_tags WHERE report_id = ? AND (tag = 'humint' OR tag LIKE 'confidence:%' OR tag LIKE 'tool:%')`).run(id)
    }
    for (const tag of ['humint', `confidence:${confidence}`, ...toolCalls.map((t) => `tool:${t}`)]) {
      db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id, tag, 1.0, 'humint', now
      )
    }

    // Also upsert as intel_report for graph integration + enrichment pipeline
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update(title + findings.slice(0, 500)).digest('hex')
    const reportContent = `## Analyst Notes\n\n${analystNotes.slice(0, 2000)}\n\n## Findings\n\n${findings.slice(0, 3000)}`
    if (isUpdate) {
      db.prepare(
        'UPDATE intel_reports SET title = ?, content = ?, content_hash = ?, updated_at = ? WHERE id = ?'
      ).run(title, reportContent, hash, now, id)
    } else {
      db.prepare(
        'INSERT OR IGNORE INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'osint', title, reportContent, 'high', 'humint', 'HUMINT (Human Intelligence)', hash, 90, 1, createdAt, now)
    }

    // Trigger enrichment (entities, auto-tags, corroboration, links)
    try {
      const { intelEnricher } = require('../enrichment/IntelEnricher')
      intelEnricher.enrichReport({
        id, discipline: 'osint', title, content: reportContent,
        summary: null, severity: 'high', sourceId: 'humint',
        sourceUrl: null, sourceName: 'HUMINT', contentHash: hash,
        latitude: null, longitude: null, verificationScore: 90,
        reviewed: true, createdAt: now, updatedAt: now
      })
    } catch {}

    log.info(`HUMINT report ${isUpdate ? 'updated' : 'created'}: ${title} (${sourceIds.length} sources, ${toolCalls.length} tools)`)

    return {
      id, sessionId, analystNotes, findings, confidence,
      sourceReportIds: sourceIds, toolCallsUsed: toolCalls,
      status: 'draft', createdAt, updatedAt: now
    }
  }

  getAll(): HumintReport[] {
    const db = getDatabase()
    return db.prepare('SELECT * FROM humint_reports ORDER BY created_at DESC').all() as any[]
  }

  exportAsMarkdown(id: string): string {
    const db = getDatabase()
    const report = db.prepare('SELECT * FROM humint_reports WHERE id = ?').get(id) as Record<string, unknown>
    if (!report) return ''

    return `---
type: humint
id: ${report.id}
confidence: ${report.confidence}
session: ${report.session_id}
source_intel: ${report.source_report_ids}
tools_used: ${report.tool_calls_used}
status: ${report.status}
created: ${new Date(report.created_at as number).toISOString()}
---

# HUMINT Report

## Analyst Notes

${report.analyst_notes}

## Findings

${report.findings}
`
  }
}

export const humintService = new HumintService()
