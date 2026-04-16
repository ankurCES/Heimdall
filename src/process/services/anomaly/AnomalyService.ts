import log from 'electron-log'
import { getDatabase } from '../database'

/**
 * Theme 5.3 — Time-series anomaly detection.
 *
 * Uses the modified z-score (MAD-based), which is robust to outliers —
 * the STL/Prophet approach in the roadmap would be overkill for daily
 * report-volume signals and would add heavy dependencies. The modified
 * z-score is what most practitioners default to for "is today an
 * outlier vs the last month?" questions.
 *
 *     modified_z = 0.6745 * (x - median) / MAD
 *
 * Threshold: |z| > 3.5 is a commonly-cited outlier cut (Iglewicz & Hoaglin,
 * 1993). We use 3.0 as the "med" threshold and 4.5 as "high" since
 * intelligence signals tend to be spikier and 3.5 misses the truly
 * dramatic bursts.
 *
 * Signals covered in this batch:
 *   - report_volume           — all-discipline daily count
 *   - report_volume:<disc>    — per-discipline daily count
 *   - watch_hits              — total daily watch-term hits
 *
 * More signals (finint volatility, sentiment) can be added by extending
 * loadSignalSeries().
 */

export type AnomalySeverity = 'low' | 'med' | 'high'
export type AnomalyDirection = 'spike' | 'drop'

export interface Anomaly {
  id: number
  signal: string
  signal_label: string
  bucket_at: number
  value: number
  baseline_median: number
  baseline_mad: number
  modified_z: number
  direction: AnomalyDirection
  severity: AnomalySeverity
  created_at: number
}

export interface AnomalyRun {
  id: number
  started_at: number
  finished_at: number
  signals_scanned: number
  anomalies_found: number
  duration_ms: number
}

interface Series { signal: string; label: string; buckets: Array<{ bucket_at: number; value: number }> }

// Tuning
const MIN_HISTORY_DAYS = 14 // need this many prior points to judge
const Z_MED = 3.0
const Z_HIGH = 4.5

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function mad(xs: number[], med?: number): number {
  const m = med ?? median(xs)
  const dev = xs.map((x) => Math.abs(x - m))
  return median(dev)
}

export class AnomalyService {
  /** Daily series for every signal we track. Returns one Series per signal. */
  private loadSignalSeries(windowDays = 60): Series[] {
    const db = getDatabase()
    const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000

    // Report volume — aggregate + per-discipline.
    const reportRows = db.prepare(`
      SELECT
        discipline,
        strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS n
      FROM intel_reports
      WHERE created_at >= ?
      GROUP BY discipline, day
    `).all(sinceMs) as Array<{ discipline: string; day: string; n: number }>

    // Bucket by day (ms at 00:00 local). dayKey → { total, byDisc }.
    const dayMap = new Map<string, { bucket_at: number; total: number; byDisc: Map<string, number> }>()
    for (const r of reportRows) {
      const bucket = new Date(`${r.day}T00:00:00`).getTime()
      const entry = dayMap.get(r.day) ?? { bucket_at: bucket, total: 0, byDisc: new Map<string, number>() }
      entry.total += r.n
      entry.byDisc.set(r.discipline, (entry.byDisc.get(r.discipline) ?? 0) + r.n)
      dayMap.set(r.day, entry)
    }

    const dayKeys = Array.from(dayMap.keys()).sort()
    const allBuckets = dayKeys.map((k) => ({ bucket_at: dayMap.get(k)!.bucket_at, value: dayMap.get(k)!.total }))
    const series: Series[] = [{ signal: 'report_volume', label: 'Reports per day (all disciplines)', buckets: allBuckets }]

    // Per-discipline series (only those with ≥MIN_HISTORY_DAYS coverage).
    const disciplineTotals = new Map<string, Array<{ bucket_at: number; value: number }>>()
    for (const d of dayKeys) {
      const entry = dayMap.get(d)!
      for (const [disc, n] of entry.byDisc) {
        const arr = disciplineTotals.get(disc) ?? []
        arr.push({ bucket_at: entry.bucket_at, value: n })
        disciplineTotals.set(disc, arr)
      }
    }
    for (const [disc, buckets] of disciplineTotals) {
      if (buckets.length >= MIN_HISTORY_DAYS) {
        series.push({ signal: `report_volume:${disc}`, label: `Reports per day — ${disc}`, buckets })
      }
    }

    // Watch-term hits — use watch_terms.last_hit_at as a proxy since there's
    // no hit-log table. Sum of last_hit_at values per day gives us a rough
    // "hits occurring today" view. Falls back silently if the column is
    // missing.
    try {
      const whRows = db.prepare(`
        SELECT
          strftime('%Y-%m-%d', last_hit_at/1000, 'unixepoch', 'localtime') AS day,
          COUNT(*) AS n
        FROM watch_terms
        WHERE last_hit_at >= ?
        GROUP BY day
      `).all(sinceMs) as Array<{ day: string; n: number }>
      if (whRows.length >= MIN_HISTORY_DAYS) {
        series.push({
          signal: 'watch_hits',
          label: 'Watch-term hits per day',
          buckets: whRows.map((r) => ({
            bucket_at: new Date(`${r.day}T00:00:00`).getTime(),
            value: r.n
          }))
        })
      }
    } catch { /* noop */ }

    return series
  }

