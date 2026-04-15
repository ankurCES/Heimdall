import crypto from 'crypto'
import log from 'electron-log'
import { getDatabase } from '../database'

/**
 * Theme 6.1 + 6.3 — Counter-intelligence scoring.
 *
 * Linguistic deception heuristics over intel_report.content. Every flag
 * contributes 0–20 points to an overall score capped at 100. The heuristics
 * are drawn from practitioner literature (Heuer's *Psychology of
 * Intelligence Analysis*, CIA Dir of Intel writing guides, Navarro's
 * deception detection work). None of them is individually decisive — the
 * point is to raise analyst awareness, not to auto-adjudicate.
 *
 * Complementary to but independent of STANAG 2511 source reliability
 * rating: reliability rates the SOURCE; deception score rates the TEXT.
 *
 * The state-media bias list in source_bias_flags is seeded from a small
 * curated set on first use. Deployers can add rows via direct DB edit or
 * via a future admin UI — the service just consumes whatever is there.
 */

export interface DeceptionFlag {
  code: string
  severity: 'low' | 'med' | 'high'
  points: number
  reason: string
}

export interface DeceptionScore {
  report_id: string
  overall_score: number
  flags: DeceptionFlag[]
  word_count: number
  computed_at: number
}

export interface CounterintelRun {
  id: number
  started_at: number
  finished_at: number
  reports_scored: number
  avg_score: number
  high_flag_count: number
  duration_ms: number
}

// Hedge / attribution words signalling low-provenance claims.
const HEDGE_TERMS = [
  'reportedly', 'allegedly', 'rumored', 'rumoured', 'purportedly', 'supposedly',
  'sources say', 'sources claim', 'sources indicate', 'unnamed sources',
  'anonymous sources', 'it is said', 'it is believed', 'some say',
  'observers say', 'analysts suggest', 'sources close to', 'insiders claim',
  'according to reports'
]

// Emotional / urgent language that flags opinion-pushing content.
const LOADED_TERMS = [
  'shocking', 'devastating', 'catastrophic', 'unprecedented', 'outrageous',
  'horrific', 'jaw-dropping', 'bombshell', 'stunning revelation',
  'breaking', 'urgent', 'emergency', 'must-read', 'exclusive',
  'explosive', 'sensational'
]

// Definitive claims without sourcing — these paired with unknown
// provenance are a bigger flag than hedges.
const DEFINITIVE_TERMS = [
  'confirmed that', 'proven that', 'definitely', 'without a doubt',
  'obviously', 'clearly', 'undoubtedly', 'certainly'
]

