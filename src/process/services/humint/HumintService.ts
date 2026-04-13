import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { kuzuService } from '../graphdb/KuzuService'
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

    const id = generateId()

    // Insert HUMINT report
    db.prepare(`
      INSERT INTO humint_reports (id, session_id, analyst_notes, findings, confidence, source_report_ids, tool_calls_used, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(id, sessionId, analystNotes, findings, confidence, JSON.stringify(sourceIds), JSON.stringify(toolCalls), now, now)

    // Create links from HUMINT to source intel
    for (const srcId of sourceIds.slice(0, 15)) {
      db.prepare('INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        generateId(), id, srcId, 'humint_source', 0.85, 'Source intel for HUMINT report', now
      )
    }

    // Link to preliminary reports from the same session
    const prelimReports = db.prepare(
      'SELECT id, title FROM preliminary_reports WHERE session_id = ?'
    ).all(sessionId) as Array<{ id: string; title: string }>
    for (const prelim of prelimReports) {
      db.prepare('INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        generateId(), id, prelim.id, 'humint_preliminary', 0.95, `HUMINT based on preliminary report: ${prelim.title.slice(0, 50)}`, now
      )
    }

    // Cross-reference with HUMINT from other sessions — find shared entities/tags
    const otherHumints = db.prepare(
      'SELECT id, findings FROM humint_reports WHERE session_id != ? LIMIT 50'
    ).all(sessionId) as Array<{ id: string; findings: string }>
    for (const other of otherHumints) {
      // Check keyword overlap between findings
      const myWords = new Set(findings.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
      const otherWords = other.findings.toLowerCase().match(/\b[a-z]{5,}\b/g) || []
      const overlap = otherWords.filter((w) => myWords.has(w)).length
      if (overlap >= 5) {
        db.prepare('INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          generateId(), id, other.id, 'humint_cross_session', Math.min(0.9, overlap * 0.1),
          `Cross-session HUMINT connection (${overlap} shared keywords)`, now
        )
      }
    }

    // Kuzu dual-write (fire-and-forget)
    if (kuzuService.isReady()) {
      (async () => {
        try {
          await kuzuService.upsertHumintReport({ id, title, confidence, created_at: now })
          for (const srcId of sourceIds.slice(0, 15)) {
            await kuzuService.createLink(id, srcId, 'humint_source', 0.85)
          }
          for (const prelim of prelimReports) {
            await kuzuService.createLink(id, prelim.id, 'humint_preliminary', 0.95)
          }
        } catch {}
      })()
    }

    // Tag the HUMINT report
    for (const tag of ['humint', `confidence:${confidence}`, ...toolCalls.map((t) => `tool:${t}`)]) {
      db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id, tag, 1.0, 'humint', now
      )
    }

    // Also create as intel_report for graph integration + enrichment pipeline
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update(title + findings.slice(0, 500)).digest('hex')
    const reportContent = `## Analyst Notes\n\n${analystNotes.slice(0, 2000)}\n\n## Findings\n\n${findings.slice(0, 3000)}`
    db.prepare(
      'INSERT OR IGNORE INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'osint', title, reportContent, 'high', 'humint', 'HUMINT (Human Intelligence)', hash, 90, 1, now, now)

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

    log.info(`HUMINT report created: ${title} (${sourceIds.length} sources, ${toolCalls.length} tools)`)

    return {
      id, sessionId, analystNotes, findings, confidence,
      sourceReportIds: sourceIds, toolCallsUsed: toolCalls,
      status: 'draft', createdAt: now, updatedAt: now
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
