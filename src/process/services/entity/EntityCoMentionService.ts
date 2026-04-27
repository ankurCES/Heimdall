// EntityCoMentionService — v1.7.1 link-analysis surface for entities.
//
// Given a canonical entity, walk every intel_report it's mentioned in
// and aggregate the OTHER canonical entities that share at least one
// report. Output ranks them by co-mention count + co-occurrence
// breadth (number of distinct reports they share), giving the analyst
// the answer to "who appears alongside this person/org/IP?".
//
// Why intel_entities only (for now):
//   - Every mention there has been explicitly canonicalised, so
//     co-mentions are deterministic and never wrong.
//   - Text-based co-occurrence in transcripts/briefings would need a
//     much fuzzier match + an OR-blast of every alias of every other
//     entity; cost-prohibitive at the analyst's keystroke. Saved for
//     a later batch.

import log from 'electron-log'
import { getDatabase } from '../database'

export interface CoMention {
  canonical_id: string
  canonical_value: string
  entity_type: string
  /** Number of reports where both entities co-occur. */
  shared_reports: number
  /** Number of times the OTHER entity is mentioned across those
   *  reports (i.e. counts duplicates within a report). Useful when
   *  one report mentions an entity many times. */
  co_mention_count: number
  /** Most recent timestamp of a shared report. Helps the analyst
   *  prioritise current relationships over stale ones. */
  last_co_mentioned_at: number
}

export interface CoMentionGraph {
  /** The entity whose co-mentions we computed. */
  source_canonical_id: string
  source_canonical_value: string
  source_entity_type: string
  /** How many distinct reports the source entity appears in. */
  source_report_count: number
  /** Top-N co-mentioned entities, sorted by shared_reports desc. */
  edges: CoMention[]
}

const DEFAULT_LIMIT = 25
const MIN_SHARED_REPORTS = 1   // require at least one shared report to surface

export class EntityCoMentionService {
  /** Compute the co-mention graph anchored on `canonicalId`. */
  getCoMentions(canonicalId: string, limit = DEFAULT_LIMIT): CoMentionGraph | null {
    const db = getDatabase()
    const source = db.prepare(`
      SELECT id, entity_type, canonical_value FROM canonical_entities WHERE id = ?
    `).get(canonicalId) as { id: string; entity_type: string; canonical_value: string } | undefined
    if (!source) return null

    // Reports the source entity appears in (deduped).
    const reportRows = db.prepare(`
      SELECT DISTINCT report_id FROM intel_entities
      WHERE canonical_id = ? AND report_id IS NOT NULL
    `).all(canonicalId) as Array<{ report_id: string }>
    const reportIds = reportRows.map((r) => r.report_id)
    if (reportIds.length === 0) {
      return {
        source_canonical_id: source.id,
        source_canonical_value: source.canonical_value,
        source_entity_type: source.entity_type,
        source_report_count: 0,
        edges: []
      }
    }

    // For every other entity row in those reports, group by canonical_id
    // and count distinct reports (shared_reports) + total mentions
    // (co_mention_count) + most recent timestamp.
    //
    // We exclude the source canonical_id and also exclude rows with a
    // NULL canonical_id (unresolved) since those can't link to a
    // distinct entity in the graph.
    const placeholders = reportIds.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT
        e.canonical_id        AS canonical_id,
        c.canonical_value     AS canonical_value,
        c.entity_type         AS entity_type,
        COUNT(DISTINCT e.report_id) AS shared_reports,
        COUNT(*)              AS co_mention_count,
        MAX(r.created_at)     AS last_co_mentioned_at
      FROM intel_entities e
      JOIN canonical_entities c ON c.id = e.canonical_id
      LEFT JOIN intel_reports r ON r.id = e.report_id
      WHERE e.report_id IN (${placeholders})
        AND e.canonical_id IS NOT NULL
        AND e.canonical_id != ?
      GROUP BY e.canonical_id, c.canonical_value, c.entity_type
      HAVING shared_reports >= ?
      ORDER BY shared_reports DESC, co_mention_count DESC
      LIMIT ?
    `).all(...reportIds, canonicalId, MIN_SHARED_REPORTS, limit) as CoMention[]

    log.debug(`co-mentions: ${canonicalId} → ${rows.length} edge(s) across ${reportIds.length} report(s)`)

    return {
      source_canonical_id: source.id,
      source_canonical_value: source.canonical_value,
      source_entity_type: source.entity_type,
      source_report_count: reportIds.length,
      edges: rows
    }
  }
}

export const entityCoMentionService = new EntityCoMentionService()
