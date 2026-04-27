// EntityTimelineService — v1.7.0 cross-corpus entity timeline.
//
// Given a canonical entity (or a raw entity value), gather every
// mention across every text corpus Heimdall maintains and stitch
// them into a single chronological timeline:
//
//   intel_reports     — join intel_entities → reports (exact match)
//   transcripts       — FTS5 MATCH on full_text + translated_text
//   humint_reports    — FTS5 MATCH on analyst_notes + findings
//   documents         — FTS5 MATCH on ocr_text
//   daily_briefings   — FTS5 MATCH on body_md
//   image_evidence    — FTS5 MATCH on tags_json + camera fields
//
// The result is a flat list of TimelineEvents sorted by ts descending.
// FTS5 columns are already indexed (migrations 036/052/054/056), so
// we get sub-100ms lookups across hundreds of thousands of rows.

import log from 'electron-log'
import { getDatabase, isDatabaseReady } from '../database'

export type TimelineEventKind = 'intel' | 'transcript' | 'humint' | 'document' | 'briefing' | 'image'

export interface TimelineEvent {
  kind: TimelineEventKind
  ts: number
  id: string                    // primary key on the source table
  title: string
  snippet: string               // FTS5 snippet() with <mark> highlighting (intel uses summary)
  meta: {
    discipline?: string
    severity?: string
    sourceName?: string
    classification?: string
    sessionId?: string | null
    duration_ms?: number | null
    language?: string | null
  }
}

export interface EntityTimelineSummary {
  canonical_value: string
  entity_type: string | null
  alias_count: number
  mention_count: number
  first_seen: number | null
  last_seen: number | null
  by_kind: Record<TimelineEventKind, number>
}

export interface EntityTimeline {
  summary: EntityTimelineSummary
  events: TimelineEvent[]
}

const DEFAULT_LIMIT_PER_CORPUS = 50

