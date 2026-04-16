import crypto from 'crypto'
import fs from 'fs'
import log from 'electron-log'
import { getDatabase } from '../database'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 7.6 — STIX 2.1 export + import.
 *
 * STIX 2.1 is the OASIS-standard JSON format for cyber threat
 * intelligence. Full spec compliance would be a thousand-line project —
 * this implementation covers the subset that corresponds to what
 * Heimdall actually holds:
 *
 *   intel_reports                 → STIX report + text observation
 *   intel_entities[cve]           → STIX vulnerability
 *   intel_entities[ip]            → STIX indicator + ipv4-addr observable
 *   intel_entities[hash]          → STIX indicator + file hash observable
 *   intel_entities[url]           → STIX indicator + url observable
 *   intel_entities[email]         → STIX indicator + email-addr observable
 *   intel_entities[malware]       → STIX malware
 *   intel_entities[threat_actor]  → STIX threat-actor
 *   intel_entities[organization]  → STIX identity
 *   report_attack_map             → STIX attack-pattern + relationship
 *
 * Each exported object carries a deterministic id (uuid v5 over type +
 * canonical value) so re-exporting the same row produces the same id —
 * essential for partner agencies diffing feeds.
 *
 * On import we dedupe on stix_id. Objects whose stix_id matches an
 * existing row are updated rather than duplicated. No destructive
 * merges without explicit analyst action.
 */

const STIX_VERSION = '2.1'
const SPEC_VERSION = '2.1'
const NAMESPACE = '00abedb4-aa42-466c-9c01-fed23315a9b7' // Heimdall deterministic UUIDv5 ns

/** Deterministic UUIDv5 over the project namespace. */
function uuidv5(seed: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex')
  const hash = crypto.createHash('sha1').update(ns).update(seed).digest()
  const u = Buffer.from(hash.subarray(0, 16))
  u[6] = (u[6] & 0x0f) | 0x50 // version 5
  u[8] = (u[8] & 0x3f) | 0x80 // variant
  const h = u.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function stixIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.000Z')
}

interface StixObject {
  type: string
  spec_version: string
  id: string
  created?: string
  modified?: string
  [k: string]: unknown
}

interface StixBundle {
  type: 'bundle'
  id: string
  objects: StixObject[]
}

export interface StixExportResult {
  run_id: number
  bundle_path: string
  objects_count: number
  reports_included: number
  indicators_created: number
  attack_patterns_created: number
  duration_ms: number
}

export interface StixImportResult {
  run_id: number
  bundle_path: string
  objects_in: number
  reports_created: number
  reports_updated: number
  entities_created: number
  skipped_unsupported: number
  duration_ms: number
  summary: string
}

const IOC_TO_STIX_PATTERN: Record<string, (v: string) => string> = {
  ip: (v) => `[ipv4-addr:value = '${v.replace(/'/g, "\\'")}']`,
  hash: (v) => `[file:hashes.'SHA-256' = '${v.replace(/'/g, "\\'")}']`,
  url: (v) => `[url:value = '${v.replace(/'/g, "\\'")}']`,
  email: (v) => `[email-addr:value = '${v.replace(/'/g, "\\'")}']`
}

export class StixService {
  /**
   * Export a filterable slice of the corpus. By default everything since
   * `since_ms` (default 30 days) is included; in practice analysts tend
   * to export a specific query they've scoped in the feed view.
   */
  export(opts: { since_ms?: number; discipline?: string | null; bundle_path: string }): StixExportResult {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare(
      "INSERT INTO stix_runs (kind, started_at, bundle_path) VALUES ('export', ?, ?)"
    ).run(started, opts.bundle_path).lastInsertRowid)