// Seeded state-media source bias entries. match_type: 'source_name' or
// 'source_url'. The list is conservative — entries are organizations
// widely documented as aligned with a state position, per academic
// media-watch research (Freedom House, Reporters Without Borders, EU
// vs Disinfo, Stanford Internet Observatory).
const SEED_SOURCE_BIAS: Array<{ match_type: 'source_name' | 'source_url'; match_value: string; bias_direction: string; note: string }> = [
  // Russia
  { match_type: 'source_name', match_value: 'TASS', bias_direction: 'pro-kremlin', note: 'Russian state news agency' },
  { match_type: 'source_name', match_value: 'RT', bias_direction: 'pro-kremlin', note: 'Russia Today — Kremlin-funded' },
  { match_type: 'source_name', match_value: 'Russia Today', bias_direction: 'pro-kremlin', note: 'Kremlin-funded' },
  { match_type: 'source_name', match_value: 'Sputnik', bias_direction: 'pro-kremlin', note: 'Rossiya Segodnya (state)' },
  { match_type: 'source_name', match_value: 'RIA Novosti', bias_direction: 'pro-kremlin', note: 'Russian state news' },
  { match_type: 'source_url', match_value: 'rt.com', bias_direction: 'pro-kremlin', note: '' },
  { match_type: 'source_url', match_value: 'tass.com', bias_direction: 'pro-kremlin', note: '' },
  { match_type: 'source_url', match_value: 'sputnikglobe.com', bias_direction: 'pro-kremlin', note: '' },
  { match_type: 'source_url', match_value: 'sputniknews.com', bias_direction: 'pro-kremlin', note: '' },

  // China
  { match_type: 'source_name', match_value: 'Xinhua', bias_direction: 'pro-beijing', note: 'Chinese state news agency' },
  { match_type: 'source_name', match_value: 'Global Times', bias_direction: 'pro-beijing', note: 'CPC-aligned tabloid' },
  { match_type: 'source_name', match_value: 'CCTV', bias_direction: 'pro-beijing', note: 'Chinese state TV' },
  { match_type: 'source_name', match_value: "People's Daily", bias_direction: 'pro-beijing', note: 'CPC official paper' },
  { match_type: 'source_name', match_value: 'China Daily', bias_direction: 'pro-beijing', note: '' },
  { match_type: 'source_url', match_value: 'xinhuanet.com', bias_direction: 'pro-beijing', note: '' },
  { match_type: 'source_url', match_value: 'globaltimes.cn', bias_direction: 'pro-beijing', note: '' },
  { match_type: 'source_url', match_value: 'chinadaily.com.cn', bias_direction: 'pro-beijing', note: '' },

  // Iran
  { match_type: 'source_name', match_value: 'IRNA', bias_direction: 'pro-tehran', note: 'Iranian state news agency' },
  { match_type: 'source_name', match_value: 'PressTV', bias_direction: 'pro-tehran', note: 'Iranian state (EN)' },
  { match_type: 'source_name', match_value: 'Press TV', bias_direction: 'pro-tehran', note: 'Iranian state (EN)' },
  { match_type: 'source_name', match_value: 'Tasnim', bias_direction: 'pro-tehran', note: 'IRGC-aligned' },
  { match_type: 'source_name', match_value: 'Fars News', bias_direction: 'pro-tehran', note: 'IRGC-aligned' },
  { match_type: 'source_name', match_value: 'Mehr News', bias_direction: 'pro-tehran', note: '' },
  { match_type: 'source_url', match_value: 'presstv.ir', bias_direction: 'pro-tehran', note: '' },
  { match_type: 'source_url', match_value: 'tasnimnews.com', bias_direction: 'pro-tehran', note: '' },

  // North Korea
  { match_type: 'source_name', match_value: 'KCNA', bias_direction: 'pro-pyongyang', note: 'DPRK state news' },
  { match_type: 'source_url', match_value: 'kcna.kp', bias_direction: 'pro-pyongyang', note: '' },

  // Other
  { match_type: 'source_name', match_value: 'Al Mayadeen', bias_direction: 'pro-hezbollah', note: 'Hezbollah-aligned (Lebanon)' },
  { match_type: 'source_name', match_value: 'Anadolu Agency', bias_direction: 'pro-ankara', note: 'Turkish state news' },
  { match_type: 'source_name', match_value: 'TRT World', bias_direction: 'pro-ankara', note: 'Turkish state broadcaster' }
]

