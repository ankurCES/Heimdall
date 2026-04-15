import log from 'electron-log'
import { getDatabase } from '../database'

/**
 * Cross-cutting F — Adversarial input hardening.
 *
 * Screens collected intel content for prompt-injection patterns before
 * that content is ever included in an LLM context window. This is the
 * adversarial-input layer specifically called out in the agency roadmap:
 * the open web is full of LLM-targeted poisoning, and our agent loop
 * reads user-supplied intel daily.
 *
 * Approach is deliberately conservative regex-based detection + heuristic
 * scoring. Three severities:
 *   low    — annotate: keep the row, tag it with the rules that fired.
 *            Analyst workflows see the tag but content still flows through.
 *   med    — annotate + warn: displayed with a banner in the detail view.
 *   high   — quarantine: intel_reports.quarantined=1 so the agent's
 *            tool loop filters it out by default. Analysts can release
 *            individual items via the Quarantine UI.
 *
 * Runs on demand (batch) and — wired by the caller — on every new intel
 * row at ingest time. Pattern list intentionally conservative; deployers
 * can add their own via direct SQL edit once the mechanism is in place.
 */

export type InjectionSeverity = 'low' | 'med' | 'high'
export type InjectionAction = 'annotate' | 'quarantine'

export interface InjectionRule {
  id: string
  name: string
  severity: InjectionSeverity
  pattern: RegExp
  hint: string
}

export interface InjectionFlag {
  report_id: string
  severity: InjectionSeverity
  action: InjectionAction
  matched_rules: string[]
  flagged_at: number
  released_at: number | null
}

const RULES: InjectionRule[] = [
  // Classic "ignore previous" style — the single most common injection.
  { id: 'ignore-previous', name: 'Ignore-previous', severity: 'high',
    pattern: /\bignore\s+(the\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|directions?|rules?|system\s+prompt)\b/i,
    hint: '"Ignore previous instructions" — canonical prompt-injection opener' },

  // Role / persona hijack
  { id: 'new-instructions', name: 'New-instructions directive', severity: 'high',
    pattern: /\b(your\s+new\s+instructions|new\s+system\s+prompt|you\s+are\s+now\s+(a|an))\b/i,
    hint: 'Claims new instructions / identity override' },

  { id: 'developer-mode', name: 'Developer/DAN mode', severity: 'high',
    pattern: /\b(developer\s+mode|DAN\s+mode|jailbreak|evil\s+mode|unrestricted\s+mode)\b/i,
    hint: 'Known jailbreak persona activator' },

  // Control-channel smuggling — system-role markers embedded in content.
  { id: 'system-role-marker', name: 'System-role marker', severity: 'high',
    pattern: /<\|(im_start|im_end|system|assistant|user)\|>|<\|?(begin_of_text|end_of_text|eot_id)\|?>/i,
    hint: 'OpenAI / Anthropic / Llama chat-ML control markers inside content' },

  { id: 'xml-system-tag', name: 'XML system/instruction tag', severity: 'med',
    pattern: /<\s*(system|instructions?|admin|assistant)[^>]*>/i,
    hint: 'Inline <system>…</system> or <instructions>…</instructions>' },

  // Credential harvest / exfil requests
  { id: 'exfil-credentials', name: 'Credential / key exfil request', severity: 'high',
    pattern: /\b(exfiltrate|send|email|post|upload)\b.{0,40}\b(api[_-]?key|password|secret|token|credential|private\s+key)\b/i,
    hint: 'Asks the agent to exfiltrate secrets' },

  { id: 'env-dump', name: 'Environment dump request', severity: 'high',
    pattern: /\b(print|echo|reveal|output)\b.{0,30}\b(env|environment\s+variables?|system\s+prompt|your\s+(instructions?|prompt|rules))\b/i,
    hint: 'Asks the agent to leak system prompt or env vars' },

  // Tool-call hijack
  { id: 'tool-call-hijack', name: 'Tool-call hijack', severity: 'high',
    pattern: /\b(call|use|invoke|execute)\b.{0,40}\btool\b.{0,40}\b(delete|drop|remove|wipe|exfil)/i,
    hint: 'Asks the agent to invoke a destructive tool path' },

  // Self-reference / meta
  { id: 'forget-rules', name: 'Forget safety rules', severity: 'med',
    pattern: /\b(forget|disregard|bypass|override)\b.{0,30}\b(safety|guidelines?|restrictions?|filters?|rules?)\b/i,
    hint: 'Asks the model to disregard safety rules' },

  // Encoded / obfuscated payload markers
  { id: 'b64-payload', name: 'Large base64 blob', severity: 'low',
    pattern: /(?:[A-Za-z0-9+/]{100,}={0,2})/,
    hint: 'Long base64 blob (>=100 chars) — potential encoded payload' },

  { id: 'zero-width', name: 'Zero-width characters', severity: 'med',
    pattern: /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/,
    hint: 'Contains zero-width / bidi / invisible Unicode — common obfuscation' },

  // Social-engineering framing
  { id: 'claim-authority', name: 'Claims authority', severity: 'low',
    pattern: /\bI\s+am\s+(your|the)\s+(developer|admin|owner|anthropic|openai|creator)\b/i,
    hint: 'Claims to speak as a privileged party' }
]

