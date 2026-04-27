// UniversalSearchService — v1.5.1 cross-corpus full-text search.
//
// Hits both intel_reports (FTS5 from migration 036) and transcripts
// (FTS5 from migration 052) and merges results into a single ranked
// list. Each hit carries a kind ('intel' | 'transcript'), a snippet
// with FTS5's MATCH-aware highlighting, and a deep-link payload the
// renderer uses to navigate the analyst to the right view.
//
// Query syntax: SQLite FTS5 grammar — supports phrase queries
// ("cyber attack"), AND/OR/NOT, prefix matching (terror*), column
// filters (title:bombing). The renderer escapes hostile characters
// before passing through; no SQL injection because everything goes
// through prepared statements.

import log from 'electron-log'
import { getDatabase } from '../database'

export type SearchKind = 'intel' | 'transcript'

export interface SearchHit {
  kind: SearchKind
  id: string
  title: string                  // intel.title / transcript.file_name
  snippet: string                // FTS5 snippet() of the matching span
  score: number                  // bm25 (lower = better; we negate before sorting)
  matchedColumn: string          // best-effort column-of-match label
  // Kind-specific extras the renderer can use for the click target
  meta: {
    discipline?: string          // intel only
    severity?: string            // intel only
    sourceName?: string          // intel only
    duration_ms?: number | null  // transcript only
    language?: string | null     // transcript only
    engine?: string | null       // transcript only
    reportId?: string | null     // transcript → intel pairing if any
  }
  createdAt: number
}

export interface SearchOptions {
  query: string
  limit?: number                 // total cap across both corpora
  kinds?: SearchKind[]           // narrow to one corpus
}

const DEFAULT_LIMIT = 50
const PER_CORPUS_LIMIT = 60      // grab a few extra so the merge gets the best

export class UniversalSearchService {
  search(opts: SearchOptions): SearchHit[] {
    const query = sanitiseQuery(opts.query || '')
    if (!query) return []
    const wantIntel = !opts.kinds || opts.kinds.includes('intel')
    const wantTranscript = !opts.kinds || opts.kinds.includes('transcript')

    const out: SearchHit[] = []
    if (wantIntel) {
      try { out.push(...this.searchIntel(query, PER_CORPUS_LIMIT)) }
      catch (err) { log.debug(`search: intel FTS failed: ${(err as Error).message}`) }
    }
    if (wantTranscript) {
      try { out.push(...this.searchTranscripts(query, PER_CORPUS_LIMIT)) }
      catch (err) { log.debug(`search: transcript FTS failed: ${(err as Error).message}`) }
    }
    // Merge: lower bm25 = stronger match. Cross-corpus ranking is
    // intentionally simple — bm25 across SQL stmts isn't directly
    // comparable, but ordering by score-then-recency works well for
    // the common analyst case ("find that recent thing about X").
    out.sort((a, b) => a.score !== b.score ? a.score - b.score : b.createdAt - a.createdAt)
    return out.slice(0, opts.limit ?? DEFAULT_LIMIT)
  }

  private searchIntel(matchQuery: string, limit: number): SearchHit[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT r.id              AS id,
             r.title           AS title,
             r.discipline      AS discipline,
             r.severity        AS severity,
             r.source_name     AS source_name,
             r.created_at      AS created_at,
             snippet(intel_reports_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
             bm25(intel_reports_fts) AS score
      FROM intel_reports_fts
      JOIN intel_reports r ON r.rowid = intel_reports_fts.rowid
      WHERE intel_reports_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(matchQuery, limit) as Array<{
      id: string; title: string; discipline: string; severity: string
      source_name: string | null; created_at: number; snippet: string; score: number
    }>
    return rows.map((r) => ({
      kind: 'intel' as const,
      id: r.id,
      title: r.title || '(untitled)',
      snippet: r.snippet || '',
      score: r.score,
      matchedColumn: 'intel',
      meta: {
        discipline: r.discipline,
        severity: r.severity,
        sourceName: r.source_name ?? undefined
      },
      createdAt: r.created_at
    }))
  }

  private searchTranscripts(matchQuery: string, limit: number): SearchHit[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT t.id              AS id,
             t.file_name       AS file_name,
             t.duration_ms     AS duration_ms,
             t.language        AS language,
             t.engine          AS engine,
             t.report_id       AS report_id,
             t.ingested_at     AS ingested_at,
             snippet(transcripts_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet,
             bm25(transcripts_fts) AS score
      FROM transcripts_fts
      JOIN transcripts t ON t.rowid = transcripts_fts.rowid
      WHERE transcripts_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(matchQuery, limit) as Array<{
      id: string; file_name: string | null; duration_ms: number | null
      language: string | null; engine: string | null; report_id: string | null
      ingested_at: number; snippet: string; score: number
    }>
    return rows.map((r) => ({
      kind: 'transcript' as const,
      id: r.id,
      title: r.file_name || r.id,
      snippet: r.snippet || '',
      score: r.score,
      matchedColumn: 'transcript',
      meta: {
        duration_ms: r.duration_ms,
        language: r.language,
        engine: r.engine,
        reportId: r.report_id
      },
      createdAt: r.ingested_at
    }))
  }
}

/** FTS5 has its own grammar; an unbalanced quote or stray operator
 *  raises a syntax error mid-keystroke. We pass-through what looks
 *  like deliberate FTS syntax, fall back to a tokenised AND-of-terms
 *  query for plain prose, and wrap each token in double quotes so
 *  punctuation in the input doesn't throw. */
function sanitiseQuery(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // If the user typed FTS-style operators, trust them.
  if (/[":*]|\bAND\b|\bOR\b|\bNOT\b/.test(trimmed)) return trimmed
  // Otherwise tokenise on whitespace + quote each term so punctuation
  // doesn't break the parser. 1-char tokens are dropped (FTS5 needs
  // ≥2-char terms by default).
  const tokens = trimmed
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_\-.@]/gu, ''))
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"`).join(' AND ')
}

export const universalSearch = new UniversalSearchService()