export class DeceptionService {
  /**
   * Idempotently seed source_bias_flags. Safe to call on every startup.
   */
  seedSourceBias(): void {
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) AS n FROM source_bias_flags').get() as { n: number }).n
    if (count > 0) return
    const ins = db.prepare(`
      INSERT INTO source_bias_flags (id, match_type, match_value, bias_direction, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const row of SEED_SOURCE_BIAS) {
        const id = crypto.createHash('sha256')
          .update(`${row.match_type}|${row.match_value}`).digest('hex').slice(0, 24)
        ins.run(id, row.match_type, row.match_value, row.bias_direction, row.note, now)
      }
    })
    tx()
    log.info(`counterintel: seeded ${SEED_SOURCE_BIAS.length} state-media source bias rows`)
  }

  /**
   * Score a single text. Pure function (no DB) — used by both the batch
   * analyser and any future on-ingest hook.
   */
  scoreText(content: string): { overall_score: number; flags: DeceptionFlag[]; word_count: number } {
    const text = (content || '').trim()
    const words = text.split(/\s+/).filter(Boolean)
    const wc = words.length
    const flags: DeceptionFlag[] = []

    if (wc === 0) {
      return { overall_score: 0, flags, word_count: 0 }
    }

    const lower = text.toLowerCase()
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)

    // Hedge density. ≥3 hedges or hedge density > 1% flags.
    const hedgeCount = HEDGE_TERMS.reduce((n, t) => n + countOccurrences(lower, t), 0)
    const hedgeDensity = hedgeCount / Math.max(wc, 1)
    if (hedgeCount >= 3 || hedgeDensity > 0.01) {
      flags.push({
        code: 'hedge_overuse',
        severity: hedgeCount >= 6 ? 'high' : 'med',
        points: Math.min(20, Math.round(hedgeCount * 2.5)),
        reason: `${hedgeCount} hedge phrases ("reportedly", "sources say" …) — weak provenance`
      })
    }

    // Loaded / emotional language. Flags opinion-pushing or urgency baiting.
    const loadedCount = LOADED_TERMS.reduce((n, t) => n + countOccurrences(lower, t), 0)
    if (loadedCount >= 2) {
      flags.push({
        code: 'emotional_loading',
        severity: loadedCount >= 5 ? 'high' : 'med',
        points: Math.min(15, loadedCount * 3),
        reason: `${loadedCount} emotionally loaded terms (superlatives, urgency language)`
      })
    }

    // Definitive without attribution. Pairs especially badly with hedges
    // elsewhere in the same piece.
    const definitiveCount = DEFINITIVE_TERMS.reduce((n, t) => n + countOccurrences(lower, t), 0)
    if (definitiveCount >= 2) {
      flags.push({
        code: 'unqualified_certainty',
        severity: 'med',
        points: Math.min(12, definitiveCount * 4),
        reason: `${definitiveCount} unqualified-certainty phrases ("obviously", "clearly", "without doubt")`
      })
    }

    // Passive-voice overuse — heuristic: "was/were/been/being + past-participle".
    // A real POS tagger would be better; this is cheap and catches the signal.
    const passiveMatches = text.match(/\b(was|were|been|being|is|are)\s+\w+(ed|en)\b/gi) || []
    if (passiveMatches.length > 0 && sentences.length > 0) {
      const passiveRatio = passiveMatches.length / sentences.length
      if (passiveRatio > 0.4 && passiveMatches.length >= 5) {
        flags.push({
          code: 'passive_overuse',
          severity: passiveRatio > 0.7 ? 'high' : 'med',
          points: Math.min(12, Math.round(passiveRatio * 15)),
          reason: `${passiveMatches.length} passive-voice constructions (ratio ${(passiveRatio * 100).toFixed(0)}%) — obscures actor`
        })
      }
    }

    // Over-precision — unnecessarily exact numerics paired with non-precise
    // context (e.g. "exactly 14:37:22" in a general news piece).
    const overPreciseMatches = text.match(/\bexactly\s+\d{1,2}[:.]?\d{1,2}(?:[:.]\d{1,2})?\b|\bprecisely\s+\d/gi) || []
    if (overPreciseMatches.length >= 2) {
      flags.push({
        code: 'over_precision',
        severity: 'low',
        points: Math.min(10, overPreciseMatches.length * 3),
        reason: `${overPreciseMatches.length} over-precise quantifiers (fabricated-detail tell in deception literature)`
      })
    }

    // First / third person mixing — crude check: personal pronouns both used.
    const firstPersonCount = (text.match(/\b(I|we|my|our|us|me)\b/g) || []).length
    const thirdPersonClaims = (text.match(/\b(they|them|their|he|she|his|her)\b/g) || []).length
    if (firstPersonCount >= 3 && thirdPersonClaims >= 3 && firstPersonCount > 0 && thirdPersonClaims > 0) {
      // Only flag if it's a short-ish piece — long analyses legitimately mix.
      if (wc < 400) {
        flags.push({
          code: 'pronoun_mixing',
          severity: 'low',
          points: 5,
          reason: 'First-person and third-person frequently mixed in a short piece — voice inconsistency'
        })
      }
    }

    // Zero-attribution: long piece with 0 hedges AND no cited source names
    // (heuristic: no capitalized multi-word entity) is suspicious in the
    // other direction — claims presented as fact with no provenance.
    const hasSourceMarker = /\b(according to|said|stated|reported|per\s+\w+)\b/i.test(text)
    if (wc > 150 && hedgeCount === 0 && !hasSourceMarker) {
      flags.push({
        code: 'no_attribution',
        severity: 'med',
        points: 10,
        reason: 'Substantial piece with zero attribution or source markers'
      })
    }

    const overall = Math.min(100, flags.reduce((s, f) => s + f.points, 0))

    return { overall_score: overall, flags, word_count: wc }
  }

  /**
   * Batch-score every intel_report that doesn't yet have a deception score,
   * OR whose score is older than their own updated_at. Writes deception_scores
   * and a counterintel_runs summary row.
   */
  batchAnalyze(rescoreAll = false): CounterintelRun {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare('INSERT INTO counterintel_runs (started_at) VALUES (?)').run(started).lastInsertRowid)

    try {
      this.seedSourceBias()

      const rows = db.prepare(`
        SELECT r.id, r.content
        FROM intel_reports r
        ${rescoreAll ? '' : 'LEFT JOIN deception_scores d ON d.report_id = r.id WHERE d.report_id IS NULL'}
      `).all() as Array<{ id: string; content: string }>

      const now = Date.now()
      const ins = db.prepare(`
        INSERT INTO deception_scores (report_id, overall_score, flags, word_count, computed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(report_id) DO UPDATE SET
          overall_score = excluded.overall_score,
          flags = excluded.flags,
          word_count = excluded.word_count,
          computed_at = excluded.computed_at
      `)

      let highFlagCount = 0
      let scoreSum = 0
      const tx = db.transaction(() => {
        for (const r of rows) {
          const result = this.scoreText(r.content || '')
          ins.run(r.id, result.overall_score, JSON.stringify(result.flags), result.word_count, now)
          scoreSum += result.overall_score
          if (result.overall_score >= 40) highFlagCount++
        }
      })
      tx()

      const finished = Date.now()
      const avg = rows.length ? scoreSum / rows.length : 0
      db.prepare(
        'UPDATE counterintel_runs SET finished_at=?, reports_scored=?, avg_score=?, high_flag_count=?, duration_ms=? WHERE id=?'
      ).run(finished, rows.length, avg, highFlagCount, finished - started, runId)

      log.info(`counterintel: scored ${rows.length} reports in ${finished - started}ms; avg=${avg.toFixed(1)} high-flag=${highFlagCount}`)

      return {
        id: runId, started_at: started, finished_at: finished,
        reports_scored: rows.length, avg_score: avg,
        high_flag_count: highFlagCount, duration_ms: finished - started
      }
    } catch (err) {
      db.prepare('UPDATE counterintel_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  latestRun(): CounterintelRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, reports_scored, avg_score, high_flag_count, duration_ms
      FROM counterintel_runs
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as CounterintelRun) || null
  }

  /** Top-N most-flagged reports. */
  topSuspicious(limit = 50): Array<{
    report_id: string
    title: string
    source_name: string
    discipline: string
    severity: string
    created_at: number
    overall_score: number
    flag_count: number
    flags: DeceptionFlag[]
  }> {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT r.id AS report_id, r.title, r.source_name, r.discipline, r.severity, r.created_at,
             d.overall_score, d.flags
      FROM deception_scores d
      JOIN intel_reports r ON r.id = d.report_id
      WHERE d.overall_score > 0
      ORDER BY d.overall_score DESC LIMIT ?
    `).all(limit) as Array<{ report_id: string; title: string; source_name: string; discipline: string; severity: string; created_at: number; overall_score: number; flags: string }>
    return rows.map((r) => {
      const parsed = (() => { try { return JSON.parse(r.flags) as DeceptionFlag[] } catch { return [] } })()
      return { ...r, flags: parsed, flag_count: parsed.length }
    })
  }

