import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { llmService } from '../llm/LlmService'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 9.5 + 9.6 + 9.7 — Briefing polish.
 *
 *  9.5  Briefing template editor — agency house format once, system fills it.
 *  9.6  Tear-line auto-generator — a sanitized "REL TO FIVE EYES / REL TO NATO"
 *       summary extracted from a classified DPB.
 *  9.7  What-changed digest — diff intel state between two timestamps,
 *       persisted as an intel_snapshots row the analyst can diff against.
 */

// ─── 9.5 templates ──────────────────────────────────────────────────────
export interface BriefingTemplate {
  id: string
  name: string
  body_md: string
  is_default: number
  created_at: number
  updated_at: number
}

const DEFAULT_TEMPLATES: Array<{ name: string; body_md: string }> = [
  {
    name: 'Daily President\'s Brief (default)',
    body_md: `# ${'{{title}}'}\n\n**Classification:** ${'{{classification}}'}\n**Period:** ${'{{period}}'}\n**Generated:** ${'{{generated_at}}'}\n\n## Overview\n\n${'{{overview}}'}\n\n## Indicators & Warning\n\n${'{{iw_summary}}'}\n\n## Cyber\n\n${'{{cyber_summary}}'}\n\n## Pending actions\n\n${'{{pending_actions}}'}\n\n## Open questions\n\n${'{{open_gaps}}'}\n`
  },
  {
    name: 'NATO INTSUM (short)',
    body_md: `## INTSUM\n**CLASSIFICATION:** ${'{{classification}}'}\n**DTG:** ${'{{generated_at}}'}\n**PERIOD:** ${'{{period}}'}\n\n1. HIGHLIGHTS\n${'{{overview}}'}\n\n2. INDICATORS\n${'{{iw_summary}}'}\n\n3. ASSESSMENT\n${'{{assessment}}'}\n\n4. RECOMMENDATIONS\n${'{{pending_actions}}'}\n`
  },
  {
    name: 'Cyber Daily',
    body_md: `# Cyber Daily — ${'{{period}}'}\n\n**Classification:** ${'{{classification}}'}\n\n## New CVEs\n${'{{cves_summary}}'}\n\n## ATT&CK highlights\n${'{{attack_summary}}'}\n\n## Active campaigns\n${'{{campaigns_summary}}'}\n\n## Analyst notes\n${'{{overview}}'}\n`
  }
]

