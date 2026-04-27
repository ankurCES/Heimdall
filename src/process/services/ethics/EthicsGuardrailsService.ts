// EthicsGuardrailsService — runs all ethical-safety checks on a generated
// report and persists the resulting flags. Flags are categorized by type
// and severity:
//
//   info    — disclosed in report footer / library badge, no action required
//   warning — visible in EthicsConsole, analyst should review before publish
//   block   — *would* prevent publication (full enforcement deferred to v1.2
//             when RBAC ships; for now we record + visually mark)
//
// Cross-cutting principle: built into the platform, not the prompt. The
// underlying LLM might violate guidelines; this layer catches it before
// the output reaches a consumer.
//
// Eight safety domains in v1.1:
//   1. Targeted violence — names individual + proposes harm
//   2. Civilian/combatant ambiguity — tagged person of unclear status
//   3. CSAM — child sexual abuse material patterns
//   4. Human-rights screen — keyword match against known abusive playbooks
//   5. Bias surface — single-source / no local-language reporting / etc.
//   6. PII leakage — non-public personal data appears in unclassified output
//   7. Disinformation amplification — content sourced from known-fabricator
//      origin without caveat
//   8. Disclaimer footer — every published report carries the "AI-assisted,
//      human review required" footer (always passes; informational)

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'
import type { ReportProduct } from '../report/ReportLibraryService'

export type EthicsFlagType =
  | 'targeted_violence'
  | 'civilian_combatant'
  | 'csam'
  | 'humanrights'
  | 'bias'
  | 'pii_leak'
  | 'disinfo'
  | 'disclaimer'

export type EthicsSeverity = 'info' | 'warning' | 'block'

export interface EthicsFlag {
  id: string
  subjectType: 'report' | 'intel' | 'indicator'
  subjectId: string
  flagType: EthicsFlagType
  severity: EthicsSeverity
  evidence: string | null
  resolution: string | null
  reviewedBy: string | null
  createdAt: number
  reviewedAt: number | null
}

export interface EthicsScreenResult {
  flags: EthicsFlag[]
  blockingCount: number
  warningCount: number
  infoCount: number
}

// ─────────────────────────────────────────────────────────────────────────
// Pattern definitions
// ─────────────────────────────────────────────────────────────────────────

const TARGETED_VIOLENCE_PATTERNS = [
  /\b(?:assassinate|kill|eliminate|neutralize|terminate)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/g,
  /\b(?:strike|target|attack)\s+(?:against\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:should|must|recommended)/gi,
  /\brecommend(?:ed)?\s+(?:the\s+)?(?:elimination|removal)\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/gi
]

// CSAM screening uses a deny-list of unambiguous indicators. We deliberately
// keep this list narrow + not comprehensive — false positives are preferable
// to false negatives in this domain. Real deployments should pair this with
// PhotoDNA or similar specialized services.
const CSAM_PATTERNS = [
  /\bchild\s+(?:sexual\s+)?(?:abuse|exploitation)\s+material\b/i,
  /\bcsam\b/i,
  /\bunderage\s+(?:porn|pornography|nudity|sexual)\b/i,
  /\bminor\s+(?:porn|pornography|sexual\s+content)\b/i
]

// Human-rights screen — patterns that suggest output is enabling abuse
const HUMAN_RIGHTS_PATTERNS = [
  /\bsuppress(?:ing|ion)\s+(?:protest|demonstration|dissent|opposition)/i,
  /\bsurveillance\s+of\s+(?:journalists?|activists?|dissidents?|minorities)/i,
  /\bidentif(?:y|ying)\s+(?:LGBT|gay|lesbian|trans(?:gender)?)\s+individuals?/i,
  /\bpolitical\s+(?:dissident|prisoner)\s+(?:list|database|registry)/i,
  /\bethnic\s+(?:cleansing|targeting|profiling)/i
]

