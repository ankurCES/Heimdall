import { getDatabase } from '../database'

/**
 * Theme 3.3 — Pattern-of-life heatmap.
 *
 * For a given canonical entity id, return the mention density split by
 * day-of-week × hour-of-day over the last N days (default 90). Returns
 * a 7×24 grid, cells are raw counts. Analysts layer their own colour
 * scale on the UI side.
 *
 * Day 0 = Sunday, 6 = Saturday (JS convention, matches strftime %w).
 * Hour 0 = local-time 00:xx in the user's tz.
 *
 * No new tables — pure analytics query over intel_entities + intel_reports.
 */

export interface PatternOfLifeGrid {
  entity_id: string
  canonical_value: string | null
  entity_type: string | null
  window_days: number
  total_mentions: number
  /** grid[day][hour] = count */
  grid: number[][]
  /** per-day sum totals */
  day_totals: number[]
  /** per-hour sum totals (0-23) */
  hour_totals: number[]
  /** max single-cell count for UI colour scale */
  peak_cell: number
}

export class PatternOfLifeService {
  /** Build an empty 7×24 grid. */
  private emptyGrid(): number[][] {
    return Array.from({ length: 7 }, () => new Array(24).fill(0))
  }

  /**
   * Compute the grid for a canonical entity. If the id refers to an
   * unresolved raw entity_value, the caller should resolve first. Times
   * use the system local zone via SQLite's strftime('%w' / '%H', ts,
   * 'localtime').
   */
  forEntity(canonicalId: string, windowDays = 90): PatternOfLifeGrid {
    const db = getDatabase()
    const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000

    // Canonical metadata for the UI label.
    const meta = db.prepare(
      'SELECT canonical_value, entity_type FROM canonical_entities WHERE id = ?'
    ).get(canonicalId) as { canonical_value: string | null; entity_type: string | null } | undefined

    // SQLite strftime wants seconds, not ms. created_at is ms.
    const rows = db.prepare(`
      SELECT
        CAST(strftime('%w', r.created_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
        CAST(strftime('%H', r.created_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        COUNT(*) AS n
      FROM intel_entities e
      JOIN intel_reports r ON r.id = e.report_id
      WHERE e.canonical_id = ? AND r.created_at >= ?
      GROUP BY dow, hour
    `).all(canonicalId, sinceMs) as Array<{ dow: number; hour: number; n: number }>

    const grid = this.emptyGrid()
    const dayTotals = new Array(7).fill(0)
    const hourTotals = new Array(24).fill(0)
    let total = 0, peak = 0

    for (const row of rows) {
      if (row.dow < 0 || row.dow > 6 || row.hour < 0 || row.hour > 23) continue
      grid[row.dow][row.hour] = row.n
      dayTotals[row.dow] += row.n
      hourTotals[row.hour] += row.n
      total += row.n
      if (row.n > peak) peak = row.n
    }

    return {
      entity_id: canonicalId,
      canonical_value: meta?.canonical_value ?? null,
      entity_type: meta?.entity_type ?? null,
      window_days: windowDays,
      total_mentions: total,
      grid,
      day_totals: dayTotals,
      hour_totals: hourTotals,
      peak_cell: peak
    }
  }

  /**
   * Aggregate pattern-of-life across a whole discipline (e.g. "when does
   * CYBINT chatter spike?"). Same shape as forEntity but no canonical
   * metadata.
   */
  forDiscipline(discipline: string, windowDays = 90): PatternOfLifeGrid {
    const db = getDatabase()
    const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000

    const rows = db.prepare(`
      SELECT
        CAST(strftime('%w', created_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
        CAST(strftime('%H', created_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        COUNT(*) AS n
      FROM intel_reports
      WHERE discipline = ? AND created_at >= ?
      GROUP BY dow, hour
    `).all(discipline, sinceMs) as Array<{ dow: number; hour: number; n: number }>

    const grid = this.emptyGrid()
    const dayTotals = new Array(7).fill(0)
    const hourTotals = new Array(24).fill(0)
    let total = 0, peak = 0
    for (const row of rows) {
      if (row.dow < 0 || row.dow > 6 || row.hour < 0 || row.hour > 23) continue
      grid[row.dow][row.hour] = row.n
      dayTotals[row.dow] += row.n
      hourTotals[row.hour] += row.n
      total += row.n
      if (row.n > peak) peak = row.n
    }

    return {
      entity_id: `discipline:${discipline}`,
      canonical_value: discipline,
      entity_type: 'discipline',
      window_days: windowDays,
      total_mentions: total,
      grid, day_totals: dayTotals, hour_totals: hourTotals, peak_cell: peak
    }
  }
}

export const patternOfLifeService = new PatternOfLifeService()
