// EstimateService — v1.9.5 ICD-203 estimative-probability tracker.
//
// Lets analysts log a forecast with a Words of Estimative Probability
// (WEP) phrase, a deadline, and resolution criteria. When the
// deadline passes, the analyst records the outcome. The service then
// computes a Brier score and per-WEP calibration buckets so the
// analyst can see whether their "likely" forecasts actually come true
// ~65% of the time.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase, isDatabaseReady } from '../database'

export type Wep =
  | 'almost_certain' | 'very_likely' | 'likely' | 'even_chance'
  | 'unlikely' | 'very_unlikely' | 'almost_no_chance'

export type ConfidenceBand = 'low' | 'moderate' | 'high'

export type EstimateStatus =
  | 'open'
  | 'resolved_correct'
  | 'resolved_partial'
  | 'resolved_wrong'
  | 'resolved_unknowable'

export type EstimateParentKind = 'hypothesis' | 'comparison' | 'briefing' | null

export const WEP_PROBABILITY: Record<Wep, number> = {
  almost_certain:   0.95,
  very_likely:      0.85,
  likely:           0.65,
  even_chance:      0.50,
  unlikely:         0.35,
  very_unlikely:    0.15,
  almost_no_chance: 0.05
}

export const STATUS_OUTCOME: Partial<Record<EstimateStatus, number>> = {
  resolved_correct: 1.0,
  resolved_partial: 0.5,
  resolved_wrong:   0.0
  // resolved_unknowable: excluded
}

export interface Estimate {
  id: string
  statement: string
  wep: Wep
  confidence_band: ConfidenceBand
  deadline_at: number | null
  resolution_criteria: string | null
  parent_kind: EstimateParentKind
  parent_id: string | null
  parent_label: string | null
  status: EstimateStatus
  resolved_at: number | null
  resolution_note: string | null
  created_at: number
  updated_at: number
}

export interface PerWepStats {
  wep: Wep
  expected_pct: number
  resolved_n: number
  observed_pct: number | null
  open_n: number
}

export interface CalibrationStats {
  total: number
  open: number
  resolved: number
  brier_score: number | null
  per_wep: PerWepStats[]
}

export class EstimateService {
  list(): Estimate[] {
    return getDatabase()
      .prepare(`SELECT * FROM estimates ORDER BY
                 CASE WHEN status='open' THEN 0 ELSE 1 END,
                 COALESCE(deadline_at, updated_at) ASC,
                 updated_at DESC`)
      .all() as Estimate[]
  }

  listForParent(kind: NonNullable<EstimateParentKind>, parent_id: string): Estimate[] {
    return getDatabase()
      .prepare(`SELECT * FROM estimates WHERE parent_kind = ? AND parent_id = ? ORDER BY updated_at DESC`)
      .all(kind, parent_id) as Estimate[]
  }

  get(id: string): Estimate | null {
    const row = getDatabase().prepare(`SELECT * FROM estimates WHERE id = ?`).get(id) as
      | Estimate | undefined
    return row ?? null
  }

  create(args: {
    statement: string
    wep: Wep
    confidence_band?: ConfidenceBand
    deadline_at?: number | null
    resolution_criteria?: string | null
    parent_kind?: EstimateParentKind
    parent_id?: string | null
    parent_label?: string | null
  }): Estimate {
    if (!isDatabaseReady()) throw new Error('database not ready')
    if (!(args.wep in WEP_PROBABILITY)) throw new Error(`Invalid WEP: ${args.wep}`)
    const id = generateId()
    const now = Date.now()
    getDatabase().prepare(`
      INSERT INTO estimates
        (id, statement, wep, confidence_band, deadline_at, resolution_criteria,
         parent_kind, parent_id, parent_label, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id, args.statement.trim(), args.wep,
      args.confidence_band ?? 'moderate',
      args.deadline_at ?? null,
      (args.resolution_criteria ?? '').trim() || null,
      args.parent_kind ?? null,
      args.parent_id ?? null,
      args.parent_label ?? null,
      now, now
    )
    log.info(`estimate: created ${id} ${args.wep} "${args.statement.slice(0, 60)}"`)
    return this.get(id)!
  }

  update(id: string, patch: Partial<Pick<Estimate,
    'statement' | 'wep' | 'confidence_band' | 'deadline_at' | 'resolution_criteria'
  >>): Estimate | null {
    const cur = this.get(id); if (!cur) return null
    const next = { ...cur, ...patch }
    if (!(next.wep in WEP_PROBABILITY)) throw new Error(`Invalid WEP: ${next.wep}`)
    getDatabase().prepare(`
      UPDATE estimates SET statement = ?, wep = ?, confidence_band = ?,
                           deadline_at = ?, resolution_criteria = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.statement.trim(), next.wep, next.confidence_band,
      next.deadline_at, next.resolution_criteria, Date.now(), id
    )
    return this.get(id)
  }

  resolve(id: string, status: EstimateStatus, note?: string | null): Estimate | null {
    if (status === 'open') throw new Error('Use reopen() to set status open')
    const cur = this.get(id); if (!cur) return null
    const now = Date.now()
    getDatabase().prepare(`
      UPDATE estimates SET status = ?, resolved_at = ?, resolution_note = ?, updated_at = ?
      WHERE id = ?
    `).run(status, now, (note ?? '').trim() || null, now, id)
    return this.get(id)
  }

  reopen(id: string): Estimate | null {
    const cur = this.get(id); if (!cur) return null
    getDatabase().prepare(`
      UPDATE estimates SET status = 'open', resolved_at = NULL, resolution_note = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), id)
    return this.get(id)
  }

  remove(id: string): void {
    getDatabase().prepare(`DELETE FROM estimates WHERE id = ?`).run(id)
  }

  // ── Calibration ─────────────────────────────────────────────────

  /** Brier score across all resolved estimates (excluding 'unknowable').
   *  Lower is better; 0 is perfect, 0.25 is random for 50/50 calls. */
  calibration(): CalibrationStats {
    const rows = this.list()
    const total = rows.length
    const open = rows.filter((r) => r.status === 'open').length
    const resolvedRows = rows.filter((r) => r.status in STATUS_OUTCOME)
    const resolved = resolvedRows.length

    let brier: number | null = null
    if (resolved > 0) {
      let sum = 0
      for (const r of resolvedRows) {
        const p = WEP_PROBABILITY[r.wep]
        const o = STATUS_OUTCOME[r.status]!
        sum += (p - o) ** 2
      }
      brier = sum / resolved
    }

    const per_wep: PerWepStats[] = (Object.keys(WEP_PROBABILITY) as Wep[]).map((wep) => {
      const inBucket = rows.filter((r) => r.wep === wep)
      const resolvedInBucket = inBucket.filter((r) => r.status in STATUS_OUTCOME)
      const open_n = inBucket.filter((r) => r.status === 'open').length
      const resolved_n = resolvedInBucket.length
      let observed_pct: number | null = null
      if (resolved_n > 0) {
        const sum = resolvedInBucket.reduce((acc, r) => acc + (STATUS_OUTCOME[r.status]!), 0)
        observed_pct = (sum / resolved_n) * 100
      }
      return {
        wep,
        expected_pct: WEP_PROBABILITY[wep] * 100,
        resolved_n,
        observed_pct,
        open_n
      }
    })

    return { total, open, resolved, brier_score: brier, per_wep }
  }
}

export const estimateService = new EstimateService()