// PII patterns — non-public personally identifying information
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,                                    // SSN
  /\b\d{16}\b/,                                                // CC number
  /\b(?:passport|driver['s]*\s+license)\s*(?:no|number|#)?\s*[:#]?\s*[A-Z0-9]{6,12}\b/i,
  /\bDOB\s*[:#]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i
]

// Civilian/combatant — names of persons in violent contexts
const PERSON_IN_VIOLENT_CONTEXT = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b[^.]{0,200}\b(?:armed|combatant|militant|insurgent|terrorist|fighter|civilian|noncombatant|innocent)/gi

// Disinformation indicators — known-fabricator / state-prop origins
const DISINFO_SOURCE_HINTS = [
  /\bRT(?:\s+News)?\b/, /\bSputnik\s+(?:News|International)\b/,
  /\bGlobal\s+Times\b/, /\bPress\s+TV\b/, /\bTASS\b/
]

// ─────────────────────────────────────────────────────────────────────────

export class EthicsGuardrailsService {
  /**
   * Run ALL checks against a report and persist any flags raised.
   * Returns an aggregate result so the caller can decide whether to
   * proceed (in v1.1: always proceeds; in v1.2 with RBAC, blocks).
   */
  async screenReport(report: ReportProduct): Promise<EthicsScreenResult> {
    const allFlags: EthicsFlag[] = []
    const text = report.bodyMarkdown
    const subjectType = 'report' as const
    const subjectId = report.id

    // 1. Targeted violence
    for (const pat of TARGETED_VIOLENCE_PATTERNS) {
      const matches = [...text.matchAll(pat)]
      for (const m of matches.slice(0, 3)) {
        allFlags.push(this.buildFlag(subjectType, subjectId, 'targeted_violence', 'block',
          `Match: "${m[0].slice(0, 100)}"`))
      }
    }

    // 2. Civilian/combatant ambiguity (informational)
    const civCom = [...text.matchAll(PERSON_IN_VIOLENT_CONTEXT)].slice(0, 3)
    if (civCom.length > 0) {
      const evidence = civCom.map((m) => m[1]).join(', ')
      allFlags.push(this.buildFlag(subjectType, subjectId, 'civilian_combatant', 'warning',
        `Persons in violent context: ${evidence}`))
    }

    // 3. CSAM
    for (const pat of CSAM_PATTERNS) {
      if (pat.test(text)) {
        allFlags.push(this.buildFlag(subjectType, subjectId, 'csam', 'block',
          'Content contains CSAM-related terminology — manual review required'))
        break
      }
    }

    // 4. Human-rights
    for (const pat of HUMAN_RIGHTS_PATTERNS) {
      const m = text.match(pat)
      if (m) {
        allFlags.push(this.buildFlag(subjectType, subjectId, 'humanrights', 'warning',
          `Human-rights pattern: "${m[0].slice(0, 100)}"`))
      }
    }

    // 5. PII leakage
    for (const pat of PII_PATTERNS) {
      const m = text.match(pat)
      if (m) {
        allFlags.push(this.buildFlag(subjectType, subjectId, 'pii_leak', 'warning',
          `Possible PII: "${m[0].slice(0, 40)}…"`))
      }
    }

    // 6. Disinformation amplification
    const disinfoMatches: string[] = []
    for (const pat of DISINFO_SOURCE_HINTS) {
      const m = text.match(pat)
      if (m) disinfoMatches.push(m[0])
    }
    if (disinfoMatches.length > 0) {
      // Check if there's already a caveat near the citation
      const hasCaveat = /\b(?:state[- ]controlled|propaganda|known fabricator|low-confidence source|disinformation)/i.test(text)
      if (!hasCaveat) {
        allFlags.push(this.buildFlag(subjectType, subjectId, 'disinfo', 'warning',
          `Cited known-propaganda source(s) without caveat: ${disinfoMatches.join(', ')}`))
      } else {
        allFlags.push(this.buildFlag(subjectType, subjectId, 'disinfo', 'info',
          `Cited propaganda source(s) WITH caveat: ${disinfoMatches.join(', ')}`))
      }
    }

    // 7. Bias surfacing — based on tags + finding mix (informational)
    const biasResult = this.surfaceBias(report)
    if (biasResult) {
      allFlags.push(this.buildFlag(subjectType, subjectId, 'bias', 'info', biasResult))
    }

    // 8. Disclaimer footer — always present
    allFlags.push(this.buildFlag(subjectType, subjectId, 'disclaimer', 'info',
      'AI-assisted product; human analyst review required before policy use.'))

    // Persist
    this.persistFlags(allFlags)

    return {
      flags: allFlags,
      blockingCount: allFlags.filter((f) => f.severity === 'block').length,
      warningCount: allFlags.filter((f) => f.severity === 'warning').length,
      infoCount: allFlags.filter((f) => f.severity === 'info').length
    }
  }

  /** Light-touch bias check — tag mix + Western-source bias. */
  private surfaceBias(report: ReportProduct): string | null {
    const text = report.bodyMarkdown.toLowerCase()
    // Count source-language hints
    const englishOnly = /\[osint:.*?(?:reuters|bbc|cnn|nyt|washington post|guardian|associated press|ap)\b/gi
    const englishCount = (text.match(englishOnly) || []).length
    const allSources = (text.match(/\[(?:osint|humint|cybint|imint|sigint|darkweb):/gi) || []).length
    if (allSources >= 5 && englishCount / allSources >= 0.7) {
      return `${Math.round(100 * englishCount / allSources)}% Western-English OSINT — consider local-language reporting for balance`
    }
    return null
  }

  // ── Persistence + queries ────────────────────────────────────────────

  private buildFlag(
    subjectType: 'report' | 'intel' | 'indicator',
    subjectId: string,
    flagType: EthicsFlagType,
    severity: EthicsSeverity,
    evidence: string
  ): EthicsFlag {
    return {
      id: generateId(),
      subjectType, subjectId, flagType, severity,
      evidence: evidence.slice(0, 1000),
      resolution: null, reviewedBy: null,
      createdAt: Date.now(), reviewedAt: null
    }
  }

  private persistFlags(flags: EthicsFlag[]): void {
    if (flags.length === 0) return
    const db = getDatabase()
    // FUNCTIONAL FIX (v1.3.2 — finding C4): on re-screen, drop existing
    // unresolved flags for this subject before inserting new ones, so
    // re-publish doesn't pile up duplicates. Resolved flags (analyst
    // already overrode/dismissed) are preserved as historical record.
    const subjectsTouched = new Map<string, Set<string>>()  // type → set of ids
    for (const f of flags) {
      if (!subjectsTouched.has(f.subjectType)) subjectsTouched.set(f.subjectType, new Set())
      subjectsTouched.get(f.subjectType)!.add(f.subjectId)
    }
    const dropStmt = db.prepare(
      `DELETE FROM ethics_flags WHERE subject_type = ? AND subject_id = ? AND resolution IS NULL`
    )
    const stmt = db.prepare(`
      INSERT INTO ethics_flags
        (id, subject_type, subject_id, flag_type, severity, evidence,
         resolution, resolution_notes, reviewed_by, created_at, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)
    `)
    const tx = db.transaction(() => {
      for (const [stype, ids] of subjectsTouched) {
        for (const id of ids) dropStmt.run(stype, id)
      }
      for (const f of flags) {
        try {
          stmt.run(f.id, f.subjectType, f.subjectId, f.flagType, f.severity, f.evidence, f.createdAt)
        } catch (err) { log.debug(`ethics flag insert failed: ${err}`) }
      }
    })
    tx()
  }

  /** All unresolved flags for the EthicsConsole. */
  unresolvedFlags(filter: { subjectType?: string; severity?: EthicsSeverity[] } = {}): Array<EthicsFlag & {
    subjectTitle?: string
  }> {
    const db = getDatabase()
    const where: string[] = ['resolution IS NULL']
    const params: unknown[] = []
    if (filter.subjectType) {
      where.push('subject_type = ?')
      params.push(filter.subjectType)
    }
    if (filter.severity && filter.severity.length > 0) {
      where.push(`severity IN (${filter.severity.map(() => '?').join(',')})`)
      params.push(...filter.severity)
    }
    const rows = db.prepare(`
      SELECT id, subject_type AS subjectType, subject_id AS subjectId,
             flag_type AS flagType, severity, evidence, resolution,
             reviewed_by AS reviewedBy, created_at AS createdAt,
             reviewed_at AS reviewedAt
      FROM ethics_flags
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE severity WHEN 'block' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 200
    `).all(...params) as Array<EthicsFlag>

    // Resolve titles
    return rows.map((f) => {
      let title: string | undefined
      try {
        if (f.subjectType === 'report') {
          const r = db.prepare(`SELECT title FROM report_products WHERE id = ?`)
            .get(f.subjectId) as { title: string } | undefined
          title = r?.title
        }
      } catch { /* */ }
      return { ...f, subjectTitle: title }
    })
  }

  resolve(flagId: string, action: 'overridden' | 'redacted' | 'dismissed', notes?: string): boolean {
    const r = getDatabase().prepare(`
      UPDATE ethics_flags
      SET resolution = ?, resolution_notes = ?, reviewed_at = ?, reviewed_by = 'analyst'
      WHERE id = ? AND resolution IS NULL
    `).run(action, notes ?? null, Date.now(), flagId)
    return r.changes > 0
  }

  flagsForReport(reportId: string): EthicsFlag[] {
    const rows = getDatabase().prepare(`
      SELECT id, subject_type AS subjectType, subject_id AS subjectId,
             flag_type AS flagType, severity, evidence, resolution,
             reviewed_by AS reviewedBy, created_at AS createdAt,
             reviewed_at AS reviewedAt
      FROM ethics_flags
      WHERE subject_type = 'report' AND subject_id = ?
      ORDER BY
        CASE severity WHEN 'block' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC
    `).all(reportId) as EthicsFlag[]
    return rows
  }

  stats(): {
    totalFlags: number
    unresolved: number
    blocking: number
    byType: Record<string, number>
  } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ethics_flags`).get() as { n: number }).n
    const unresolved = (db.prepare(`SELECT COUNT(*) AS n FROM ethics_flags WHERE resolution IS NULL`).get() as { n: number }).n
    const blocking = (db.prepare(`SELECT COUNT(*) AS n FROM ethics_flags WHERE severity = 'block' AND resolution IS NULL`).get() as { n: number }).n
    const byType: Record<string, number> = {}
    for (const r of db.prepare(`SELECT flag_type, COUNT(*) AS n FROM ethics_flags WHERE resolution IS NULL GROUP BY flag_type`).all() as Array<{ flag_type: string; n: number }>) {
      byType[r.flag_type] = r.n
    }
    return { totalFlags: total, unresolved, blocking, byType }
  }
}

export const ethicsGuardrailsService = new EthicsGuardrailsService()
