import log from 'electron-log'
import { generateId, timestamp } from '@common/utils/id'
import { getDatabase } from '../database'
import { llmService } from './LlmService'
import { PromptBuilder } from './PromptBuilder'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 5.5 — Wargaming module.
 *
 * Extends the Multi-Agent Analyst Council pattern with a three-role
 * adversarial simulation:
 *   Red Team Player  — adopts the adversary's perspective, proposes actions
 *   Blue Team Player — defends, counters, proposes mitigations
 *   Moderator        — evaluates the round, adjudicates outcomes,
 *                      declares escalation / de-escalation
 *
 * Runs for N rounds (default 3). Each round: Red → Blue → Moderator.
 * The full transcript is stored and exportable via ExportService.
 */

export interface WargameRun {
  id: string
  scenario: string
  red_objective: string | null
  blue_objective: string | null
  total_rounds: number
  status: string
  classification: string
  started_at: number
  completed_at: number | null
}

export interface WargameRound {
  id: string
  run_id: string
  round_number: number
  role: string
  content: string
  duration_ms: number
  created_at: number
}

const RED_SYSTEM = (scenario: string, objective: string) =>
  `You are RED TEAM — an adversary in a wargaming exercise. Scenario: ${scenario}. Your objective: ${objective || 'achieve maximum strategic advantage'}.\n\nPropose ONE concrete action this round. Be specific (unit, timing, method). 3-5 sentences max. No preamble.`

const BLUE_SYSTEM = (scenario: string, objective: string, redAction: string) =>
  `You are BLUE TEAM — the defender in a wargaming exercise. Scenario: ${scenario}. Your objective: ${objective || 'protect critical assets and prevent escalation'}.\n\nRed Team just acted: "${redAction}"\n\nRespond with ONE concrete counter-action. Be specific. 3-5 sentences max. No preamble.`

const MOD_SYSTEM = (scenario: string, redAction: string, blueResponse: string, roundNum: number, totalRounds: number) =>
  `You are the MODERATOR of a wargaming exercise. Scenario: ${scenario}.\n\nRound ${roundNum}/${totalRounds}:\n- RED: ${redAction}\n- BLUE: ${blueResponse}\n\nEvaluate: (1) plausibility of both actions, (2) likely outcome, (3) escalation/de-escalation assessment. 4-6 sentences. End with "ESCALATION LEVEL: [1-5]" where 1=calm, 5=full conflict.`

export class WargamingService {
  async run(params: {
    scenario: string
    red_objective?: string
    blue_objective?: string
    total_rounds?: number
    classification?: string
  }): Promise<WargameRun> {
    const db = getDatabase()
    const id = generateId()
    const now = timestamp()
    const rounds = params.total_rounds ?? 3
    const cls = params.classification ?? 'UNCLASSIFIED'

    db.prepare(`
      INSERT INTO wargame_runs (id, scenario, red_objective, blue_objective, total_rounds, status, classification, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(id, params.scenario, params.red_objective ?? null, params.blue_objective ?? null, rounds, cls, now, now)

    const insRound = db.prepare(`
      INSERT INTO wargame_rounds (id, run_id, round_number, role, content, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    try {
      for (let round = 1; round <= rounds; round++) {
        // Red
        const t0 = Date.now()
        const redContent = await llmService.complete(
          RED_SYSTEM(params.scenario, params.red_objective ?? ''),
          undefined, 500
        )
        insRound.run(generateId(), id, round, 'red_team_player', redContent, Date.now() - t0, Date.now())

        // Blue
        const t1 = Date.now()
        const blueContent = await llmService.complete(
          BLUE_SYSTEM(params.scenario, params.blue_objective ?? '', redContent),
          undefined, 500
        )
        insRound.run(generateId(), id, round, 'blue_team_player', blueContent, Date.now() - t1, Date.now())

        // Moderator
        const t2 = Date.now()
        const modContent = await llmService.complete(
          MOD_SYSTEM(params.scenario, redContent, blueContent, round, rounds),
          undefined, 600
        )
        insRound.run(generateId(), id, round, 'moderator', modContent, Date.now() - t2, Date.now())
      }

      db.prepare('UPDATE wargame_runs SET status = ?, completed_at = ? WHERE id = ?').run('completed', Date.now(), id)

      try {
        auditChainService.append('wargame.completed', {
          entityType: 'wargame_run', entityId: id,
          payload: { scenario: params.scenario.slice(0, 100), rounds, classification: cls }
        })
      } catch { /* noop */ }

      log.info(`wargame: ${id} completed — ${rounds} rounds, scenario "${params.scenario.slice(0, 60)}"`)
    } catch (err) {
      db.prepare('UPDATE wargame_runs SET status = ? WHERE id = ?').run(`error: ${(err as Error).message.slice(0, 200)}`, id)
      throw err
    }

    return this.get(id)!
  }

  get(id: string): WargameRun | null {
    const db = getDatabase()
    return (db.prepare(
      'SELECT id, scenario, red_objective, blue_objective, total_rounds, status, classification, started_at, completed_at FROM wargame_runs WHERE id = ?'
    ).get(id) as WargameRun) || null
  }

  getRounds(runId: string): WargameRound[] {
    const db = getDatabase()
    return db.prepare(
      'SELECT id, run_id, round_number, role, content, duration_ms, created_at FROM wargame_rounds WHERE run_id = ? ORDER BY round_number, created_at'
    ).all(runId) as WargameRound[]
  }

  list(limit = 20): WargameRun[] {
    const db = getDatabase()
    return db.prepare(
      'SELECT id, scenario, red_objective, blue_objective, total_rounds, status, classification, started_at, completed_at FROM wargame_runs ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as WargameRun[]
  }
}

export const wargamingService = new WargamingService()