export class EntityTimelineService {
  /** Resolve the canonical entity row + all aliases for a given id. */
  resolve(canonicalId: string): { canonical_value: string; entity_type: string; aliases: string[] } | null {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, entity_type, canonical_value FROM canonical_entities WHERE id = ?
    `).get(canonicalId) as { id: string; entity_type: string; canonical_value: string } | undefined
    if (!row) return null
    // Pull every distinct entity_value seen pointing at this canonical.
    const aliasRows = db.prepare(`
      SELECT DISTINCT entity_value FROM intel_entities WHERE canonical_id = ?
    `).all(canonicalId) as Array<{ entity_value: string }>
    const aliases = aliasRows.map((a) => a.entity_value)
    if (!aliases.includes(row.canonical_value)) aliases.unshift(row.canonical_value)
    return { canonical_value: row.canonical_value, entity_type: row.entity_type, aliases }
  }

  /** Build the full timeline for a canonical entity. */
  getTimeline(canonicalId: string, limitPerCorpus = DEFAULT_LIMIT_PER_CORPUS): EntityTimeline | null {
    if (!isDatabaseReady()) return null
    const resolved = this.resolve(canonicalId)
    if (!resolved) return null

    // FTS5 query: any-of-aliases via OR. Each alias is wrapped in
    // double quotes so spaces/punctuation don't break the parser.
    const ftsQuery = resolved.aliases
      .filter((a) => a && a.length >= 2)
      .map((a) => `"${a.replace(/"/g, '')}"`)
      .join(' OR ')

    const events: TimelineEvent[] = []
    if (ftsQuery) {
      try { events.push(...this.intelEvents(canonicalId, limitPerCorpus)) } catch (err) { log.debug(`entity-timeline: intel failed: ${err}`) }
      try { events.push(...this.transcriptEvents(ftsQuery, limitPerCorpus)) } catch (err) { log.debug(`entity-timeline: transcript failed: ${err}`) }
      try { events.push(...this.humintEvents(ftsQuery, limitPerCorpus)) } catch (err) { log.debug(`entity-timeline: humint failed: ${err}`) }
      try { events.push(...this.documentEvents(ftsQuery, limitPerCorpus)) } catch (err) { log.debug(`entity-timeline: document failed: ${err}`) }
      try { events.push(...this.briefingEvents(ftsQuery, limitPerCorpus)) } catch (err) { log.debug(`entity-timeline: briefing failed: ${err}`) }
      try { events.push(...this.imageEvents(ftsQuery, limitPerCorpus)) } catch (err) { log.debug(`entity-timeline: image failed: ${err}`) }
    } else {
      // Intel mentions are still findable via canonical_id even when
      // the canonical_value is too short to feed FTS5 (≤ 1 char).
      try { events.push(...this.intelEvents(canonicalId, limitPerCorpus)) } catch { /* */ }
    }

    events.sort((a, b) => b.ts - a.ts)

    const byKind: Record<TimelineEventKind, number> = {
      intel: 0, transcript: 0, humint: 0, document: 0, briefing: 0, image: 0
    }
    for (const e of events) byKind[e.kind]++

    const ts = events.map((e) => e.ts)
    const canonicalRow = getDatabase().prepare(
      `SELECT alias_count, mention_count FROM canonical_entities WHERE id = ?`
    ).get(canonicalId) as { alias_count: number; mention_count: number } | undefined

    return {
      summary: {
        canonical_value: resolved.canonical_value,
        entity_type: resolved.entity_type,
        alias_count: canonicalRow?.alias_count ?? resolved.aliases.length,
        mention_count: canonicalRow?.mention_count ?? events.length,
        first_seen: ts.length ? Math.min(...ts) : null,
        last_seen: ts.length ? Math.max(...ts) : null,
        by_kind: byKind
      },
      events
    }
  }

  // ── per-corpus gatherers ──────────────────────────────────────────

  private intelEvents(canonicalId: string, limit: number): TimelineEvent[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT DISTINCT r.id          AS id,
             r.title                AS title,
             r.discipline           AS discipline,
             r.severity             AS severity,
             r.source_name          AS source_name,
             r.summary              AS summary,
             r.created_at           AS ts
      FROM intel_entities e
      JOIN intel_reports r ON r.id = e.report_id
      WHERE e.canonical_id = ? AND COALESCE(r.quarantined, 0) = 0
      ORDER BY r.created_at DESC
      LIMIT ?
    `).all(canonicalId, limit) as Array<{
      id: string; title: string; discipline: string; severity: string
      source_name: string | null; summary: string | null; ts: number
    }>
    return rows.map((r) => ({
      kind: 'intel' as const,
      ts: r.ts,
      id: r.id,
      title: r.title || '(untitled intel)',
      snippet: (r.summary ?? '').slice(0, 280),
      meta: { discipline: r.discipline, severity: r.severity, sourceName: r.source_name ?? undefined }
    }))
  }

  private transcriptEvents(ftsQuery: string, limit: number): TimelineEvent[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT t.id           AS id,
             t.file_name    AS file_name,
             t.duration_ms  AS duration_ms,
             t.language     AS language,
             t.ingested_at  AS ts,
             snippet(transcripts_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
      FROM transcripts_fts
      JOIN transcripts t ON t.rowid = transcripts_fts.rowid
      WHERE transcripts_fts MATCH ?
      ORDER BY bm25(transcripts_fts)
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      id: string; file_name: string | null; duration_ms: number | null
      language: string | null; ts: number; snippet: string
    }>
    return rows.map((r) => ({
      kind: 'transcript' as const,
      ts: r.ts,
      id: r.id,
      title: r.file_name || r.id,
      snippet: r.snippet || '',
      meta: { duration_ms: r.duration_ms, language: r.language }
    }))
  }

  private humintEvents(ftsQuery: string, limit: number): TimelineEvent[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT h.id          AS id,
             h.session_id  AS session_id,
             h.created_at  AS ts,
             snippet(humint_reports_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
      FROM humint_reports_fts
      JOIN humint_reports h ON h.rowid = humint_reports_fts.rowid
      WHERE humint_reports_fts MATCH ?
      ORDER BY bm25(humint_reports_fts)
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      id: string; session_id: string | null; ts: number; snippet: string
    }>
    return rows.map((r) => ({
      kind: 'humint' as const,
      ts: r.ts,
      id: r.id,
      title: r.session_id ? `HUMINT session ${r.session_id.slice(0, 8)}` : `HUMINT ${r.id.slice(0, 8)}`,
      snippet: r.snippet || '',
      meta: { sessionId: r.session_id }
    }))
  }

  private documentEvents(ftsQuery: string, limit: number): TimelineEvent[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT d.id           AS id,
             d.file_name    AS file_name,
             d.ingested_at  AS ts,
             snippet(documents_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH ?
      ORDER BY bm25(documents_fts)
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      id: string; file_name: string | null; ts: number; snippet: string
    }>
    return rows.map((r) => ({
      kind: 'document' as const,
      ts: r.ts,
      id: r.id,
      title: r.file_name || r.id,
      snippet: r.snippet || '',
      meta: {}
    }))
  }

  private briefingEvents(ftsQuery: string, limit: number): TimelineEvent[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT b.id              AS id,
             b.classification  AS classification,
             b.period_end      AS period_end,
             b.generated_at    AS ts,
             snippet(daily_briefings_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
      FROM daily_briefings_fts
      JOIN daily_briefings b ON b.rowid = daily_briefings_fts.rowid
      WHERE daily_briefings_fts MATCH ? AND b.status = 'ready'
      ORDER BY bm25(daily_briefings_fts)
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      id: string; classification: string; period_end: number
      ts: number; snippet: string
    }>
    return rows.map((r) => ({
      kind: 'briefing' as const,
      ts: r.ts,
      id: r.id,
      title: `Briefing — ${new Date(r.period_end).toLocaleDateString()}`,
      snippet: r.snippet || '',
      meta: { classification: r.classification }
    }))
  }

  private imageEvents(ftsQuery: string, limit: number): TimelineEvent[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT i.id            AS id,
             i.file_name     AS file_name,
             i.ingested_at   AS ts,
             snippet(image_evidence_fts, -1, '<mark>', '</mark>', '…', 12) AS snippet
      FROM image_evidence_fts
      JOIN image_evidence i ON i.rowid = image_evidence_fts.rowid
      WHERE image_evidence_fts MATCH ?
      ORDER BY bm25(image_evidence_fts)
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      id: string; file_name: string | null; ts: number; snippet: string
    }>
    return rows.map((r) => ({
      kind: 'image' as const,
      ts: r.ts,
      id: r.id,
      title: r.file_name || r.id,
      snippet: r.snippet || '',
      meta: {}
    }))
  }
}

export const entityTimelineService = new EntityTimelineService()