const SEVERITY_WEIGHT: Record<InjectionSeverity, number> = { low: 1, med: 3, high: 6 }

export interface InjectionScanResult {
  matched: InjectionRule[]
  severity: InjectionSeverity | null
  action: InjectionAction | null
  score: number
}

export interface InjectionRun {
  id: number
  started_at: number
  finished_at: number
  reports_scanned: number
  reports_flagged: number
  duration_ms: number
}

export class InjectionScreener {
  readonly rules = RULES

  /** Pure function — screen a single piece of text. Used by the batch path AND any on-ingest hook. */
  scan(text: string): InjectionScanResult {
    const matched: InjectionRule[] = []
    for (const rule of RULES) {
      if (rule.pattern.test(text)) matched.push(rule)
    }
    if (matched.length === 0) return { matched: [], severity: null, action: null, score: 0 }
    const score = matched.reduce((s, r) => s + SEVERITY_WEIGHT[r.severity], 0)
    // Derive top severity + action:
    //   any 'high' → quarantine, 'high'
    //   else any 'med' → annotate, 'med'
    //   else annotate, 'low'
    let severity: InjectionSeverity = 'low'
    if (matched.some((r) => r.severity === 'high')) severity = 'high'
    else if (matched.some((r) => r.severity === 'med')) severity = 'med'
    const action: InjectionAction = severity === 'high' ? 'quarantine' : 'annotate'
    return { matched, severity, action, score }
  }

  /** Screen a single report by id. Applies flag + quarantined=1 transactionally. */
  screenReport(reportId: string): InjectionScanResult {
    const db = getDatabase()
    const row = db.prepare('SELECT content FROM intel_reports WHERE id = ?').get(reportId) as { content: string } | undefined
    if (!row) return { matched: [], severity: null, action: null, score: 0 }
    const result = this.scan(row.content || '')
    this.persist(reportId, result)
    return result
  }

  /**
   * Screen the whole corpus. Scans everything in intel_reports, persists
   * flags for every match, and sets quarantined=1 on high-severity rows.
   * Unsets quarantined on rows that have since been cleared.
   */
  screenCorpus(): InjectionRun {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare('INSERT INTO injection_runs (started_at) VALUES (?)').run(started).lastInsertRowid)

