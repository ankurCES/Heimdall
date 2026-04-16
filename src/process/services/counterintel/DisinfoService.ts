import crypto from 'crypto'
import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Cross-cutting J + Theme 6.5 + 6.6 — Counter-intel sweep.
 *
 *  J     Daily disinfo sweep — cluster socmint rows by:
 *        • exact normalized title (template attack across platforms)
 *        • URL hash repetition (cross-source same linked piece)
 *        • burst windows of identical narrative within 60 min
 *
 *  6.5   Canary tokens — generate tokenized briefings, log if they
 *        appear externally (analyst pastes the source URL manually for
 *        now; full beacon infra out of scope).
 *
 *  6.6   Insider threat scoring — detects anomalous analyst behaviour
 *        (mass exports, off-hours access, unusually broad searches).
 *        Signals come from the audit chain; this service reads and
 *        tags, it does not block.
 */

// ─── Daily disinfo sweep ────────────────────────────────────────────
export interface DisinfoCluster {
  id: string
  signature_kind: string
  signature_value: string
  member_count: number
  first_seen_at: number
  last_seen_at: number
  sample_titles: string[]
  sample_sources: string[]
}

export interface DisinfoRun {
  id: number
  started_at: number
  finished_at: number
  reports_scanned: number
  clusters_found: number
  duration_ms: number
}

function normaliseTitle(title: string): string {
  return title.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

export class DisinfoService {
  sweep(windowHours = 48): DisinfoRun {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare('INSERT INTO disinfo_runs (started_at) VALUES (?)').run(started).lastInsertRowid)
    try {
      const since = started - windowHours * 60 * 60 * 1000
      // Cap at 5000 most recent to avoid OOM on large corpora. The
      // clustering logic only needs enough volume to detect patterns;
      // beyond 5K diminishing returns vs memory cost.
      const rows = db.prepare(`
        SELECT id, title, source_name, source_url, created_at
        FROM intel_reports
        WHERE created_at >= ? AND title IS NOT NULL
        ORDER BY created_at DESC LIMIT 5000
      `).all(since) as Array<{ id: string; title: string; source_name: string; source_url: string | null; created_at: number }>

      // Cluster by normalised title (template-attack signal)
      const byTitle = new Map<string, typeof rows>()
      for (const r of rows) {
        const sig = normaliseTitle(r.title)
        if (sig.length < 10) continue
        const arr = byTitle.get(sig) ?? []
        arr.push(r)
        byTitle.set(sig, arr)
      }
      // Cluster by exact URL (cross-source amplification)
      const byUrl = new Map<string, typeof rows>()
      for (const r of rows) {
        if (!r.source_url) continue
        const arr = byUrl.get(r.source_url) ?? []
        arr.push(r)
        byUrl.set(r.source_url, arr)
      }

      const now = Date.now()
      let found = 0
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM disinfo_clusters WHERE first_seen_at >= ?').run(since)
        db.prepare(`
          DELETE FROM disinfo_cluster_members WHERE cluster_id NOT IN (SELECT id FROM disinfo_clusters)
        `).run()
        const insC = db.prepare(`
          INSERT INTO disinfo_clusters (id, signature_kind, signature_value, member_count, first_seen_at, last_seen_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        const insM = db.prepare(
          'INSERT OR IGNORE INTO disinfo_cluster_members (cluster_id, report_id) VALUES (?, ?)'
        )
        for (const [sig, members] of byTitle) {
          if (members.length < 3) continue
          const distinctSources = new Set(members.map((m) => m.source_name))
          if (distinctSources.size < 2) continue // trivial if all from same source
          const id = crypto.createHash('sha256').update(`title|${sig}`).digest('hex').slice(0, 24)
          const firstSeen = Math.min(...members.map((m) => m.created_at))
          const lastSeen = Math.max(...members.map((m) => m.created_at))
          insC.run(id, 'template_title', sig.slice(0, 500), members.length, firstSeen, lastSeen, now)
          for (const m of members) insM.run(id, m.id)
          found++
        }
        for (const [url, members] of byUrl) {
          if (members.length < 3) continue
          const id = crypto.createHash('sha256').update(`url|${url}`).digest('hex').slice(0, 24)
          const firstSeen = Math.min(...members.map((m) => m.created_at))
          const lastSeen = Math.max(...members.map((m) => m.created_at))
          insC.run(id, 'url_repeat', url.slice(0, 500), members.length, firstSeen, lastSeen, now)
          for (const m of members) insM.run(id, m.id)
          found++
        }
      })
      tx()

      const finished = Date.now()
      db.prepare(
        'UPDATE disinfo_runs SET finished_at=?, reports_scanned=?, clusters_found=?, duration_ms=? WHERE id=?'
      ).run(finished, rows.length, found, finished - started, runId)
      log.info(`disinfo: scanned ${rows.length} reports, found ${found} clusters (${finished - started}ms)`)
      return { id: runId, started_at: started, finished_at: finished, reports_scanned: rows.length, clusters_found: found, duration_ms: finished - started }
    } catch (err) {
      db.prepare('UPDATE disinfo_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  recentClusters(limit = 50): DisinfoCluster[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT id, signature_kind, signature_value, member_count, first_seen_at, last_seen_at
      FROM disinfo_clusters ORDER BY member_count DESC, last_seen_at DESC LIMIT ?
    `).all(limit) as Array<Omit<DisinfoCluster, 'sample_titles' | 'sample_sources'>>
    return rows.map((r) => {
      const samples = db.prepare(`
        SELECT r.title, r.source_name FROM disinfo_cluster_members m
        JOIN intel_reports r ON r.id = m.report_id
        WHERE m.cluster_id = ? LIMIT 5
      `).all(r.id) as Array<{ title: string; source_name: string }>
      return {
        ...r,
        sample_titles: samples.map((s) => s.title),
        sample_sources: Array.from(new Set(samples.map((s) => s.source_name)))
      }
    })
  }

  latestRun(): DisinfoRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, reports_scanned, clusters_found, duration_ms
      FROM disinfo_runs WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as DisinfoRun) || null
  }
}

