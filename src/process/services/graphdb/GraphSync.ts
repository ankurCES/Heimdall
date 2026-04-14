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

      // 1. Sync intel_reports (paginated to avoid loading all into memory)
      {
        let offset = 0
        const PAGE = 500
        while (true) {
          const batch = db.prepare('SELECT id, title, discipline, severity, source_name, verification_score, created_at FROM intel_reports LIMIT ? OFFSET ?').all(PAGE, offset) as Array<Record<string, unknown>>
          if (batch.length === 0) break
          for (const r of batch) {
            await kuzuService.upsertIntelReport({
              id: r.id as string, title: r.title as string, discipline: r.discipline as string,
              severity: r.severity as string, source: r.source_name as string,
              verification: r.verification_score as number, created_at: r.created_at as number
            })
          }
          totalNodes += batch.length
          offset += PAGE
          await new Promise((r) => setImmediate(r))
        }
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

      // 5. Sync entities (paginated)
      {
        let offset = 0
        const PAGE = 500
        while (true) {
          const batch = db.prepare('SELECT DISTINCT entity_type, entity_value FROM intel_entities LIMIT ? OFFSET ?').all(PAGE, offset) as Array<{ entity_type: string; entity_value: string }>
          if (batch.length === 0) break
          for (const e of batch) {
            const entityId = `${e.entity_type}:${e.entity_value}`
            await kuzuService.upsertEntity({ id: entityId, type: e.entity_type, value: e.entity_value })
            totalNodes++
          }
          offset += PAGE
          await new Promise((r) => setImmediate(r))
        }
      }

      // 6. Sync HAS_ENTITY relationships (paginated)
      {
        let offset = 0
        const PAGE = 500
        while (true) {
          const batch = db.prepare('SELECT report_id, entity_type, entity_value FROM intel_entities LIMIT ? OFFSET ?').all(PAGE, offset) as Array<{ report_id: string; entity_type: string; entity_value: string }>
          if (batch.length === 0) break
          for (const el of batch) {
            await kuzuService.createHasEntity(el.report_id, `${el.entity_type}:${el.entity_value}`)
            totalLinks++
          }
          offset += PAGE
          await new Promise((r) => setImmediate(r))
        }
      }

      // 7. Sync tags (paginated)
      {
        let offset = 0
        const PAGE = 500
        while (true) {
          const batch = db.prepare('SELECT DISTINCT tag FROM intel_tags LIMIT ? OFFSET ?').all(PAGE, offset) as Array<{ tag: string }>
          if (batch.length === 0) break
          for (const t of batch) {
            await kuzuService.upsertTag(t.tag)
            totalNodes++
          }
          offset += PAGE
          await new Promise((r) => setImmediate(r))
        }
      }

      // 8. Sync HAS_TAG relationships (paginated)
      {
        let offset = 0
        const PAGE = 500
        while (true) {
          const batch = db.prepare('SELECT report_id, tag, confidence FROM intel_tags LIMIT ? OFFSET ?').all(PAGE, offset) as Array<{ report_id: string; tag: string; confidence: number }>
          if (batch.length === 0) break
          for (const tl of batch) {
            await kuzuService.createHasTag(tl.report_id, tl.tag, tl.confidence)
            totalLinks++
          }
          offset += PAGE
          await new Promise((r) => setImmediate(r))
        }
      }

      // 9. Sync intel_links (paginated)
      {
        let offset = 0
        const PAGE = 500
        while (true) {
          const batch = db.prepare('SELECT source_report_id, target_report_id, link_type, strength FROM intel_links LIMIT ? OFFSET ?').all(PAGE, offset) as Array<{ source_report_id: string; target_report_id: string; link_type: string; strength: number }>
          if (batch.length === 0) break
          for (const l of batch) {
            await kuzuService.createLink(l.source_report_id, l.target_report_id, l.link_type, l.strength)
            totalLinks++
          }
          offset += PAGE
          await new Promise((r) => setImmediate(r))
        }
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
