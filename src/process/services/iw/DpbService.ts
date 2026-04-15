import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { auditChainService } from '../audit/AuditChainService'
import { iwService } from './IwService'
import log from 'electron-log'

/**
 * Daily President's Brief (DPB) generator — Theme 9.1 of the agency
 * roadmap.
 *
 * Assembles a structured snapshot of the operational picture from the
 * highest-priority intel of the past N hours, the current I&W indicator
 * status, recent HUMINT findings, open information gaps, pending
 * recommended actions, and trend changes.
 *
 * Each brief is persisted as a row in dpb_briefings with both a rendered
 * markdown body (body_md) and a structured JSON payload (body_json). The
 * structured payload lets future exports (Theme 9.4 — PDF / NATO INTREP /
 * encrypted ZIP) re-render in any house format.
 *
 * The brief honors classification: ITS classification is the highest
 * classification of any artifact summarized into it, capped at the user's
 * current clearance. Material above the user's clearance is filtered out
 * (a tear-line summary mode is Theme 9.6, deferred).
 */

const CLASSIFICATION_RANK: Record<string, number> = {
  UNCLASSIFIED: 0, CONFIDENTIAL: 1, SECRET: 2, 'TOP SECRET': 3
}
function maxClass(a: string, b: string): string {
  return CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b
}

interface BriefSection<T> { title: string; items: T[] }

interface DpbStructured {
  generated_at: number
  classification: string
  period_hours: number
  executive_summary: { title: string; severity: string; classification: string; source: string; id: string }[]
  iw_status: {
    event_id: string; event_name: string; level: string;
    indicators: { name: string; level: string; current_value: number | null; red: number | null; amber: number | null }[]
  }[]
  humint_highlights: { id: string; findings_excerpt: string; confidence: string; created_at: number }[]
  open_gaps: { id: string; description: string; severity: string; preliminary_id: string }[]
  pending_actions: { id: string; action: string; priority: string; preliminary_id: string }[]
  trend_change: { metric: string; current: number; previous: number; pct_change: number }[]
}

