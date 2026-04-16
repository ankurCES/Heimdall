import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { llmService } from '../llm/LlmService'

/**
 * Theme 5.4 + 5.6.
 *
 *  5.4 Scenario forecasting — LLM generates best-case / most-likely /
 *      worst-case narratives with explicit uncertainty bounds (low/high
 *      probability bands per scenario).
 *
 *  5.6 Conflict probability heatmap — daily per-region score combining
 *      event volume (intel_reports count), negative-sentiment ratio
 *      (derived from severity distribution), and open I&W red-indicator
 *      count. Pure-SQL aggregation, no ML.
 */

// ─── 5.4 scenarios ──────────────────────────────────────────────────
export interface Scenario {
  id: string
  topic: string
  event_id: string | null
  scenario_class: 'best_case' | 'most_likely' | 'worst_case'
  body_md: string
  confidence_lo: number | null
  confidence_hi: number | null
  created_at: number
}

const SCENARIO_SYSTEM = `You are a senior intelligence analyst producing scenario forecasts under ICD 203 estimative standards.

For the given topic you will produce THREE scenarios: best_case, most_likely, worst_case. For each:
- Start with the class in a markdown ## heading (e.g. "## most_likely").
- 3-5 bullet points describing how it plays out (preconditions → events → outcome).
- End with a line: "Probability band: XX%–YY% — <ICD 203 language>".
  Bands must be non-overlapping and sum of midpoints roughly 100%.
  ICD 203 language: almost no chance (1–5%), very unlikely (5–20%), unlikely (20–45%),
  roughly even chance (45–55%), likely (55–80%), very likely (80–95%), almost certainly (95–99%).

Rules:
- No prose wrapper, no preamble — output the three ## sections.
- Anchor each scenario in plausible mechanisms; avoid hand-wavey "things could escalate".
- If you'd have to invent facts outside the topic, say so and narrow the scenario.`