  /**
   * Scan every signal series. For every bucket, score against its
   * trailing baseline and persist anomalies above Z_MED.
   */
  detect(windowDays = 60): AnomalyRun {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare(
      'INSERT INTO anomaly_runs (started_at) VALUES (?)'
    ).run(started).lastInsertRowid)

    try {
      const series = this.loadSignalSeries(windowDays)
      const ins = db.prepare(`
        INSERT INTO anomalies
          (signal, signal_label, bucket_at, value, baseline_median, baseline_mad,
           modified_z, direction, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signal, bucket_at) DO UPDATE SET
          value = excluded.value,
          baseline_median = excluded.baseline_median,
          baseline_mad = excluded.baseline_mad,
          modified_z = excluded.modified_z,
          direction = excluded.direction,
          severity = excluded.severity
      `)

      let total = 0
      const now = Date.now()
      const tx = db.transaction(() => {
        for (const s of series) {
          if (s.buckets.length < MIN_HISTORY_DAYS + 1) continue
          // Slide a trailing window of MIN_HISTORY_DAYS across the series.
          // Each point's baseline = median+MAD of the preceding window.
          for (let i = MIN_HISTORY_DAYS; i < s.buckets.length; i++) {
            const baselineValues = s.buckets.slice(Math.max(0, i - MIN_HISTORY_DAYS), i).map((b) => b.value)
            const med = median(baselineValues)
            const m = mad(baselineValues, med)
            if (m === 0) continue
            const x = s.buckets[i].value
            const z = 0.6745 * (x - med) / m
            const absZ = Math.abs(z)
            if (absZ < Z_MED) continue
            const severity: AnomalySeverity = absZ >= Z_HIGH ? 'high' : 'med'
            const direction: AnomalyDirection = z > 0 ? 'spike' : 'drop'
            ins.run(s.signal, s.label, s.buckets[i].bucket_at, x,
              med, m, z, direction, severity, now)
            total++
          }
        }
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE anomaly_runs SET finished_at=?, signals_scanned=?, anomalies_found=?, duration_ms=? WHERE id=?'
      ).run(finished, series.length, total, finished - started, runId)

      log.info(`anomaly: ${series.length} signals × trailing MAD — ${total} anomalies (${finished - started}ms)`)
      return { id: runId, started_at: started, finished_at: finished,
        signals_scanned: series.length, anomalies_found: total, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE anomaly_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  recent(limit = 100, severity?: AnomalySeverity): Anomaly[] {
    const db = getDatabase()
    if (severity) {
      return db.prepare(`
        SELECT id, signal, signal_label, bucket_at, value, baseline_median,
               baseline_mad, modified_z, direction, severity, created_at
        FROM anomalies WHERE severity = ? ORDER BY bucket_at DESC LIMIT ?
      `).all(severity, limit) as Anomaly[]
    }
    return db.prepare(`
      SELECT id, signal, signal_label, bucket_at, value, baseline_median,
             baseline_mad, modified_z, direction, severity, created_at
      FROM anomalies ORDER BY bucket_at DESC LIMIT ?
    `).all(limit) as Anomaly[]
  }

  latestRun(): AnomalyRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, signals_scanned, anomalies_found, duration_ms
      FROM anomaly_runs WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as AnomalyRun) || null
  }

  signalSummary(): Array<{ signal: string; signal_label: string; anomaly_count: number; last_anomaly_at: number | null }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT signal, signal_label,
             COUNT(*) AS anomaly_count,
             MAX(bucket_at) AS last_anomaly_at
      FROM anomalies GROUP BY signal
      ORDER BY anomaly_count DESC
    `).all() as Array<{ signal: string; signal_label: string; anomaly_count: number; last_anomaly_at: number | null }>
  }
}

export const anomalyService = new AnomalyService()