  /** Detail for a single report. */
  forReport(reportId: string): DeceptionScore | null {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT report_id, overall_score, flags, word_count, computed_at FROM deception_scores WHERE report_id = ?'
    ).get(reportId) as { report_id: string; overall_score: number; flags: string; word_count: number; computed_at: number } | undefined
    if (!row) return null
    const parsed = (() => { try { return JSON.parse(row.flags) as DeceptionFlag[] } catch { return [] } })()
    return { report_id: row.report_id, overall_score: row.overall_score, flags: parsed, word_count: row.word_count, computed_at: row.computed_at }
  }

  /** All source_bias_flags rows. */
  listSourceBias(): Array<{ id: string; match_type: string; match_value: string; bias_direction: string; note: string | null }> {
    const db = getDatabase()
    this.seedSourceBias()
    return db.prepare(
      'SELECT id, match_type, match_value, bias_direction, note FROM source_bias_flags ORDER BY bias_direction, match_value'
    ).all() as Array<{ id: string; match_type: string; match_value: string; bias_direction: string; note: string | null }>
  }

  /**
   * Reports collected from any source flagged as state-aligned. Matches
   * either source_name or source_url (case-insensitive substring).
   */
  stateMediaReports(limit = 100): Array<{
    report_id: string; title: string; source_name: string; source_url: string | null;
    discipline: string; severity: string; created_at: number;
    bias_direction: string; bias_note: string | null
  }> {
    const db = getDatabase()
    this.seedSourceBias()
    const biasRows = this.listSourceBias()
    if (biasRows.length === 0) return []
    // Build a SQL OR chain. Parameters for LIKE use case-insensitive wildcards.
    const whereParts: string[] = []
    const params: unknown[] = []
    for (const b of biasRows) {
      if (b.match_type === 'source_name') {
        whereParts.push('lower(r.source_name) LIKE ?')
        params.push(`%${b.match_value.toLowerCase()}%`)
      } else {
        whereParts.push('lower(r.source_url) LIKE ?')
        params.push(`%${b.match_value.toLowerCase()}%`)
      }
    }
    params.push(limit)
    const rows = db.prepare(`
      SELECT r.id AS report_id, r.title, r.source_name, r.source_url, r.discipline, r.severity, r.created_at
      FROM intel_reports r
      WHERE ${whereParts.join(' OR ')}
      ORDER BY r.created_at DESC LIMIT ?
    `).all(...params) as Array<{ report_id: string; title: string; source_name: string; source_url: string | null; discipline: string; severity: string; created_at: number }>
    // Attach bias direction — first-match wins.
    return rows.map((r) => {
      const hit = biasRows.find((b) =>
        (b.match_type === 'source_name' && r.source_name?.toLowerCase().includes(b.match_value.toLowerCase())) ||
        (b.match_type === 'source_url' && (r.source_url || '').toLowerCase().includes(b.match_value.toLowerCase()))
      )
      return {
        ...r,
        bias_direction: hit?.bias_direction ?? 'unknown',
        bias_note: hit?.note ?? null
      }
    })
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0, i = 0
  const nl = needle.toLowerCase()
  while ((i = haystack.indexOf(nl, i)) !== -1) { n++; i += nl.length }
  return n
}

export const deceptionService = new DeceptionService()