    try {
      const since = opts.since_ms ?? (started - 30 * 24 * 60 * 60 * 1000)

      // Build the identity for Heimdall itself. Required as the `created_by_ref`
      // for every object so downstream consumers can audit provenance.
      const identityId = `identity--${uuidv5('heimdall:identity:self')}`
      const identity: StixObject = {
        type: 'identity', spec_version: SPEC_VERSION, id: identityId,
        created: stixIso(started), modified: stixIso(started),
        name: 'Heimdall OSINT Platform', identity_class: 'system',
        sectors: ['technology']
      }

      const objects: StixObject[] = [identity]
      const includedReportIds = new Set<string>()

      // Fetch reports.
      const reportSql = `
        SELECT id, title, content, discipline, severity, source_name,
               verification_score, latitude, longitude, created_at,
               classification
        FROM intel_reports
        WHERE created_at >= ?
          ${opts.discipline ? 'AND discipline = ?' : ''}
          AND (quarantined IS NULL OR quarantined = 0)
        ORDER BY created_at DESC LIMIT 5000
      `
      const params = opts.discipline ? [since, opts.discipline] : [since]
      const reports = db.prepare(reportSql).all(...params) as Array<{
        id: string; title: string; content: string; discipline: string;
        severity: string; source_name: string; verification_score: number;
        latitude: number | null; longitude: number | null; created_at: number;
        classification: string | null
      }>

      // Track the ATT&CK mappings per report.
      const attackByReport = new Map<string, string[]>()
      if (reports.length > 0) {
        const placeholders = reports.map(() => '?').join(',')
        const rows = db.prepare(`
          SELECT report_id, technique_id FROM report_attack_map
          WHERE report_id IN (${placeholders})
        `).all(...reports.map((r) => r.id)) as Array<{ report_id: string; technique_id: string }>
        for (const r of rows) {
          const arr = attackByReport.get(r.report_id) ?? []
          arr.push(r.technique_id)
          attackByReport.set(r.report_id, arr)
        }
      }

      // Map every referenced ATT&CK technique → attack-pattern (once).
      const attackPatterns = new Map<string, StixObject>()
      const allTechniques = new Set<string>()
      for (const ids of attackByReport.values()) for (const t of ids) allTechniques.add(t)
      if (allTechniques.size > 0) {
        const placeholders = Array.from(allTechniques).map(() => '?').join(',')
        const techRows = db.prepare(`
          SELECT id, name, tactic FROM attack_techniques WHERE id IN (${placeholders})
        `).all(...Array.from(allTechniques)) as Array<{ id: string; name: string; tactic: string }>
        for (const t of techRows) {
          const stixId = `attack-pattern--${uuidv5(`mitre:attack:${t.id}`)}`
          attackPatterns.set(t.id, {
            type: 'attack-pattern', spec_version: SPEC_VERSION, id: stixId,
            created: stixIso(started), modified: stixIso(started),
            created_by_ref: identityId,
            name: t.name,
            external_references: [{
              source_name: 'mitre-attack', external_id: t.id,
              url: `https://attack.mitre.org/techniques/${t.id.replace('.', '/')}`
            }],
            kill_chain_phases: [{ kill_chain_name: 'mitre-attack', phase_name: t.tactic }]
          })
        }
      }
      for (const ap of attackPatterns.values()) objects.push(ap)

      // Fetch entities tied to included reports, partitioned by type.
      const entities = new Map<string, Array<{ id: string; entity_type: string; entity_value: string; report_id: string }>>()
      if (reports.length > 0) {
        const placeholders = reports.map(() => '?').join(',')
        const rows = db.prepare(`
          SELECT id, entity_type, entity_value, report_id
          FROM intel_entities WHERE report_id IN (${placeholders})
        `).all(...reports.map((r) => r.id)) as Array<{ id: string; entity_type: string; entity_value: string; report_id: string }>
        for (const r of rows) {
          const arr = entities.get(r.entity_type) ?? []
          arr.push(r)
          entities.set(r.entity_type, arr)
        }
      }

      // Create indicator objects for IOC-shaped entity types. Dedup by
      // (type, value) — same IP cited in 10 reports → 1 indicator.
      const indicatorByKey = new Map<string, StixObject>()
      let indicatorsCount = 0
      for (const [type, rows] of entities) {
        const patternFn = IOC_TO_STIX_PATTERN[type]
        if (!patternFn) continue
        const seen = new Set<string>()
        for (const r of rows) {
          const key = `${type}:${r.entity_value.toLowerCase()}`
          if (seen.has(key)) continue
          seen.add(key)
          const stixId = `indicator--${uuidv5(key)}`
          const obj: StixObject = {
            type: 'indicator', spec_version: SPEC_VERSION, id: stixId,
            created: stixIso(started), modified: stixIso(started),
            created_by_ref: identityId,
            indicator_types: ['unknown'],
            pattern: patternFn(r.entity_value),
            pattern_type: 'stix',
            valid_from: stixIso(started)
          }
          objects.push(obj); indicatorByKey.set(key, obj); indicatorsCount++
        }
      }

      // CVEs → vulnerability objects.
      for (const r of entities.get('cve') ?? []) {
        const stixId = `vulnerability--${uuidv5(`cve:${r.entity_value.toUpperCase()}`)}`
        objects.push({
          type: 'vulnerability', spec_version: SPEC_VERSION, id: stixId,
          created: stixIso(started), modified: stixIso(started),
          created_by_ref: identityId, name: r.entity_value.toUpperCase(),
          external_references: [{ source_name: 'cve', external_id: r.entity_value.toUpperCase() }]
        })
      }

      // Malware / threat-actor / organization entities.
      for (const [type, stixType] of [['malware', 'malware'], ['threat_actor', 'threat-actor'], ['organization', 'identity']] as const) {
        for (const r of entities.get(type) ?? []) {
          const stixId = `${stixType}--${uuidv5(`${type}:${r.entity_value.toLowerCase()}`)}`
          const base: StixObject = {
            type: stixType, spec_version: SPEC_VERSION, id: stixId,
            created: stixIso(started), modified: stixIso(started),
            created_by_ref: identityId, name: r.entity_value
          }
          if (stixType === 'malware') base.is_family = false
          if (stixType === 'identity') base.identity_class = 'organization'
          objects.push(base)
        }
      }

      // Finally, the report objects themselves + ATT&CK-pattern relationships.
      for (const r of reports) {
        const stixId = `report--${uuidv5(`heimdall:report:${r.id}`)}`
        const reportObj: StixObject = {
          type: 'report', spec_version: SPEC_VERSION, id: stixId,
          created: stixIso(r.created_at), modified: stixIso(started),
          created_by_ref: identityId,
          name: r.title,
          description: r.content?.slice(0, 8000) ?? '',
          published: stixIso(r.created_at),
          report_types: [mapDisciplineToReportType(r.discipline)],
          labels: [r.discipline, `severity:${r.severity}`],
          object_refs: [] as string[]
        }
        if (r.classification) {
          reportObj.granular_markings = [{
            marking_ref: `marking-definition--${uuidv5(`classification:${r.classification}`)}`,
            selectors: ['description']
          }]
        }
        if (r.latitude != null && r.longitude != null) {
          reportObj.x_heimdall_location = { latitude: r.latitude, longitude: r.longitude }
        }
        // Attach referenced indicators / vulns by STIX id.
        const refs = (reportObj.object_refs as string[])
        for (const [etype, rows] of entities) {
          for (const e of rows) {
            if (e.report_id !== r.id) continue
            if (IOC_TO_STIX_PATTERN[etype]) {
              refs.push(`indicator--${uuidv5(`${etype}:${e.entity_value.toLowerCase()}`)}`)
            } else if (etype === 'cve') {
              refs.push(`vulnerability--${uuidv5(`cve:${e.entity_value.toUpperCase()}`)}`)
            } else if (etype === 'malware') {
              refs.push(`malware--${uuidv5(`malware:${e.entity_value.toLowerCase()}`)}`)
            } else if (etype === 'threat_actor') {
              refs.push(`threat-actor--${uuidv5(`threat_actor:${e.entity_value.toLowerCase()}`)}`)
            } else if (etype === 'organization') {
              refs.push(`identity--${uuidv5(`organization:${e.entity_value.toLowerCase()}`)}`)
            }
          }
        }
        // Attach attack-pattern refs.
        for (const t of attackByReport.get(r.id) ?? []) {
          const apId = attackPatterns.get(t)?.id
          if (apId) refs.push(apId)
        }
        // Deduplicate refs.
        reportObj.object_refs = Array.from(new Set(refs))
        objects.push(reportObj)
        includedReportIds.add(r.id)

        // Relationship objects — one per (report, attack-pattern) pair.
        for (const t of attackByReport.get(r.id) ?? []) {
          const apId = attackPatterns.get(t)?.id
          if (!apId) continue
          const relId = `relationship--${uuidv5(`uses:${r.id}:${t}`)}`
          objects.push({
            type: 'relationship', spec_version: SPEC_VERSION, id: relId,
            created: stixIso(started), modified: stixIso(started),
            created_by_ref: identityId,
            relationship_type: 'refers-to',
            source_ref: stixId, target_ref: apId
          })
        }
      }

      const bundle: StixBundle = {
        type: 'bundle',
        id: `bundle--${uuidv5(`heimdall:bundle:${started}`)}`,
        objects
      }
      fs.writeFileSync(opts.bundle_path, JSON.stringify(bundle, null, 2))

      const finished = Date.now()
      db.prepare(
        'UPDATE stix_runs SET finished_at=?, objects_in=0, objects_out=?, summary=?, duration_ms=? WHERE id=?'
      ).run(finished, objects.length,
        `${reports.length} reports, ${indicatorsCount} indicators, ${attackPatterns.size} attack-patterns`,
        finished - started, runId)

      try {
        auditChainService.append('stix.export', {
          entityType: 'stix', entityId: String(runId),
          payload: { bundle_path: opts.bundle_path, objects: objects.length }
        })
      } catch { /* noop */ }

      log.info(`stix-export: ${objects.length} objects (${reports.length} reports, ${indicatorsCount} indicators) → ${opts.bundle_path} (${finished - started}ms)`)

      return {
        run_id: runId, bundle_path: opts.bundle_path, objects_count: objects.length,
        reports_included: reports.length, indicators_created: indicatorsCount,
        attack_patterns_created: attackPatterns.size, duration_ms: finished - started
      }
    } catch (err) {
      db.prepare('UPDATE stix_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  /**
   * Import a STIX bundle file. Reads the whole bundle into memory; for
   * very large bundles we'd stream, but typical partner feeds are a few
   * MB and the complexity isn't worth it yet.
   *
   * Dedupes on stix_id. Reports with matching stix_id are UPDATEd;
   * entities with matching stix_id are skipped (their report_id linkage
   * is what matters and is re-created per run if appropriate).
   */
  import(bundlePath: string): StixImportResult {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare(
      "INSERT INTO stix_runs (kind, started_at, bundle_path) VALUES ('import', ?, ?)"
    ).run(started, bundlePath).lastInsertRowid)

    try {
      const raw = fs.readFileSync(bundlePath, 'utf-8')
      const bundle = JSON.parse(raw) as StixBundle
      if (bundle.type !== 'bundle' || !Array.isArray(bundle.objects)) {
        throw new Error('Not a STIX bundle: missing type=bundle or objects array')
      }

      const byId = new Map<string, StixObject>()
      for (const o of bundle.objects) if (o.id) byId.set(o.id, o)

      let reportsCreated = 0, reportsUpdated = 0, entitiesCreated = 0, skipped = 0
      const now = Date.now()

      const tx = db.transaction(() => {
        for (const obj of bundle.objects) {
          switch (obj.type) {
            case 'report': {
              const stixId = obj.id
              const existing = db.prepare(
                'SELECT id FROM intel_reports WHERE stix_id = ? LIMIT 1'
              ).get(stixId) as { id: string } | undefined
              const name = String(obj.name ?? 'Imported STIX report')
              const description = String(obj.description ?? '')
              const labels = Array.isArray(obj.labels) ? (obj.labels as string[]) : []
              const discipline = labels.find((l) => !l.startsWith('severity:')) || 'osint'
              const severity = (labels.find((l) => l.startsWith('severity:'))?.slice(9)) as string || 'medium'
              const publishedMs = obj.published
                ? new Date(obj.published as string).getTime()
                : now

              if (existing) {
                db.prepare(`
                  UPDATE intel_reports SET title = ?, content = ?, discipline = ?,
                    severity = ?, updated_at = ? WHERE id = ?
                `).run(name.slice(0, 500), description.slice(0, 20000), discipline, severity, now, existing.id)
                reportsUpdated++
              } else {
                const newId = crypto.randomUUID()
                const titleTrim = name.slice(0, 500)
                const contentTrim = description.slice(0, 20000)
                const contentHash = crypto.createHash('sha256').update(`${titleTrim}|${contentTrim}`).digest('hex')
                db.prepare(`
                  INSERT INTO intel_reports
                    (id, discipline, title, content, summary, severity,
                     source_id, source_url, source_name, content_hash,
                     verification_score, reviewed, created_at, updated_at, stix_id)
                  VALUES (?, ?, ?, ?, NULL, ?, 'stix-import', NULL, 'STIX Import', ?, 50, 0, ?, ?, ?)
                `).run(newId, discipline, titleTrim, contentTrim, severity, contentHash,
                  publishedMs, now, stixId)
                reportsCreated++
              }
              break
            }
            case 'indicator': {
              // Pick an entity_type + value out of the STIX pattern. Only
              // the IOC shapes we export ourselves are reversed here — any
              // fancier pattern is skipped rather than mis-interpreted.
              const pattern = String(obj.pattern ?? '')
              let etype: string | null = null, val: string | null = null
              const ipMatch = /ipv4-addr:value\s*=\s*'([^']+)'/.exec(pattern)
              const hashMatch = /file:hashes\.'SHA-256'\s*=\s*'([^']+)'/.exec(pattern)
              const urlMatch = /url:value\s*=\s*'([^']+)'/.exec(pattern)
              const emailMatch = /email-addr:value\s*=\s*'([^']+)'/.exec(pattern)
              if (ipMatch) { etype = 'ip'; val = ipMatch[1] }
              else if (hashMatch) { etype = 'hash'; val = hashMatch[1] }
              else if (urlMatch) { etype = 'url'; val = urlMatch[1] }
              else if (emailMatch) { etype = 'email'; val = emailMatch[1] }
              if (!etype || !val) { skipped++; break }