export const disinfoService = new DisinfoService()

// ─── Canary tokens (6.5) ────────────────────────────────────────────
export class CanaryService {
  create(label: string, attachedType?: string, attachedId?: string): { id: string; token: string } {
    const db = getDatabase()
    const token = `HEIMDALL-CANARY-${crypto.randomBytes(9).toString('hex').toUpperCase()}`
    const id = generateId()
    db.prepare(`
      INSERT INTO canary_tokens (id, token, label, attached_artifact_type, attached_artifact_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(id, token, label, attachedType ?? null, attachedId ?? null, Date.now())
    try {
      auditChainService.append('canary.created', { entityType: 'canary', entityId: id, payload: { token, label } })
    } catch { /* noop */ }
    return { id, token }
  }
  list(): Array<{ id: string; token: string; label: string; attached_artifact_type: string | null; attached_artifact_id: string | null; observed_at: number | null; observed_source: string | null; notes: string | null; created_at: number }> {
    const db = getDatabase()
    return db.prepare('SELECT id, token, label, attached_artifact_type, attached_artifact_id, observed_at, observed_source, notes, created_at FROM canary_tokens ORDER BY created_at DESC').all() as Array<{ id: string; token: string; label: string; attached_artifact_type: string | null; attached_artifact_id: string | null; observed_at: number | null; observed_source: string | null; notes: string | null; created_at: number }>
  }
  markObserved(id: string, source: string, notes?: string): void {
    const db = getDatabase()
    db.prepare('UPDATE canary_tokens SET observed_at = ?, observed_source = ?, notes = ? WHERE id = ?')
      .run(Date.now(), source, notes ?? null, id)
    try {
      auditChainService.append('canary.observed', { entityType: 'canary', entityId: id, payload: { source } })
    } catch { /* noop */ }
  }
  /** Scan intel_reports.content for any token appearance and auto-flag. Analyst-run. */
  scanCorpus(): number {
    const db = getDatabase()
    const tokens = db.prepare('SELECT id, token FROM canary_tokens WHERE observed_at IS NULL').all() as Array<{ id: string; token: string }>
    let flagged = 0
    for (const t of tokens) {
      const hit = db.prepare(
        "SELECT source_name FROM intel_reports WHERE content LIKE ? OR title LIKE ? LIMIT 1"
      ).get(`%${t.token}%`, `%${t.token}%`) as { source_name: string } | undefined
      if (hit) {
        this.markObserved(t.id, hit.source_name, 'auto-detected in corpus')
        flagged++
      }
    }
    return flagged
  }
}
export const canaryService = new CanaryService()

// ─── Insider threat (6.6) ───────────────────────────────────────────
export class InsiderThreatService {
  /** Pull suspicious events from the audit chain and cache. */
  scan(): { events_recorded: number } {
    const db = getDatabase()
    const now = Date.now()
    const since = now - 24 * 60 * 60 * 1000
    const hourNow = new Date().getHours()

    // Count recent export events from the audit chain. Heavy export volume
    // is the #1 insider-threat tell in practice.
    let exportBurst = 0
    try {
      exportBurst = (db.prepare(
        `SELECT COUNT(*) AS n FROM audit_log_chained WHERE action LIKE 'export.%' AND timestamp >= ?`
      ).get(since) as { n: number }).n
    } catch { /* audit schema may differ on older installs */ }

    const events: Array<{ kind: string; severity: 'low' | 'med' | 'high'; detail: string }> = []
    if (exportBurst >= 50) events.push({ kind: 'mass_export', severity: 'high', detail: `${exportBurst} exports in 24h` })
    else if (exportBurst >= 20) events.push({ kind: 'mass_export', severity: 'med', detail: `${exportBurst} exports in 24h` })

    // Off-hours access heuristic — if the most recent 20 audit events are
    // all clustered outside 07:00-21:00.
    try {
      const recent = db.prepare(
        `SELECT timestamp FROM audit_log_chained ORDER BY sequence DESC LIMIT 20`
      ).all() as Array<{ timestamp: number }>
      if (recent.length >= 10) {
        const offHours = recent.filter((r) => {
          const h = new Date(r.timestamp).getHours()
          return h < 7 || h > 21
        }).length
        if (offHours / recent.length > 0.8) {
          events.push({ kind: 'off_hours_cluster', severity: 'med', detail: `${offHours}/${recent.length} recent events outside 07:00-21:00` })
        }
      }
    } catch { /* noop */ }

    // Classification-skip: analyst read TS content immediately after having only SECRET clearance seconds earlier.
    // Skipped — requires clearance audit we don't yet record. Left as a hook.

    const ins = db.prepare(
      'INSERT INTO insider_events (analyst_id, kind, severity, detail, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      for (const e of events) ins.run('self', e.kind, e.severity, e.detail, now)
    })
    tx()
    log.info(`insider: ${events.length} event(s) recorded (off-hours=${hourNow})`)
    return { events_recorded: events.length }
  }

  recent(limit = 50): Array<{ id: number; analyst_id: string; kind: string; severity: string; detail: string | null; created_at: number }> {
    const db = getDatabase()
    return db.prepare('SELECT id, analyst_id, kind, severity, detail, created_at FROM insider_events ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: number; analyst_id: string; kind: string; severity: string; detail: string | null; created_at: number }>
  }
}
export const insiderThreatService = new InsiderThreatService()