export class ForecastService {
  async scenarios(topic: string, eventId?: string | null): Promise<Scenario[]> {
    if (!topic.trim()) return []
    const prompt = `${SCENARIO_SYSTEM}\n\nTopic: ${topic.trim()}\n\nProduce the three scenarios now.`
    const raw = await llmService.complete(prompt, undefined, 2500)
    const parsed = this.parseScenarios(raw)
    const db = getDatabase()
    const now = Date.now()
    const ins = db.prepare(`
      INSERT INTO scenarios (id, topic, event_id, scenario_class, body_md, confidence_lo, confidence_hi, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const saved: Scenario[] = []
    for (const p of parsed) {
      const id = generateId()
      ins.run(id, topic, eventId ?? null, p.scenario_class, p.body_md, p.confidence_lo, p.confidence_hi, now)
      saved.push({ id, topic, event_id: eventId ?? null, scenario_class: p.scenario_class, body_md: p.body_md, confidence_lo: p.confidence_lo, confidence_hi: p.confidence_hi, created_at: now })
    }
    log.info(`forecast: generated ${saved.length} scenarios for "${topic}"`)
    return saved
  }

  private parseScenarios(raw: string): Array<{ scenario_class: Scenario['scenario_class']; body_md: string; confidence_lo: number | null; confidence_hi: number | null }> {
    const chunks: Array<{ header: string; body: string }> = []
    const matches = Array.from(raw.matchAll(/^##\s*(best[_\s-]?case|most[_\s-]?likely|worst[_\s-]?case)\b/gim))
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      const next = matches[i + 1]
      const start = m.index!
      const end = next ? next.index! : raw.length
      chunks.push({ header: m[1], body: raw.slice(start, end).trim() })
    }
    const out: Array<{ scenario_class: Scenario['scenario_class']; body_md: string; confidence_lo: number | null; confidence_hi: number | null }> = []
    for (const c of chunks) {
      const key = c.header.toLowerCase().replace(/[\s-]+/g, '_')
      const scenarioClass: Scenario['scenario_class'] =
        key.startsWith('best') ? 'best_case' :
        key.startsWith('worst') ? 'worst_case' : 'most_likely'
      const band = /Probability band:\s*(\d{1,3})\s*%\s*[–\-—to]+\s*(\d{1,3})\s*%/.exec(c.body)
      out.push({
        scenario_class: scenarioClass,
        body_md: c.body,
        confidence_lo: band ? parseInt(band[1]) : null,
        confidence_hi: band ? parseInt(band[2]) : null
      })
    }
    return out
  }

  recentScenarios(limit = 30): Scenario[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, topic, event_id, scenario_class, body_md, confidence_lo, confidence_hi, created_at
      FROM scenarios ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Scenario[]
  }
}
export const forecastService = new ForecastService()

// ─── 5.6 conflict probability ───────────────────────────────────────
const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

export interface ConflictScore {
  region: string
  bucket_at: number
  event_volume: number
  negative_sentiment_ratio: number | null
  iw_red_count: number
  probability_0_100: number
  computed_at: number
}

export class ConflictProbabilityService {
  /**
   * Compute per-region conflict probability for the most recent 14 days.
   * region is extracted from intel_reports.country (if migration 015
   * added it) or source_name fallback.
   *
   * Formula (0-100):
   *   min(100, 30*log10(event_volume+1) + 20*(neg_ratio) + 15*iw_reds)
   *
   * Pure heuristic — not calibrated. But scored consistently so trend
   * comparisons across days/regions mean something.
   */
  compute(windowDays = 14): { buckets: number; regions: number } {
    const db = getDatabase()
    const now = Date.now()
    const since = now - windowDays * 24 * 60 * 60 * 1000

    // Region is derived from intel_entities (entity_type='country') —
    // country names are extracted by IntelEnricher's regex pattern during
    // the enrichment pipeline. Reports without a country entity are
    // excluded (they'd go into an "UNKNOWN" bucket that's not useful).
    const rows = db.prepare(`
      SELECT e.entity_value AS region,
        strftime('%Y-%m-%d', r.created_at/1000, 'unixepoch', 'localtime') AS day,
        r.severity,
        COUNT(DISTINCT r.id) AS n
      FROM intel_entities e
      JOIN intel_reports r ON r.id = e.report_id
      WHERE e.entity_type = 'country'
        AND r.created_at >= ?
        AND (r.quarantined IS NULL OR r.quarantined = 0)
      GROUP BY region, day, r.severity
    `).all(since) as Array<{ region: string; day: string; severity: string; n: number }>

    const byRegionDay = new Map<string, { region: string; bucket_at: number; events: number; sev_weighted: number }>()
    for (const r of rows) {
      const key = `${r.region}|${r.day}`
      const bucket = new Date(`${r.day}T00:00:00`).getTime()
      const entry = byRegionDay.get(key) ?? { region: r.region, bucket_at: bucket, events: 0, sev_weighted: 0 }
      entry.events += r.n
      entry.sev_weighted += (SEVERITY_WEIGHT[r.severity] ?? 0) * r.n
      byRegionDay.set(key, entry)
    }

    // Get I&W red indicators per region (approximate via the latest
    // iw_indicators evaluation). Good enough for a heuristic.
    let iwReds = new Map<string, number>()
    try {
      const iwRows = db.prepare(`
        SELECT COALESCE(json_extract(query_params, '$.region'), 'UNKNOWN') AS region,
               COUNT(*) AS n
        FROM iw_indicators
        WHERE current_level = 'red' AND status = 'active'
        GROUP BY region
      `).all() as Array<{ region: string; n: number }>
      for (const r of iwRows) iwReds.set(r.region, r.n)
    } catch { /* iw schema may differ */ }

    const ins = db.prepare(`
      INSERT INTO conflict_scores
        (region, bucket_at, event_volume, negative_sentiment_ratio, iw_red_count, probability_0_100, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(region, bucket_at) DO UPDATE SET
        event_volume = excluded.event_volume,
        negative_sentiment_ratio = excluded.negative_sentiment_ratio,
        iw_red_count = excluded.iw_red_count,
        probability_0_100 = excluded.probability_0_100,
        computed_at = excluded.computed_at
    `)
    const regions = new Set<string>()
    const tx = db.transaction(() => {
      for (const entry of byRegionDay.values()) {
        const negRatio = entry.events > 0 ? entry.sev_weighted / (entry.events * 4) : null
        const iw = iwReds.get(entry.region) ?? 0
        const score = Math.min(100, Math.round(
          30 * Math.log10(entry.events + 1) +
          20 * (negRatio ?? 0) +
          15 * iw
        ))
        ins.run(entry.region, entry.bucket_at, entry.events, negRatio, iw, score, now)
        regions.add(entry.region)
      }
    })
    tx()
    log.info(`conflict: computed ${byRegionDay.size} (region,day) buckets across ${regions.size} regions`)
    return { buckets: byRegionDay.size, regions: regions.size }
  }

  recent(region?: string, limit = 100): ConflictScore[] {
    const db = getDatabase()
    if (region) {
      return db.prepare(`
        SELECT region, bucket_at, event_volume, negative_sentiment_ratio, iw_red_count, probability_0_100, computed_at
        FROM conflict_scores WHERE region = ? ORDER BY bucket_at DESC LIMIT ?
      `).all(region, limit) as ConflictScore[]
    }
    return db.prepare(`
      SELECT region, bucket_at, event_volume, negative_sentiment_ratio, iw_red_count, probability_0_100, computed_at
      FROM conflict_scores ORDER BY bucket_at DESC LIMIT ?
    `).all(limit) as ConflictScore[]
  }

  topRegions(limit = 15): Array<{ region: string; latest_probability: number; last_bucket: number; max_probability: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT region,
             (SELECT probability_0_100 FROM conflict_scores c2 WHERE c2.region = c.region ORDER BY bucket_at DESC LIMIT 1) AS latest_probability,
             MAX(bucket_at) AS last_bucket,
             MAX(probability_0_100) AS max_probability
      FROM conflict_scores c
      GROUP BY region
      ORDER BY latest_probability DESC
      LIMIT ?
    `).all(limit) as Array<{ region: string; latest_probability: number; last_bucket: number; max_probability: number }>
  }
}
export const conflictService = new ConflictProbabilityService()
