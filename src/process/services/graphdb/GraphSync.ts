import { getDatabase } from '../database'
import { kuzuService } from './KuzuService'
import { timestamp } from '@common/utils/id'
import log from 'electron-log'

class GraphSync {
  private syncing = false

  async fullSync(): Promise<{ nodes: number; links: number }> {
    if (this.syncing) {
      log.warn('GraphSync: sync already in progress')
      return { nodes: 0, links: 0 }
    }
    if (!kuzuService.isReady()) {
      log.warn('GraphSync: Kuzu not ready, skipping sync')
      return { nodes: 0, links: 0 }
    }

    this.syncing = true
    let totalNodes = 0
    let totalLinks = 0

    try {
      const db = getDatabase()

      // 1. Sync intel_reports
      const reports = db.prepare('SELECT id, title, discipline, severity, source_name, verification_score, created_at FROM intel_reports').all() as Array<Record<string, unknown>>
      for (let i = 0; i < reports.length; i += 100) {
        const batch = reports.slice(i, i + 100)
        for (const r of batch) {
          await kuzuService.upsertIntelReport({
            id: r.id as string, title: r.title as string, discipline: r.discipline as string,
            severity: r.severity as string, source: r.source_name as string,
            verification: r.verification_score as number, created_at: r.created_at as number
          })
        }
        totalNodes += batch.length
        // Yield to event loop between batches
        if (i + 100 < reports.length) await new Promise((r) => setImmediate(r))
      }
      log.info(`GraphSync: synced ${totalNodes} intel reports`)

      // 2. Sync preliminary_reports
      const prelims = db.prepare('SELECT id, title, status, created_at FROM preliminary_reports').all() as Array<Record<string, unknown>>
      for (const p of prelims) {
        await kuzuService.upsertPreliminaryReport({
          id: p.id as string, title: p.title as string, status: p.status as string,
          created_at: p.created_at as number
        })
        totalNodes++
      }

      // 3. Sync humint_reports
      const humints = db.prepare('SELECT id, findings, confidence, created_at FROM humint_reports').all() as Array<Record<string, unknown>>
      for (const h of humints) {
        await kuzuService.upsertHumintReport({
          id: h.id as string, title: `HUMINT: ${(h.findings as string || '').slice(0, 80)}`,
          confidence: h.confidence as string, created_at: h.created_at as number
        })
        totalNodes++
      }

      // 4. Sync intel_gaps
      const gaps = db.prepare("SELECT id, description, category, severity FROM intel_gaps WHERE status = 'open'").all() as Array<Record<string, unknown>>
      for (const g of gaps) {
        await kuzuService.upsertIntelGap({
          id: g.id as string, description: g.description as string,
          category: g.category as string | null, severity: g.severity as string
        })
        totalNodes++
      }

      // 5. Sync entities (deduplicated by type:value)
      const entities = db.prepare(
        'SELECT DISTINCT entity_type, entity_value FROM intel_entities'
      ).all() as Array<{ entity_type: string; entity_value: string }>
      for (let i = 0; i < entities.length; i += 100) {
        const batch = entities.slice(i, i + 100)
        for (const e of batch) {
          const entityId = `${e.entity_type}:${e.entity_value}`
          await kuzuService.upsertEntity({ id: entityId, type: e.entity_type, value: e.entity_value })
          totalNodes++
        }
        if (i + 100 < entities.length) await new Promise((r) => setImmediate(r))
      }

      // 6. Sync HAS_ENTITY relationships
      const entityLinks = db.prepare(
        'SELECT report_id, entity_type, entity_value FROM intel_entities'
      ).all() as Array<{ report_id: string; entity_type: string; entity_value: string }>
      for (let i = 0; i < entityLinks.length; i += 100) {
        const batch = entityLinks.slice(i, i + 100)
        for (const el of batch) {
          await kuzuService.createHasEntity(el.report_id, `${el.entity_type}:${el.entity_value}`)
          totalLinks++
        }
        if (i + 100 < entityLinks.length) await new Promise((r) => setImmediate(r))
      }

      // 7. Sync tags
      const tags = db.prepare('SELECT DISTINCT tag FROM intel_tags').all() as Array<{ tag: string }>
      for (const t of tags) {
        await kuzuService.upsertTag(t.tag)
        totalNodes++
      }

      // 8. Sync HAS_TAG relationships
      const tagLinks = db.prepare(
        'SELECT report_id, tag, confidence FROM intel_tags'
      ).all() as Array<{ report_id: string; tag: string; confidence: number }>
      for (let i = 0; i < tagLinks.length; i += 100) {
        const batch = tagLinks.slice(i, i + 100)
        for (const tl of batch) {
          await kuzuService.createHasTag(tl.report_id, tl.tag, tl.confidence)
          totalLinks++
        }
        if (i + 100 < tagLinks.length) await new Promise((r) => setImmediate(r))
      }

      // 9. Sync intel_links
      const intelLinks = db.prepare(
        'SELECT source_report_id, target_report_id, link_type, strength FROM intel_links'
      ).all() as Array<{ source_report_id: string; target_report_id: string; link_type: string; strength: number }>
      for (let i = 0; i < intelLinks.length; i += 100) {
        const batch = intelLinks.slice(i, i + 100)
        for (const l of batch) {
          await kuzuService.createLink(l.source_report_id, l.target_report_id, l.link_type, l.strength)
          totalLinks++
        }
        if (i + 100 < intelLinks.length) await new Promise((r) => setImmediate(r))
      }

      // Record sync timestamp
      const now = timestamp()
      db.prepare(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      ).run('graphSync.lastSynced', String(now), now)

      log.info(`GraphSync complete: ${totalNodes} nodes, ${totalLinks} links`)
    } catch (err) {
      log.error(`GraphSync failed: ${err}`)
    } finally {
      this.syncing = false
    }

    return { nodes: totalNodes, links: totalLinks }
  }

  async incrementalSync(since: number): Promise<number> {
    if (!kuzuService.isReady()) return 0

    const db = getDatabase()
    let synced = 0

    try {
      // Only sync new reports since the given timestamp
      const newReports = db.prepare(
        'SELECT id, title, discipline, severity, source_name, verification_score, created_at FROM intel_reports WHERE created_at > ?'
      ).all(since) as Array<Record<string, unknown>>

      for (const r of newReports) {
        await kuzuService.upsertIntelReport({
          id: r.id as string, title: r.title as string, discipline: r.discipline as string,
          severity: r.severity as string, source: r.source_name as string,
          verification: r.verification_score as number, created_at: r.created_at as number
        })
        synced++
      }

      // Sync new links
      const newLinks = db.prepare(
        'SELECT source_report_id, target_report_id, link_type, strength FROM intel_links WHERE created_at > ?'
      ).all(since) as Array<{ source_report_id: string; target_report_id: string; link_type: string; strength: number }>

      for (const l of newLinks) {
        await kuzuService.createLink(l.source_report_id, l.target_report_id, l.link_type, l.strength)
        synced++
      }

      if (synced > 0) {
        const now = timestamp()
        db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('graphSync.lastSynced', String(now), now)
        log.info(`GraphSync incremental: ${synced} records synced`)
      }
    } catch (err) {
      log.error(`GraphSync incremental failed: ${err}`)
    }

    return synced
  }
}

export const graphSync = new GraphSync()
