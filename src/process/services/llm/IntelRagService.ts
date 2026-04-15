import { getDatabase } from '../database'
import type { IntelReport } from '@common/types/intel'
import type { ChatMessage } from './LlmService'
import log from 'electron-log'

export class IntelRagService {
  searchReports(query: string, limit: number = 10): IntelReport[] {
    const db = getDatabase()

    // Search by keyword in title and content
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    if (keywords.length === 0) return []

    const conditions = keywords.map(() => '(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)').join(' AND ')
    const params: string[] = []
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`)
    }

    // Theme F — filter out quarantined rows before they ever reach an
    // LLM context window. Analysts can still see them in the Quarantine
    // UI; they just don't poison the agent's reasoning loop.
    const rows = db
      .prepare(
        `SELECT * FROM intel_reports WHERE ${conditions} AND (quarantined IS NULL OR quarantined = 0) ORDER BY created_at DESC LIMIT ?`
      )
      .all(...params, limit) as Array<Record<string, unknown>>

    return rows.map(this.mapReport)
  }

  buildContextMessages(query: string, maxReports: number = 8): ChatMessage[] {
    const reports = this.searchReports(query, maxReports)

    if (reports.length === 0) {
      return [
        {
          role: 'system',
          content: `No matching intelligence reports found for the query. Answer based on your general knowledge but note that you don't have specific intel data for this query.`
        }
      ]
    }

    const context = reports.map((r, i) => {
      const geo = r.latitude && r.longitude ? `\nLocation: ${r.latitude}, ${r.longitude}` : ''
      return `--- Report ${i + 1} ---
Title: ${r.title}
Discipline: ${r.discipline.toUpperCase()}
Severity: ${r.severity.toUpperCase()}
Source: ${r.sourceName}
Verification: ${r.verificationScore}/100
Collected: ${new Date(r.createdAt).toISOString()}${geo}
${r.sourceUrl ? `URL: ${r.sourceUrl}` : ''}

${r.content.slice(0, 1500)}
`
    }).join('\n')

    return [
      {
        role: 'system',
        content: `The following ${reports.length} intelligence reports are relevant to the analyst's query. Use them to provide an informed analysis:\n\n${context}`
      }
    ]
  }

  getRecentSummary(hours: number = 24): string {
    const db = getDatabase()
    const since = Date.now() - hours * 60 * 60 * 1000

    const bySeverity = db
      .prepare('SELECT severity, COUNT(*) as count FROM intel_reports WHERE created_at >= ? GROUP BY severity')
      .all(since) as Array<{ severity: string; count: number }>

    const byDiscipline = db
      .prepare('SELECT discipline, COUNT(*) as count FROM intel_reports WHERE created_at >= ? GROUP BY discipline ORDER BY count DESC')
      .all(since) as Array<{ discipline: string; count: number }>

    const total = bySeverity.reduce((sum, r) => sum + r.count, 0)

    const sevSummary = bySeverity.map((r) => `${r.severity}: ${r.count}`).join(', ')
    const discSummary = byDiscipline.map((r) => `${r.discipline}: ${r.count}`).join(', ')

    return `Intelligence Summary (last ${hours}h): ${total} reports collected.\nBy severity: ${sevSummary}\nBy discipline: ${discSummary}`
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

export const intelRagService = new IntelRagService()
