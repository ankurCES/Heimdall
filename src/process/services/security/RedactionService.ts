import nlp from 'compromise'
import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 10.9 — US-persons / EEA-persons handling.
 *
 * Scans text for personally identifiable information (PII) that
 * intelligence analysts are required to redact under Executive Order
 * 12333 (US persons) and GDPR (EEA persons). Detection is heuristic:
 *
 *   - Person names via compromise.js NLP (#Person tag extraction)
 *   - SSN via regex (XXX-XX-XXXX)
 *   - US phone numbers via regex (various formats)
 *   - Email addresses via regex
 *   - US street addresses via regex (number + street + state + zip)
 *
 * Two modes:
 *   flag  — record the hit in redaction_events with status='pending',
 *           do NOT modify the original text. Analyst reviews.
 *   auto  — immediately replace matches with [REDACTED-KIND] tokens
 *           in the source text. Original snippets are stored in
 *           redaction_events until the event is purged.
 *
 * Neither mode is legally sufficient for real EO 12333 compliance
 * (that requires a trained minimization officer). This is a tool to
 * surface potential PII, not a compliance gate.
 */

export interface RedactionHit {
  kind: 'person_name' | 'ssn' | 'phone' | 'email' | 'address'
  value: string
  offset_start: number
  offset_end: number
}

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g
const PHONE_RE = /\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Z|a-z]{2,}\b/g
const ADDRESS_RE = /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Pkwy|Cir)\b\.?(?:\s*,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/g

export class RedactionService {
  scan(text: string): RedactionHit[] {
    if (!text || text.length < 3) return []
    const hits: RedactionHit[] = []

    // Person names via compromise NLP
    try {
      const doc = nlp(text)
      const people = doc.people().json() as Array<{ offset: { start: number; length: number }; text: string }>
      for (const p of people) {
        if (!p.text || p.text.length < 3) continue
        // Skip common false positives (country names, org names used as person names)
        if (/^(United|North|South|East|West|New|The|Mr|Mrs|Ms|Dr)\b/.test(p.text) && p.text.split(/\s+/).length <= 1) continue
        hits.push({
          kind: 'person_name',
          value: p.text,
          offset_start: p.offset?.start ?? text.indexOf(p.text),
          offset_end: (p.offset?.start ?? text.indexOf(p.text)) + p.text.length
        })
      }
    } catch (err) {
      log.debug(`redaction: NLP person extraction failed: ${(err as Error).message}`)
    }

    // Regex patterns
    const regexScan = (re: RegExp, kind: RedactionHit['kind']) => {
      let m: RegExpExecArray | null
      const r = new RegExp(re.source, re.flags) // fresh instance
      while ((m = r.exec(text)) !== null) {
        hits.push({ kind, value: m[0], offset_start: m.index, offset_end: m.index + m[0].length })
      }
    }
    regexScan(SSN_RE, 'ssn')
    regexScan(PHONE_RE, 'phone')
    regexScan(EMAIL_RE, 'email')
    regexScan(ADDRESS_RE, 'address')

    // Deduplicate overlapping hits — keep the more specific kind
    const priority: Record<RedactionHit['kind'], number> = { ssn: 5, email: 4, phone: 3, address: 2, person_name: 1 }
    hits.sort((a, b) => priority[b.kind] - priority[a.kind])
    const used = new Set<number>()
    const deduped: RedactionHit[] = []
    for (const h of hits) {
      const positions = Array.from({ length: h.offset_end - h.offset_start }, (_, i) => h.offset_start + i)
      if (positions.some((p) => used.has(p))) continue
      for (const p of positions) used.add(p)
      deduped.push(h)
    }
    return deduped.sort((a, b) => a.offset_start - b.offset_start)
  }

  /** Apply [REDACTED-KIND] tokens to the text. Returns the redacted text. */
  redact(text: string, hits: RedactionHit[]): string {
    if (!hits.length) return text
    const sorted = [...hits].sort((a, b) => b.offset_start - a.offset_start) // reverse to preserve offsets
    let result = text
    for (const h of sorted) {
      const token = `[REDACTED-${h.kind.toUpperCase()}]`
      result = result.slice(0, h.offset_start) + token + result.slice(h.offset_end)
    }
    return result
  }

  /** Scan a report and record hits in redaction_events. */
  flagReport(reportId: string): { hits: number } {
    const db = getDatabase()
    const row = db.prepare('SELECT content FROM intel_reports WHERE id = ?').get(reportId) as { content: string } | undefined
    if (!row) return { hits: 0 }
    const hits = this.scan(row.content || '')
    if (hits.length === 0) return { hits: 0 }
    const now = Date.now()
    const ins = db.prepare(`
      INSERT OR IGNORE INTO redaction_events
        (id, report_id, kind, original_snippet, offset_start, offset_end, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `)
    const tx = db.transaction(() => {
      for (const h of hits) {
        ins.run(generateId(), reportId, h.kind, h.value, h.offset_start, h.offset_end, now)
      }
    })
    tx()
    return { hits: hits.length }
  }

  /** Auto-redact a report: replace PII in content + mark events as redacted. */
  applyRedaction(reportId: string): { redacted_count: number } {
    const db = getDatabase()
    const row = db.prepare('SELECT content FROM intel_reports WHERE id = ?').get(reportId) as { content: string } | undefined
    if (!row) return { redacted_count: 0 }
    const hits = this.scan(row.content || '')
    if (hits.length === 0) return { redacted_count: 0 }
    const redacted = this.redact(row.content, hits)
    const now = Date.now()
    const tx = db.transaction(() => {
      db.prepare('UPDATE intel_reports SET content = ?, updated_at = ? WHERE id = ?').run(redacted, now, reportId)
      // Mark all pending events for this report as redacted; null out the original snippet for data minimization.
      db.prepare(`
        UPDATE redaction_events SET status = 'redacted', analyst_decision = 'auto', original_snippet = NULL, resolved_at = ? WHERE report_id = ? AND status = 'pending'
      `).run(now, reportId)
      // Insert any new hits not already in the table
      const ins = db.prepare(`
        INSERT OR IGNORE INTO redaction_events
          (id, report_id, kind, original_snippet, offset_start, offset_end, status, analyst_decision, created_at, resolved_at)
        VALUES (?, ?, ?, NULL, ?, ?, 'redacted', 'auto', ?, ?)
      `)
      for (const h of hits) ins.run(generateId(), reportId, h.kind, h.offset_start, h.offset_end, now, now)
    })
    tx()
    try {
      auditChainService.append('redaction.applied', {
        entityType: 'intel_report', entityId: reportId,
        payload: { hits: hits.length, kinds: [...new Set(hits.map((h) => h.kind))] }
      })
    } catch { /* noop */ }
    return { redacted_count: hits.length }
  }

  dismiss(eventId: string): void {
    const db = getDatabase()
    db.prepare(`
      UPDATE redaction_events SET status = 'dismissed', analyst_decision = 'false_positive', resolved_at = ? WHERE id = ?
    `).run(Date.now(), eventId)
  }

  pending(limit = 100): Array<{
    id: string; report_id: string; kind: string; original_snippet: string | null;
    offset_start: number; offset_end: number; status: string; created_at: number
  }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, report_id, kind, original_snippet, offset_start, offset_end, status, created_at
      FROM redaction_events WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{
      id: string; report_id: string; kind: string; original_snippet: string | null;
      offset_start: number; offset_end: number; status: string; created_at: number
    }>
  }

  /** Batch scan all reports (or only those with no existing events). */
  scanCorpus(rescoreAll = false): { reports_scanned: number; reports_flagged: number; total_hits: number } {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT r.id, r.content FROM intel_reports r
      ${rescoreAll ? '' : 'WHERE NOT EXISTS (SELECT 1 FROM redaction_events e WHERE e.report_id = r.id)'}
    `).all() as Array<{ id: string; content: string }>
    let flagged = 0, totalHits = 0
    for (const r of rows) {
      const { hits } = this.flagReport(r.id)
      if (hits > 0) { flagged++; totalHits += hits }
    }
    log.info(`redaction: corpus scan — ${rows.length} reports, ${flagged} flagged, ${totalHits} hits`)
    return { reports_scanned: rows.length, reports_flagged: flagged, total_hits: totalHits }
  }
}

export const redactionService = new RedactionService()