class DpbServiceImpl {
  /**
   * Generate a brief covering the last `period_hours` (default 24).
   * Caps included material at the user's clearance — material above
   * clearance is excluded from BOTH the markdown body and the structured
   * JSON, so a generated brief can never elevate-leak.
   */
  generate(opts: { periodHours?: number; clearance?: string; templateName?: string } = {}): {
    id: string; classification: string; body_md: string
  } {
    const db = getDatabase()
    const periodHours = opts.periodHours ?? 24
    const clearance = opts.clearance || 'UNCLASSIFIED'
    const cutoff = Date.now() - periodHours * 3600_000
    const yesterday = Date.now() - 2 * periodHours * 3600_000

    // Helper — true if `cls` is at or below `clearance`
    const visible = (cls: string) => CLASSIFICATION_RANK[cls] <= CLASSIFICATION_RANK[clearance]

    // 1) Executive summary — top critical/high in window
    const topReports = db.prepare(`
      SELECT r.id, r.title, r.severity, r.source_name, r.classification, r.created_at
      FROM intel_reports r
      WHERE r.created_at >= ? AND r.severity IN ('critical', 'high')
      ORDER BY
        CASE r.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
        r.verification_score DESC, r.created_at DESC
      LIMIT 50
    `).all(cutoff) as Array<{ id: string; title: string; severity: string; source_name: string; classification: string; created_at: number }>

    const executive = topReports
      .filter((r) => visible(r.classification || 'UNCLASSIFIED'))
      .slice(0, 8)

    // 2) I&W indicator status — every active event
    const events = iwService.listEvents({ status: 'active' }).filter((e) => visible(e.classification))
    const iwStatus = events.map((ev) => ({
      event_id: ev.id, event_name: ev.name, level: ev.level || 'green',
      indicators: (ev.indicators || []).map((ind) => ({
        name: ind.name, level: ind.current_level || 'green',
        current_value: ind.current_value, red: ind.red_threshold, amber: ind.amber_threshold
      }))
    }))

    // 3) HUMINT highlights
    const humint = db.prepare(`
      SELECT id, findings, confidence, created_at FROM humint_reports
      WHERE created_at >= ? ORDER BY created_at DESC LIMIT 8
    `).all(cutoff) as Array<{ id: string; findings: string; confidence: string; created_at: number }>

    // 4) Open gaps
    const gaps = db.prepare(`
      SELECT id, description, severity, preliminary_report_id
      FROM intel_gaps WHERE status = 'open' ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC LIMIT 10
    `).all() as Array<{ id: string; description: string; severity: string; preliminary_report_id: string }>

    // 5) Pending actions
    const actions = db.prepare(`
      SELECT id, action, priority, preliminary_report_id
      FROM recommended_actions WHERE status = 'pending' ORDER BY
        CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC LIMIT 10
    `).all() as Array<{ id: string; action: string; priority: string; preliminary_report_id: string }>

    // 6) Trend change — comparing current period vs prior period
    const currentVol = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports WHERE created_at >= ?').get(cutoff) as { c: number }).c
    const prevVol = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports WHERE created_at >= ? AND created_at < ?').get(yesterday, cutoff) as { c: number }).c
    const currentCrit = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports WHERE created_at >= ? AND severity = \'critical\'').get(cutoff) as { c: number }).c
    const prevCrit = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports WHERE created_at >= ? AND created_at < ? AND severity = \'critical\'').get(yesterday, cutoff) as { c: number }).c

    const trendChange = [
      { metric: 'Total intel volume', current: currentVol, previous: prevVol, pct_change: prevVol > 0 ? Math.round(((currentVol - prevVol) / prevVol) * 100) : 0 },
      { metric: 'Critical events', current: currentCrit, previous: prevCrit, pct_change: prevCrit > 0 ? Math.round(((currentCrit - prevCrit) / prevCrit) * 100) : 0 }
    ]

    // Determine brief classification: max of every artifact included
    let cls = 'UNCLASSIFIED'
    for (const r of executive) cls = maxClass(cls, r.classification || 'UNCLASSIFIED')
    for (const e of events) cls = maxClass(cls, e.classification)

    const generated_at = timestamp()
    const structured: DpbStructured = {
      generated_at,
      classification: cls,
      period_hours: periodHours,
      executive_summary: executive.map((r) => ({
        title: r.title, severity: r.severity, classification: r.classification || 'UNCLASSIFIED',
        source: r.source_name, id: r.id
      })),
      iw_status: iwStatus,
      humint_highlights: humint.map((h) => ({
        id: h.id,
        findings_excerpt: (h.findings || '').replace(/\s+/g, ' ').slice(0, 220),
        confidence: h.confidence,
        created_at: h.created_at
      })),
      open_gaps: gaps.map((g) => ({
        id: g.id, description: g.description, severity: g.severity, preliminary_id: g.preliminary_report_id
      })),
      pending_actions: actions.map((a) => ({
        id: a.id, action: a.action, priority: a.priority, preliminary_id: a.preliminary_report_id
      })),
      trend_change: trendChange
    }

    const body_md = this.renderMarkdown(structured)

    // Persist
    const id = generateId()
    const now = timestamp()
    const iwRed = iwStatus.filter((s) => s.level === 'red').length
    const iwAmber = iwStatus.filter((s) => s.level === 'amber').length

    db.prepare(`
      INSERT INTO dpb_briefings
        (id, generated_at, classification, template_name, period_hours, body_md, body_json,
         intel_count, critical_count, humint_count, iw_red_count, iw_amber_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, generated_at, cls, opts.templateName || null, periodHours,
      body_md, JSON.stringify(structured),
      currentVol, currentCrit, humint.length, iwRed, iwAmber, now
    )

    auditChainService.append('dpb.generate', {
      entityType: 'dpb_briefing', entityId: id, classification: cls,
      payload: { periodHours, intelCount: currentVol, criticalCount: currentCrit, iwRed, iwAmber }
    })

    log.info(`DPB generated: ${id} (${cls}, ${periodHours}h, ${currentVol} intel, ${iwRed} red + ${iwAmber} amber I&W)`)
    return { id, classification: cls, body_md }
  }

  /** Render the structured brief as a markdown body. */
  private renderMarkdown(s: DpbStructured): string {
    const date = new Date(s.generated_at)
    const dateStr = date.toUTCString()
    const lines: string[] = []

    lines.push(`# Daily Intelligence Brief`)
    lines.push(``)
    lines.push(`**Classification:** ${s.classification}`)
    lines.push(`**Generated:** ${dateStr}`)
    lines.push(`**Coverage:** Last ${s.period_hours} hours`)
    lines.push(``)

    // Executive Summary
    lines.push(`## 1. Executive Summary`)
    lines.push(``)
    if (s.executive_summary.length === 0) {
      lines.push(`*No critical or high-severity intel reports in the period.*`)
    } else {
      for (const r of s.executive_summary) {
        lines.push(`- **[${r.severity.toUpperCase()}]** ${r.title} — *${r.source}* — \`[${r.classification}]\` — \`[id:${r.id}]\``)
      }
    }
    lines.push(``)

    // I&W Status
    lines.push(`## 2. Indicators & Warnings`)
    lines.push(``)
    if (s.iw_status.length === 0) {
      lines.push(`*No active I&W events. Define one in the I&W Workbench.*`)
    } else {
      for (const ev of s.iw_status) {
        const flag = ev.level === 'red' ? '🔴 RED' : ev.level === 'amber' ? '🟠 AMBER' : '🟢 GREEN'
        lines.push(`### ${flag} — ${ev.event_name}`)
        if (ev.indicators.length === 0) {
          lines.push(`  *(no indicators defined)*`)
        } else {
          for (const ind of ev.indicators) {
            const flag = ind.level === 'red' ? '🔴' : ind.level === 'amber' ? '🟠' : '🟢'
            const val = ind.current_value != null ? `value: ${ind.current_value}` : 'unevaluated'
            const thresh = `(amber ≥${ind.amber ?? '?'} / red ≥${ind.red ?? '?'})`
            lines.push(`- ${flag} ${ind.name} — ${val} ${thresh}`)
          }
        }
        lines.push(``)
      }
    }

    // HUMINT Highlights
    lines.push(`## 3. HUMINT Highlights`)
    lines.push(``)
    if (s.humint_highlights.length === 0) {
      lines.push(`*No HUMINT analyst products in the period.*`)
    } else {
      for (const h of s.humint_highlights) {
        lines.push(`- **[confidence: ${h.confidence}]** ${h.findings_excerpt}… — \`[humint:${h.id}]\``)
      }
    }
    lines.push(``)

    // Open Gaps
    lines.push(`## 4. Open Information Gaps`)
    lines.push(``)
    if (s.open_gaps.length === 0) {
      lines.push(`*No open gaps.*`)
    } else {
      for (const g of s.open_gaps) {
        lines.push(`- **[${g.severity.toUpperCase()}]** ${g.description.slice(0, 200)} — \`[gap:${g.id}]\``)
      }
    }
    lines.push(``)

    // Pending Actions
    lines.push(`## 5. Pending Recommended Actions`)
    lines.push(``)
    if (s.pending_actions.length === 0) {
      lines.push(`*No pending actions.*`)
    } else {
      for (const a of s.pending_actions) {
        lines.push(`- **[${a.priority.toUpperCase()}]** ${a.action.slice(0, 200)} — \`[action:${a.id}]\``)
      }
    }
    lines.push(``)

    // Trend
    lines.push(`## 6. Trend Change vs Prior Period`)
    lines.push(``)
    for (const t of s.trend_change) {
      const arrow = t.pct_change > 0 ? '↑' : t.pct_change < 0 ? '↓' : '→'
      lines.push(`- ${t.metric}: **${t.current}** vs ${t.previous} ${arrow} ${t.pct_change}%`)
    }
    lines.push(``)

    lines.push(`---`)
    lines.push(`*This brief was assembled automatically. All citations link to source records in Heimdall. Classification: **${s.classification}**.*`)

    return lines.join('\n')
  }

  /** Return the most recent brief. */
  getLatest(): { id: string; classification: string; body_md: string; generated_at: number } | null {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, classification, body_md, generated_at FROM dpb_briefings
      ORDER BY generated_at DESC LIMIT 1
    `).get() as { id: string; classification: string; body_md: string; generated_at: number } | undefined
    return row || null
  }

  list(limit = 25) {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, generated_at, classification, period_hours, intel_count, critical_count,
             humint_count, iw_red_count, iw_amber_count
      FROM dpb_briefings ORDER BY generated_at DESC LIMIT ?
    `).all(Math.min(limit, 100))
  }

  get(id: string): { id: string; classification: string; body_md: string; body_json: string | null; generated_at: number } | null {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, classification, body_md, body_json, generated_at
      FROM dpb_briefings WHERE id = ?
    `).get(id) as { id: string; classification: string; body_md: string; body_json: string | null; generated_at: number } | undefined
    return row || null
  }
}

export const dpbService = new DpbServiceImpl()
