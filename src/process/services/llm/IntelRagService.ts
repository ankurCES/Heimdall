import { getDatabase } from '../database'
import type { IntelReport } from '@common/types/intel'
import type { ChatMessage } from './LlmService'
import log from 'electron-log'

/**
 * Hit returned by `searchReports` — the IntelReport plus its BM25 score.
 * Lower BM25 = better match (FTS5 convention). When the FTS path isn't
 * usable (table missing, query parse fail) score is 0 and the LIKE
 * fallback ranks by created_at DESC.
 */
export interface RankedReport extends IntelReport {
  score: number
  matchedVia: 'fts5' | 'like'
}

export class IntelRagService {
  /** Cached existence check for the FTS5 virtual table. Avoids a PRAGMA
   *  call per searchReports invocation (called many times per agentic run). */
  private fts5Available: boolean | null = null

  private hasFts5(): boolean {
    if (this.fts5Available !== null) return this.fts5Available
    try {
      const db = getDatabase()
      const row = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intel_reports_fts'"
      ).get()
      this.fts5Available = !!row
    } catch {
      this.fts5Available = false
    }
    return this.fts5Available
  }

  /**
   * Full-text search across intel reports.
   *
   * Two-tier strategy:
   *   1. Primary — SQLite FTS5 + BM25 ranking. Supports MATCH operators
   *      (AND/OR/NOT, NEAR, prefix `*`, phrase `"…"`). Caller can pass
   *      either a raw natural-language string (we'll FTS-escape it) or a
   *      pre-built FTS5 query (use `rawFts: true` to skip escaping).
   *   2. Fallback — original LIKE-AND chain. Triggered when FTS5 isn't
   *      compiled in, the FTS query fails to parse, or returns empty.
   *
   * Quarantined reports are always filtered out — they should never reach
   * an LLM context window.
   */
  searchReports(query: string, limit: number = 10, opts: { rawFts?: boolean } = {}): IntelReport[] {
    return this.searchReportsRanked(query, limit, opts).map(({ score, matchedVia, ...rest }) => rest)
  }

  /** Same as `searchReports` but exposes the BM25 score + match method.
   *  Used by the agentic orchestrator to weight internal vs. external hits. */
  searchReportsRanked(query: string, limit: number = 10, opts: { rawFts?: boolean } = {}): RankedReport[] {
    const trimmed = (query || '').trim()
    if (!trimmed) return []

    // ── Primary: FTS5 ──
    if (this.hasFts5()) {
      const ftsResults = this.ftsSearch(trimmed, limit, opts.rawFts)
      if (ftsResults.length > 0) return ftsResults
    }

    // ── Fallback: LIKE-AND chain (legacy path) ──
    const likeResults = this.likeSearch(trimmed, limit)
    return likeResults
  }

  private ftsSearch(query: string, limit: number, rawFts?: boolean): RankedReport[] {
    const db = getDatabase()
    // Escape the query for FTS5. If `rawFts` is true the caller already
    // produced a valid FTS5 expression (e.g. `china OR iran nuclear*`) so
    // we pass it through verbatim. Otherwise we tokenize + OR-join the
    // safe terms; this is intentionally permissive (OR not AND) because
    // the LIKE-AND path was way too strict.
    const ftsQuery = rawFts ? query : this.toSafeFtsQuery(query)
    if (!ftsQuery) return []

    try {
      // bm25() returns a NEGATIVE score where lower (more negative) = better.
      // Sorting ASC gives best-first.
      const rows = db.prepare(`
        SELECT r.*, bm25(intel_reports_fts) AS bm25_score
        FROM intel_reports r
        JOIN intel_reports_fts fts ON fts.rowid = r.rowid
        WHERE intel_reports_fts MATCH ?
          AND (r.quarantined IS NULL OR r.quarantined = 0)
        ORDER BY bm25_score ASC
        LIMIT ?
      `).all(ftsQuery, limit) as Array<Record<string, unknown>>

      return rows.map((row) => ({
        ...this.mapReport(row),
        score: (row.bm25_score as number) ?? 0,
        matchedVia: 'fts5' as const
      }))
    } catch (err) {
      // FTS5 query parse error (bad characters, syntax) — log + fall back.
      log.debug(`FTS5 query failed for "${ftsQuery}": ${(err as Error).message}; falling back to LIKE`)
      return []
    }
  }

  /**
   * Convert a freeform string into a safe FTS5 expression.
   *
   *   - Splits on whitespace + punctuation
   *   - Drops tokens shorter than 2 chars
   *   - Strips FTS5-significant chars from each token (`'"`-+*^()`)
   *   - Adds the prefix marker `*` to each ≥4-char token (catches plurals,
   *     verb forms — "weapon" → "weapon*" matches "weapons", "weaponize")
   *   - Joins with OR so the search is recall-friendly. BM25 ranking
   *     handles precision: documents matching MORE tokens score higher.
   */
  private toSafeFtsQuery(query: string): string {
    // Preserve quoted phrases exactly — wrap them in FTS5 quotes intact.
    const phrases: string[] = []
    const withoutPhrases = query.replace(/"([^"]{2,80})"/g, (_, p) => {
      const cleaned = p.replace(/[^\w\s.-]/g, ' ').trim()
      if (cleaned) phrases.push(`"${cleaned}"`)
      return ' '
    })

    // Tokenise, strip FTS5-significant chars, drop short tokens.
    const tokens = withoutPhrases
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .map((t) => t.replace(/['"`+\-*^()]/g, ''))
      .filter((t) => t.length >= 2)

    if (tokens.length === 0 && phrases.length === 0) return ''

    // Add prefix marker `*` to ≥4-char tokens for stem-like matching. Skip
    // entity-shaped tokens (e.g. cve-2024-1234 already escaped to digits).
    const ftsTokens = tokens.map((t) => (t.length >= 4 && /^[a-z]/.test(t) ? `${t}*` : t))
    return [...phrases, ...ftsTokens].join(' OR ')
  }

  private likeSearch(query: string, limit: number): RankedReport[] {
    const db = getDatabase()
    // Original LIKE-AND chain — kept identical for backwards compat when FTS
    // is unavailable. Token length floor stays at >2 to match historic behaviour.
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    if (keywords.length === 0) return []

    const conditions = keywords.map(() => '(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)').join(' AND ')
    const params: string[] = []
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`)
    }

    const rows = db.prepare(
      `SELECT * FROM intel_reports WHERE ${conditions} AND (quarantined IS NULL OR quarantined = 0) ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit) as Array<Record<string, unknown>>

    return rows.map((row) => ({
      ...this.mapReport(row),
      score: 0,
      matchedVia: 'like' as const
    }))
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