export class BriefingService {
  seedDefaults(): void {
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) AS n FROM briefing_templates').get() as { n: number }).n
    if (count > 0) return
    const now = Date.now()
    const ins = db.prepare(
      'INSERT INTO briefing_templates (id, name, body_md, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      for (let i = 0; i < DEFAULT_TEMPLATES.length; i++) {
        const t = DEFAULT_TEMPLATES[i]
        ins.run(generateId(), t.name, t.body_md, i === 0 ? 1 : 0, now, now)
      }
    })
    tx()
    log.info('briefing: seeded default templates')
  }

  listTemplates(): BriefingTemplate[] {
    const db = getDatabase()
    this.seedDefaults()
    return db.prepare('SELECT id, name, body_md, is_default, created_at, updated_at FROM briefing_templates ORDER BY is_default DESC, name').all() as BriefingTemplate[]
  }

  saveTemplate(input: { id?: string; name: string; body_md: string; is_default?: boolean }): BriefingTemplate {
    const db = getDatabase()
    const now = Date.now()
    if (input.id) {
      db.prepare('UPDATE briefing_templates SET name = ?, body_md = ?, is_default = ?, updated_at = ? WHERE id = ?').run(
        input.name, input.body_md, input.is_default ? 1 : 0, now, input.id
      )
      if (input.is_default) {
        db.prepare('UPDATE briefing_templates SET is_default = 0 WHERE id != ?').run(input.id)
      }
      return db.prepare('SELECT id, name, body_md, is_default, created_at, updated_at FROM briefing_templates WHERE id = ?').get(input.id) as BriefingTemplate
    }
    const id = generateId()
    db.prepare(
      'INSERT INTO briefing_templates (id, name, body_md, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, input.name, input.body_md, input.is_default ? 1 : 0, now, now)
    if (input.is_default) {
      db.prepare('UPDATE briefing_templates SET is_default = 0 WHERE id != ?').run(id)
    }
    return db.prepare('SELECT id, name, body_md, is_default, created_at, updated_at FROM briefing_templates WHERE id = ?').get(id) as BriefingTemplate
  }

  deleteTemplate(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM briefing_templates WHERE id = ?').run(id)
  }

  // ─── 9.6 tear-line ─────────────────────────────────────────────────
  /**
   * Turn a classified body_md into a tear-line-safe summary. Uses the LLM
   * to strip source names, specific values, and any [intel:…] or [humint:…]
   * markers while preserving claims rated at a lower classification level.
   */
  async tearline(args: { body_md: string; release_marking: string; target_classification?: string }): Promise<string> {
    const system = `You are an intelligence analyst producing a tear-line summary. Input: a classified intel brief in markdown. Output: a sanitized summary that preserves analytic conclusions but strips source names, specific identifiers (hashes, IPs, unique CVEs where not already in NVD), internal citation markers ([intel:UUID], [humint:UUID]), and any compartment mentions.\n\nRelease marking for output: ${args.release_marking}.\nTarget classification: ${args.target_classification ?? 'UNCLASSIFIED//FOUO'}.\n\nOutput plain markdown, start with a REL line, keep under 400 words. No preamble, no prose wrapper — just the tear-line.`
    const prompt = `${system}\n\n---INPUT---\n${args.body_md.slice(0, 20000)}\n---END---\n\nTear-line now.`
    try {
      const raw = await llmService.complete(prompt, undefined, 1500)
      try {
        auditChainService.append('briefing.tearline', {
          entityType: 'tearline', entityId: generateId(),
          payload: { release: args.release_marking, input_len: args.body_md.length, output_len: raw.length }
        })
      } catch { /* noop */ }
      return raw
    } catch (err) {
      log.warn(`briefing: tearline LLM failed: ${(err as Error).message}`)
      throw err
    }
  }

  // ─── 9.7 what-changed digest ───────────────────────────────────────
  /**
   * Snapshot the current intel state (counts by discipline + severity +
   * top canonical entities). Two snapshots can then be diffed.
   */
  snapshot(label?: string): { id: string; taken_at: number; total_reports: number } {
    const db = getDatabase()
    const discRows = db.prepare(`SELECT discipline, COUNT(*) AS n FROM intel_reports GROUP BY discipline`).all() as Array<{ discipline: string; n: number }>
    const sevRows = db.prepare(`SELECT severity, COUNT(*) AS n FROM intel_reports GROUP BY severity`).all() as Array<{ severity: string; n: number }>
    let topEntities: Array<{ entity_type: string; canonical_value: string; mention_count: number }> = []
    try {
      topEntities = db.prepare(`SELECT entity_type, canonical_value, mention_count FROM canonical_entities ORDER BY mention_count DESC LIMIT 50`).all() as typeof topEntities
    } catch { /* table may not exist on fresh install */ }
    const totalReports = (db.prepare('SELECT COUNT(*) AS n FROM intel_reports').get() as { n: number }).n

    const payload = {
      discipline_counts: Object.fromEntries(discRows.map((r) => [r.discipline, r.n])),
      severity_counts: Object.fromEntries(sevRows.map((r) => [r.severity, r.n])),
      top_entities: topEntities
    }
    const id = generateId()
    const now = Date.now()
    db.prepare(
      'INSERT INTO intel_snapshots (id, taken_at, label, total_reports, payload) VALUES (?, ?, ?, ?, ?)'
    ).run(id, now, label ?? null, totalReports, JSON.stringify(payload))
    return { id, taken_at: now, total_reports: totalReports }
  }

  listSnapshots(limit = 20): Array<{ id: string; taken_at: number; label: string | null; total_reports: number }> {
    const db = getDatabase()
    return db.prepare('SELECT id, taken_at, label, total_reports FROM intel_snapshots ORDER BY taken_at DESC LIMIT ?').all(limit) as Array<{ id: string; taken_at: number; label: string | null; total_reports: number }>
  }

  diff(fromId: string, toId?: string): {
    from: { id: string; taken_at: number; total: number }
    to: { id: string; taken_at: number; total: number }
    delta_reports: number
    discipline_delta: Record<string, number>
    severity_delta: Record<string, number>
    new_top_entities: Array<{ entity_type: string; canonical_value: string; mention_count: number }>
  } {
    const db = getDatabase()
    const from = db.prepare('SELECT id, taken_at, total_reports, payload FROM intel_snapshots WHERE id = ?').get(fromId) as { id: string; taken_at: number; total_reports: number; payload: string } | undefined
    if (!from) throw new Error(`No such snapshot: ${fromId}`)
    let toRow: { id: string; taken_at: number; total_reports: number; payload: string } | undefined
    if (toId) {
      toRow = db.prepare('SELECT id, taken_at, total_reports, payload FROM intel_snapshots WHERE id = ?').get(toId) as typeof toRow
      if (!toRow) throw new Error(`No such snapshot: ${toId}`)
    } else {
      // Compare against a live snapshot.
      const live = this.snapshot('diff-live')
      toRow = db.prepare('SELECT id, taken_at, total_reports, payload FROM intel_snapshots WHERE id = ?').get(live.id) as typeof toRow
    }

    const fromP = JSON.parse(from.payload) as { discipline_counts: Record<string, number>; severity_counts: Record<string, number>; top_entities: Array<{ entity_type: string; canonical_value: string; mention_count: number }> }
    const toP = JSON.parse(toRow!.payload) as typeof fromP

    const dDelta: Record<string, number> = {}
    const allDiscs = new Set([...Object.keys(fromP.discipline_counts), ...Object.keys(toP.discipline_counts)])
    for (const d of allDiscs) dDelta[d] = (toP.discipline_counts[d] ?? 0) - (fromP.discipline_counts[d] ?? 0)

    const sDelta: Record<string, number> = {}
    const allSev = new Set([...Object.keys(fromP.severity_counts), ...Object.keys(toP.severity_counts)])
    for (const s of allSev) sDelta[s] = (toP.severity_counts[s] ?? 0) - (fromP.severity_counts[s] ?? 0)

    const fromEntityKeys = new Set(fromP.top_entities.map((e) => `${e.entity_type}|${e.canonical_value}`))
    const newTop = toP.top_entities.filter((e) => !fromEntityKeys.has(`${e.entity_type}|${e.canonical_value}`))

    return {
      from: { id: from.id, taken_at: from.taken_at, total: from.total_reports },
      to: { id: toRow!.id, taken_at: toRow!.taken_at, total: toRow!.total_reports },
      delta_reports: toRow!.total_reports - from.total_reports,
      discipline_delta: dDelta,
      severity_delta: sDelta,
      new_top_entities: newTop.slice(0, 25)
    }
  }
}

export const briefingService = new BriefingService()