              // Only attach to reports that reference this indicator id.
              const referrers = bundle.objects.filter((x) => x.type === 'report' &&
                Array.isArray(x.object_refs) && (x.object_refs as string[]).includes(obj.id))
              if (referrers.length === 0) { skipped++; break }
              for (const r of referrers) {
                const reportRow = db.prepare('SELECT id FROM intel_reports WHERE stix_id = ? LIMIT 1').get(r.id) as { id: string } | undefined
                if (!reportRow) continue
                const existingEnt = db.prepare(
                  'SELECT id FROM intel_entities WHERE stix_id = ? AND report_id = ? LIMIT 1'
                ).get(obj.id, reportRow.id) as { id: string } | undefined
                if (existingEnt) continue
                db.prepare(`
                  INSERT INTO intel_entities (id, report_id, entity_type, entity_value, confidence, created_at, stix_id)
                  VALUES (?, ?, ?, ?, 0.9, ?, ?)
                `).run(crypto.randomUUID(), reportRow.id, etype, val, now, obj.id)
                entitiesCreated++
              }
              break
            }
            case 'vulnerability': {
              const name = String(obj.name ?? '')
              if (!/^CVE-\d{4}-\d{4,}$/i.test(name)) { skipped++; break }
              const referrers = bundle.objects.filter((x) => x.type === 'report' &&
                Array.isArray(x.object_refs) && (x.object_refs as string[]).includes(obj.id))
              for (const r of referrers) {
                const reportRow = db.prepare('SELECT id FROM intel_reports WHERE stix_id = ? LIMIT 1').get(r.id) as { id: string } | undefined
                if (!reportRow) continue
                const existingEnt = db.prepare(
                  'SELECT id FROM intel_entities WHERE stix_id = ? AND report_id = ? LIMIT 1'
                ).get(obj.id, reportRow.id) as { id: string } | undefined
                if (existingEnt) continue
                db.prepare(`
                  INSERT INTO intel_entities (id, report_id, entity_type, entity_value, confidence, created_at, stix_id)
                  VALUES (?, ?, 'cve', ?, 0.95, ?, ?)
                `).run(crypto.randomUUID(), reportRow.id, name.toUpperCase(), now, obj.id)
                entitiesCreated++
              }
              break
            }
            // Silently skip object types we don't map back (identity,
            // attack-pattern, malware, threat-actor, relationship,
            // marking-definition…). They're retained in the bundle file
            // on disk if the analyst wants to inspect them.
            default:
              skipped++
          }
        }
      })
      tx()

      const finished = Date.now()
      const summary = `${reportsCreated} created, ${reportsUpdated} updated, ${entitiesCreated} entities, ${skipped} skipped`
      db.prepare(
        'UPDATE stix_runs SET finished_at=?, objects_in=?, objects_out=?, summary=?, duration_ms=? WHERE id=?'
      ).run(finished, bundle.objects.length, reportsCreated + entitiesCreated, summary,
        finished - started, runId)

      try {
        auditChainService.append('stix.import', {
          entityType: 'stix', entityId: String(runId),
          payload: { bundle_path: bundlePath, ...{ reportsCreated, reportsUpdated, entitiesCreated, skipped } }
        })
      } catch { /* noop */ }

      log.info(`stix-import: ${bundle.objects.length} objects in — ${summary} (${finished - started}ms)`)

      return {
        run_id: runId, bundle_path: bundlePath, objects_in: bundle.objects.length,
        reports_created: reportsCreated, reports_updated: reportsUpdated,
        entities_created: entitiesCreated, skipped_unsupported: skipped,
        duration_ms: finished - started, summary
      }
    } catch (err) {
      db.prepare('UPDATE stix_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  recentRuns(limit = 50): Array<{
    id: number; kind: string; started_at: number; finished_at: number | null;
    objects_in: number | null; objects_out: number | null; bundle_path: string | null;
    summary: string | null; duration_ms: number | null; error: string | null
  }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, kind, started_at, finished_at, objects_in, objects_out,
             bundle_path, summary, duration_ms, error
      FROM stix_runs ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<{ id: number; kind: string; started_at: number; finished_at: number | null; objects_in: number | null; objects_out: number | null; bundle_path: string | null; summary: string | null; duration_ms: number | null; error: string | null }>
  }
}

function mapDisciplineToReportType(d: string): string {
  switch (d) {
    case 'cybint': return 'threat-report'
    case 'sigint': return 'threat-report'
    case 'humint': return 'observed-data'
    case 'geoint': return 'indicator'
    case 'finint': return 'observed-data'
    default: return 'observed-data'
  }
}

export const stixService = new StixService()
