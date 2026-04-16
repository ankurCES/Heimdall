import log from 'electron-log'
import { getDatabase } from '../database'
import { ATTACK_TECHNIQUE_SEED, ATTACK_TACTICS } from './attackSeed'

/**
 * Theme 7 — CYBINT depth.
 *
 * Two layers:
 *   1. MITRE ATT&CK technique tagging. On-demand regex/name match over
 *      intel_reports.content → report_attack_map. Two match modes:
 *        - id   — exact T#### / T####.### pattern
 *        - name — technique name appears in content (case-insensitive,
 *                 whole-word boundary). Names shorter than 6 chars are
 *                 skipped to reduce false positives ("Proxy", "Masquerading"
 *                 both made the cut given their unambiguous context).
 *   2. CISA KEV sync. Fetches the catalog JSON, upserts kev_entries.
 *      `kevInCorpus()` cross-references CVEs already extracted into
 *      intel_entities with the KEV catalog to surface exploited-in-the-wild
 *      vulnerabilities mentioned in our reports.
 *
 * EPSS (exploit prediction) is exposed as a lookup rather than a batch
 * table — the API is rate-limited enough that we don't want to mirror it.
 */

export interface CybintRun {
  id: number
  kind: string
  started_at: number
  finished_at: number
  items_processed: number
  items_written: number
  duration_ms: number
}

export interface AttackTechniqueRow {
  id: string
  name: string
  tactic: string
  is_sub: number
  parent_id: string | null
}

export interface TechniqueFrequency extends AttackTechniqueRow {
  mention_count: number
}

export interface KevEntry {
  cve_id: string
  vendor_project: string | null
  product: string | null
  vulnerability_name: string | null
  date_added: string | null
  short_description: string | null
  due_date: string | null
  known_ransomware_use: number
}

const TECHNIQUE_ID_RE = /\bT\d{4}(?:\.\d{3})?\b/g

export class CybintService {
  /** Idempotently seed ATT&CK techniques. */
  seedTechniques(): void {
    const db = getDatabase()
    const count = (db.prepare('SELECT COUNT(*) AS n FROM attack_techniques').get() as { n: number }).n
    if (count > 0) return
    const ins = db.prepare(`
      INSERT INTO attack_techniques (id, name, tactic, is_sub, parent_id, seeded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const t of ATTACK_TECHNIQUE_SEED) {
        ins.run(t.id, t.name, t.tactic, t.parent_id ? 1 : 0, t.parent_id ?? null, now)
      }
    })
    tx()
    log.info(`cybint: seeded ${ATTACK_TECHNIQUE_SEED.length} ATT&CK techniques`)
  }

  tactics(): Array<{ id: string; name: string; technique_count: number }> {
    const db = getDatabase()
    this.seedTechniques()
    const counts = db.prepare(`
      SELECT tactic, COUNT(*) AS n FROM attack_techniques GROUP BY tactic
    `).all() as Array<{ tactic: string; n: number }>
    const byTactic = new Map(counts.map((c) => [c.tactic, c.n]))
    return ATTACK_TACTICS.map((t) => ({ ...t, technique_count: byTactic.get(t.id) ?? 0 }))
  }

  techniques(tactic?: string | null): AttackTechniqueRow[] {
    const db = getDatabase()
    this.seedTechniques()
    if (tactic) {
      return db.prepare(`
        SELECT id, name, tactic, is_sub, parent_id FROM attack_techniques
        WHERE tactic = ? ORDER BY id
      `).all(tactic) as AttackTechniqueRow[]
    }
    return db.prepare(`
      SELECT id, name, tactic, is_sub, parent_id FROM attack_techniques ORDER BY id
    `).all() as AttackTechniqueRow[]
  }

  /**
   * Scan every intel_reports.content for technique references and repopulate
   * report_attack_map in full. Two match modes — ID (high confidence 0.9)
   * and name (medium 0.6).
   */
  tagTechniques(): CybintRun {
    const db = getDatabase()
    this.seedTechniques()
    const started = Date.now()
    const runId = Number(db.prepare(
      "INSERT INTO cybint_runs (kind, started_at) VALUES ('attack-tag', ?)"
    ).run(started).lastInsertRowid)

    try {
      const techs = this.techniques()
      const byId = new Map(techs.map((t) => [t.id, t]))
      const nameProbes: Array<{ id: string; re: RegExp }> = techs
        .filter((t) => t.name.length >= 6)
        .map((t) => ({
          id: t.id,
          re: new RegExp(`\\b${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        }))