    try {
      const rows = db.prepare(
        'SELECT id, content FROM intel_reports WHERE content IS NOT NULL AND length(content) > 0'
      ).all() as Array<{ id: string; content: string }>

      let flagged = 0
      const tx = db.transaction(() => {
        // Clear previous flags — this is a full rescreen.
        db.prepare('DELETE FROM injection_flags').run()
        db.prepare('UPDATE intel_reports SET quarantined = 0 WHERE quarantined = 1').run()

        for (const r of rows) {
          const result = this.scan(r.content)
          if (result.matched.length === 0) continue
          this.persist(r.id, result, /* inTx */ true)
          flagged++
        }
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE injection_runs SET finished_at=?, reports_scanned=?, reports_flagged=?, duration_ms=? WHERE id=?'
      ).run(finished, rows.length, flagged, finished - started, runId)

      log.info(`injection-screener: scanned ${rows.length} reports, flagged ${flagged}, ${finished - started}ms`)
      return { id: runId, started_at: started, finished_at: finished,
        reports_scanned: rows.length, reports_flagged: flagged, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE injection_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  private persist(reportId: string, result: InjectionScanResult, inTx = false): void {
    const db = getDatabase()
    const now = Date.now()
    const apply = () => {
      if (result.matched.length === 0) return
      db.prepare(`
        INSERT INTO injection_flags (report_id, severity, action, matched_rules, flagged_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(report_id) DO UPDATE SET
          severity = excluded.severity,
          action = excluded.action,
          matched_rules = excluded.matched_rules,
          flagged_at = excluded.flagged_at,
          released_at = NULL, released_by = NULL
      `).run(reportId, result.severity, result.action, JSON.stringify(result.matched.map((r) => r.id)), now)
      if (result.action === 'quarantine') {
        db.prepare('UPDATE intel_reports SET quarantined = 1 WHERE id = ?').run(reportId)
      }
    }
    if (inTx) apply()
    else {
      const tx = db.transaction(apply)
      tx()
    }
  }

  /** Release a quarantined report — keeps the flag row for audit. */
  release(reportId: string, releasedBy = 'analyst'): void {
    const db = getDatabase()
    const now = Date.now()
    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE injection_flags SET released_at=?, released_by=? WHERE report_id=?'
      ).run(now, releasedBy, reportId)
      db.prepare('UPDATE intel_reports SET quarantined = 0 WHERE id = ?').run(reportId)
    })
    tx()
  }

  listQuarantined(limit = 100): Array<{
    report_id: string; title: string; source_name: string; discipline: string;
    severity: InjectionSeverity; matched_rules: string[]; created_at: number; flagged_at: number
  }> {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT i.report_id, r.title, r.source_name, r.discipline, i.severity,
             i.matched_rules, r.created_at, i.flagged_at
      FROM injection_flags i
      JOIN intel_reports r ON r.id = i.report_id
      WHERE i.action = 'quarantine' AND i.released_at IS NULL
      ORDER BY i.flagged_at DESC LIMIT ?
    `).all(limit) as Array<{ report_id: string; title: string; source_name: string; discipline: string; severity: InjectionSeverity; matched_rules: string; created_at: number; flagged_at: number }>
    return rows.map((r) => ({ ...r, matched_rules: safeJson(r.matched_rules) }))
  }

  listFlagged(limit = 100): Array<{
    report_id: string; title: string; source_name: string; discipline: string;
    severity: InjectionSeverity; action: InjectionAction; matched_rules: string[];
    created_at: number; flagged_at: number; released_at: number | null
  }> {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT i.report_id, r.title, r.source_name, r.discipline, i.severity, i.action,
             i.matched_rules, r.created_at, i.flagged_at, i.released_at
      FROM injection_flags i
      JOIN intel_reports r ON r.id = i.report_id
      ORDER BY CASE i.severity WHEN 'high' THEN 3 WHEN 'med' THEN 2 ELSE 1 END DESC, i.flagged_at DESC
      LIMIT ?
    `).all(limit) as Array<{ report_id: string; title: string; source_name: string; discipline: string; severity: InjectionSeverity; action: InjectionAction; matched_rules: string; created_at: number; flagged_at: number; released_at: number | null }>
    return rows.map((r) => ({ ...r, matched_rules: safeJson(r.matched_rules) }))
  }

  latestRun(): InjectionRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, reports_scanned, reports_flagged, duration_ms
      FROM injection_runs WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as InjectionRun) || null
  }

  listRules(): Array<{ id: string; name: string; severity: InjectionSeverity; hint: string }> {
    return this.rules.map((r) => ({ id: r.id, name: r.name, severity: r.severity, hint: r.hint }))
  }
}

function safeJson(s: string): string[] {
  try { return JSON.parse(s) as string[] } catch { return [] }
}

export const injectionScreener = new InjectionScreener()
