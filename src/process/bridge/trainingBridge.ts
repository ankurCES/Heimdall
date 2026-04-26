// IPC bridge for training-corpus + threat-feed control. Keeps long-running
// ingest tasks off the renderer thread and surfaces status for the Settings
// UI (Phase 4) plus quick-action buttons.
//
// Channels:
//   training:status              → counts, last sync per feed, MITRE coverage
//   training:mitre_sync          → fire MITRE ATT&CK pull (returns stats)
//   training:misp_sync_all       → fire all enabled MISP feeds
//   training:misp_sync_one       → fire single feed by id
//   training:feeds_list          → list configured feeds + their state
//   training:scan_text           → ad-hoc IOC extraction from text (debug aid)

import { ipcMain } from 'electron'
import log from 'electron-log'
import { mitreIngester } from '../services/training/MitreIngester'
import { mispFeedIngester, DEFAULT_MISP_FEEDS } from '../services/training/MispFeedIngester'
import { threatFeedMatcher } from '../services/training/ThreatFeedMatcher'
import { crestIngester } from '../services/training/CrestIngester'
import { exemplarSelector } from '../services/training/ExemplarSelector'

let inFlight = new Set<string>()

export function registerTrainingBridge(): void {
  ipcMain.handle('training:status', async () => {
    try {
      const mitre = mitreIngester.getStatus()
      const misp = mispFeedIngester.getStatus()
      const overall = threatFeedMatcher.getStats()
      const crest = crestIngester.getStatus()
      const exemplars = exemplarSelector.getStatus()
      return {
        ok: true,
        mitre,
        misp,
        overall,
        crest,
        exemplars,
        inFlight: Array.from(inFlight)
      }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('training:crest_ingest', async (_evt, params: {
    topic: string; maxDocs?: number; era?: string; docType?: string
  }) => {
    if (!params.topic || params.topic.trim().length < 2) {
      return { ok: false, error: 'topic must be at least 2 characters' }
    }
    const key = `crest:${params.topic}`
    if (inFlight.has(key)) return { ok: false, error: 'CREST ingest for this topic already in progress' }
    inFlight.add(key)
    try {
      const stats = await crestIngester.ingest({
        topic: params.topic.trim(),
        maxDocs: params.maxDocs,
        era: params.era,
        docType: params.docType
      })
      return { ok: true, stats }
    } catch (err) {
      log.error(`training:crest_ingest failed: ${err}`)
      return { ok: false, error: String(err) }
    } finally {
      inFlight.delete(key)
    }
  })

  ipcMain.handle('training:exemplar_preview', async (_evt, params: {
    format: 'nie' | 'pdb' | 'iir' | 'assessment'
    query: string
  }) => {
    try {
      const exemplars = exemplarSelector.select(params.format, params.query || '')
      return { ok: true, exemplars }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Tradecraft compliance history — most-recent N scored reports + trend stats
  ipcMain.handle('training:tradecraft_history', async (_evt, params: { limit?: number } = {}) => {
    try {
      const { getDatabase } = await import('../services/database')
      const db = getDatabase()
      const limit = Math.max(1, Math.min(200, params.limit || 50))
      const rows = db.prepare(`
        SELECT id, report_format AS format, tradecraft_score AS score,
               deficiencies_json, regenerated, created_at
        FROM report_quality_scores
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit) as Array<{
        id: string; format: string; score: number;
        deficiencies_json: string | null; regenerated: number; created_at: number
      }>
      const items = rows.map((r) => ({
        id: r.id, format: r.format, score: r.score, regenerated: !!r.regenerated,
        createdAt: r.created_at,
        deficiencyCount: r.deficiencies_json ? JSON.parse(r.deficiencies_json).length : 0
      }))
      const stats = items.length === 0 ? null : {
        averageScore: Math.round(items.reduce((s, x) => s + x.score, 0) / items.length),
        passingPercent: Math.round(100 * items.filter((x) => x.score >= 70).length / items.length),
        regeneratedCount: items.filter((x) => x.regenerated).length,
        totalScored: items.length
      }
      return { ok: true, items, stats }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('training:mitre_sync', async () => {
    if (inFlight.has('mitre')) return { ok: false, error: 'MITRE sync already in progress' }
    inFlight.add('mitre')
    try {
      const stats = await mitreIngester.run()
      return { ok: true, stats }
    } catch (err) {
      log.error(`training:mitre_sync failed: ${err}`)
      return { ok: false, error: String(err) }
    } finally {
      inFlight.delete('mitre')
    }
  })

  ipcMain.handle('training:misp_sync_all', async () => {
    if (inFlight.has('misp:all')) return { ok: false, error: 'MISP sync already in progress' }
    inFlight.add('misp:all')
    try {
      const results = await mispFeedIngester.runAll()
      return { ok: true, results }
    } catch (err) {
      log.error(`training:misp_sync_all failed: ${err}`)
      return { ok: false, error: String(err) }
    } finally {
      inFlight.delete('misp:all')
    }
  })

  ipcMain.handle('training:misp_sync_one', async (_evt, params: { feedId: string }) => {
    const feed = DEFAULT_MISP_FEEDS.find((f) => f.id === params.feedId)
    if (!feed) return { ok: false, error: `unknown feed: ${params.feedId}` }
    const key = `misp:${feed.id}`
    if (inFlight.has(key)) return { ok: false, error: 'sync already in progress' }
    inFlight.add(key)
    try {
      const stats = await mispFeedIngester.runFeed(feed)
      return { ok: true, stats }
    } catch (err) {
      log.error(`training:misp_sync_one(${params.feedId}) failed: ${err}`)
      return { ok: false, error: String(err) }
    } finally {
      inFlight.delete(key)
    }
  })

  ipcMain.handle('training:feeds_list', async () => {
    return { ok: true, feeds: DEFAULT_MISP_FEEDS }
  })

  ipcMain.handle('training:scan_text', async (_evt, params: { text: string }) => {
    try {
      const matches = threatFeedMatcher.scanText(params.text || '')
      return { ok: true, matches }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  log.info('training bridge registered')
}