      const rows = db.prepare(
        'SELECT id, content FROM intel_reports WHERE content IS NOT NULL AND length(content) > 20'
      ).all() as Array<{ id: string; content: string }>

      let totalMappings = 0
      const now = Date.now()
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM report_attack_map').run()
        const ins = db.prepare(`
          INSERT OR IGNORE INTO report_attack_map
            (report_id, technique_id, confidence, matched_via, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)

        for (const r of rows) {
          const text = r.content
          // ID matches — authoritative.
          const ids = new Set<string>()
          for (const m of text.matchAll(TECHNIQUE_ID_RE)) {
            if (byId.has(m[0])) ids.add(m[0])
          }
          for (const id of ids) {
            ins.run(r.id, id, 0.9, 'id', now)
            totalMappings++
          }
          // Name matches — only if not already matched by ID.
          for (const probe of nameProbes) {
            if (ids.has(probe.id)) continue
            if (probe.re.test(text)) {
              ins.run(r.id, probe.id, 0.6, 'name', now)
              totalMappings++
            }
          }
        }
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE cybint_runs SET finished_at=?, items_processed=?, items_written=?, duration_ms=? WHERE id=?'
      ).run(finished, rows.length, totalMappings, finished - started, runId)

      log.info(`cybint: ATT&CK tag — ${rows.length} reports scanned, ${totalMappings} mappings written, ${finished - started}ms`)
      return { id: runId, kind: 'attack-tag', started_at: started, finished_at: finished,
        items_processed: rows.length, items_written: totalMappings, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE cybint_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  /** Top techniques by corpus mention count. */
  topTechniques(limit = 20): TechniqueFrequency[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT t.id, t.name, t.tactic, t.is_sub, t.parent_id,
             COUNT(DISTINCT m.report_id) AS mention_count
      FROM attack_techniques t
      JOIN report_attack_map m ON m.technique_id = t.id
      GROUP BY t.id
      ORDER BY mention_count DESC LIMIT ?
    `).all(limit) as TechniqueFrequency[]
  }

  reportsForTechnique(techniqueId: string, limit = 50): Array<{
    report_id: string; title: string; source_name: string; discipline: string;
    severity: string; created_at: number; confidence: number; matched_via: string
  }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT r.id AS report_id, r.title, r.source_name, r.discipline, r.severity, r.created_at,
             m.confidence, m.matched_via
      FROM report_attack_map m
      JOIN intel_reports r ON r.id = m.report_id
      WHERE m.technique_id = ?
      ORDER BY r.created_at DESC LIMIT ?
    `).all(techniqueId, limit) as Array<{ report_id: string; title: string; source_name: string; discipline: string; severity: string; created_at: number; confidence: number; matched_via: string }>
  }

  /**
   * Fetch CISA KEV catalog and upsert kev_entries. Caller supplies no
   * credentials — this is a public JSON feed.
   */
  async syncKev(): Promise<CybintRun> {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare(
      "INSERT INTO cybint_runs (kind, started_at) VALUES ('kev-sync', ?)"
    ).run(started).lastInsertRowid)

    try {
      const url = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
      const res = await fetch(url, { headers: { 'user-agent': 'Heimdall-CYBINT' } })
      if (!res.ok) throw new Error(`CISA KEV fetch failed: ${res.status} ${res.statusText}`)
      const json = await res.json() as { vulnerabilities: Array<Record<string, unknown>> }
      const entries = json.vulnerabilities ?? []

      const now = Date.now()
      const ins = db.prepare(`
        INSERT INTO kev_entries (
          cve_id, vendor_project, product, vulnerability_name, date_added,
          short_description, required_action, due_date, known_ransomware_use,
          cwes, notes, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cve_id) DO UPDATE SET
          vendor_project = excluded.vendor_project,
          product = excluded.product,
          vulnerability_name = excluded.vulnerability_name,
          date_added = excluded.date_added,
          short_description = excluded.short_description,
          required_action = excluded.required_action,
          due_date = excluded.due_date,
          known_ransomware_use = excluded.known_ransomware_use,
          cwes = excluded.cwes,
          notes = excluded.notes,
          fetched_at = excluded.fetched_at
      `)
      const tx = db.transaction(() => {
        for (const v of entries) {
          // CISA occasionally reshuffles fields; accept array-of-strings,
          // already-joined string, or drop it entirely rather than silently
          // writing [object Object].
          let cwes: string | null = null
          if (Array.isArray(v.cwes)) cwes = (v.cwes as unknown[]).map(String).join(',')
          else if (typeof v.cwes === 'string') cwes = v.cwes
          const rw = typeof v.knownRansomwareCampaignUse === 'string' && v.knownRansomwareCampaignUse.toLowerCase() === 'known' ? 1 : 0
          ins.run(
            String(v.cveID || ''),
            (v.vendorProject ?? null) as string | null,
            (v.product ?? null) as string | null,
            (v.vulnerabilityName ?? null) as string | null,
            (v.dateAdded ?? null) as string | null,
            (v.shortDescription ?? null) as string | null,
            (v.requiredAction ?? null) as string | null,
            (v.dueDate ?? null) as string | null,
            rw,
            cwes,
            (v.notes ?? null) as string | null,
            now
          )
        }
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE cybint_runs SET finished_at=?, items_processed=?, items_written=?, duration_ms=? WHERE id=?'
      ).run(finished, entries.length, entries.length, finished - started, runId)

      log.info(`cybint: KEV sync — ${entries.length} entries, ${finished - started}ms`)
      return { id: runId, kind: 'kev-sync', started_at: started, finished_at: finished,
        items_processed: entries.length, items_written: entries.length, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE cybint_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      log.error(`cybint: KEV sync failed: ${(err as Error).message}`)
      throw err
    }
  }

  kevCount(): { total: number; ransomware: number; last_sync: number | null } {
    const db = getDatabase()
    const total = (db.prepare('SELECT COUNT(*) AS n FROM kev_entries').get() as { n: number }).n
    const ransomware = (db.prepare('SELECT COUNT(*) AS n FROM kev_entries WHERE known_ransomware_use = 1').get() as { n: number }).n
    const lastRow = db.prepare('SELECT MAX(fetched_at) AS t FROM kev_entries').get() as { t: number | null }
    return { total, ransomware, last_sync: lastRow.t }
  }

  /**
   * CVEs mentioned in our reports that are KEV-listed. Uses intel_entities
   * as the CVE source (populated by IntelEnricher regex extractor).
   */
  kevInCorpus(limit = 100): Array<KevEntry & { mention_count: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT k.cve_id, k.vendor_project, k.product, k.vulnerability_name,
             k.date_added, k.short_description, k.due_date, k.known_ransomware_use,
             COUNT(DISTINCT e.report_id) AS mention_count
      FROM kev_entries k
      JOIN intel_entities e ON e.entity_type = 'cve' AND upper(e.entity_value) = upper(k.cve_id)
      GROUP BY k.cve_id
      ORDER BY mention_count DESC, k.date_added DESC
      LIMIT ?
    `).all(limit) as Array<KevEntry & { mention_count: number }>
  }

  /** Last successful run of a given kind. */
  latestRun(kind: string): CybintRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, kind, started_at, finished_at, items_processed, items_written, duration_ms
      FROM cybint_runs
      WHERE kind = ? AND finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(kind) as CybintRun) || null
  }
}

export const cybintService = new CybintService()
