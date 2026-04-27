// Reports Library + Promotion IPC bridge.
//
// Channels:
//   reports:list           → filtered list with paging
//   reports:get            → single report by id
//   reports:search         → FTS5 query
//   reports:stats          → counters for the Library page header
//   reports:create         → manual create (rare; used by tests + workflow)
//   reports:update         → patch metadata (tags, classification, status)
//   reports:delete         → remove (soft via status='superseded' is the
//                            usual path; hard delete only via this channel)
//   reports:publish        → status: draft → published
//   reports:revise         → create new version
//   reports:version_chain  → version history for a report
//
//   reports:promote_one    → manual promotion of a chat message
//
//   reports:promotion_state    → poll the one-shot startup migration
//   reports:promotion_run      → trigger the migration (idempotent;
//                                 always called by main process at boot
//                                 but renderer can re-trigger after reset)
//
// Events emitted:
//   reports:promotion_progress → fired during the startup migration

import { ipcMain, BrowserWindow, dialog } from 'electron'
import { writeFileSync } from 'fs'
import log from 'electron-log'
import { reportLibraryService } from '../services/report/ReportLibraryService'
import { reportPromotionService, type PromotionProgress } from '../services/report/ReportPromotionService'
import { renderReportToPdf } from '../services/report/PdfRenderer'
import { getPublicKeyInfo } from '../services/report/SignatureService'
import { settingsService } from '../services/settings/SettingsService'
import { getDatabase } from '../services/database'
import { generateId } from '@common/utils/id'
import type { LetterheadConfig } from '@common/types/settings'

const DEFAULT_LETTERHEAD: LetterheadConfig = {
  agencyName: '', agencyTagline: '', agencyShortName: '',
  logoBase64: '',
  defaultClassification: 'UNCLASSIFIED//FOR OFFICIAL USE ONLY',
  distributionStatement: 'Distribution authorized for official use only. Reproduction prohibited without originator approval.',
  footerText: '', signaturesEnabled: true
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* */ }
  }
}

let migrationInFlight = false

export function registerReportsBridge(): void {
  // ── Library CRUD/search ─────────────────────────────────────────────

  ipcMain.handle('reports:list', async (_e, filters = {}) => {
    try {
      return { ok: true, ...reportLibraryService.list(filters) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:get', async (_e, id: string) => {
    try {
      const r = reportLibraryService.get(id)
      return r ? { ok: true, report: r } : { ok: false, error: 'not_found' }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:search', async (_e, params: { query: string; limit?: number }) => {
    try {
      return { ok: true, ...reportLibraryService.search(params.query, params.limit) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:stats', async () => {
    try {
      return { ok: true, ...reportLibraryService.stats() }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:create', async (_e, input) => {
    try {
      const r = reportLibraryService.create(input)
      return { ok: true, report: r }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:update', async (_e, params: { id: string; patch: Record<string, unknown> }) => {
    try {
      const r = reportLibraryService.update(params.id, params.patch)
      return r ? { ok: true, report: r } : { ok: false, error: 'not_found' }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:delete', async (_e, id: string) => {
    try {
      return { ok: reportLibraryService.delete(id) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:publish', async (_e, id: string) => {
    try {
      const r = reportLibraryService.publish(id)
      if (!r) return { ok: false, error: 'not_found' }

      // Fire-and-forget post-publish hooks: ethics screening + indicator
      // extraction. These can take seconds (LLM calls) so we don't block
      // the publish response on them. Errors are logged but never reach
      // the user — this is background quality work.
      setImmediate(async () => {
        try {
          const { ethicsGuardrailsService } = await import('../services/ethics/EthicsGuardrailsService')
          await ethicsGuardrailsService.screenReport(r)
        } catch (err) { log.warn(`post-publish ethics screen failed: ${err}`) }
        try {
          const { indicatorExtractor } = await import('../services/calibration/IndicatorExtractor')
          const n = await indicatorExtractor.extractAndPersist(r)
          if (n > 0) log.info(`Extracted ${n} indicators from report ${r.id}`)
        } catch (err) { log.warn(`post-publish indicator extract failed: ${err}`) }
      })

      return { ok: true, report: r }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:revise', async (_e, params: { parentId: string; bodyMarkdown: string }) => {
    try {
      const r = reportLibraryService.revise(params.parentId, params.bodyMarkdown)
      return r ? { ok: true, report: r } : { ok: false, error: 'not_found' }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:version_chain', async (_e, id: string) => {
    try {
      return { ok: true, chain: reportLibraryService.versionChain(id) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Promotion (chat → library) ──────────────────────────────────────

  ipcMain.handle('reports:promote_one', async (_e, params: { messageId: string; force?: boolean }) => {
    try {
      const id = reportPromotionService.promoteOne(params.messageId, { force: params.force })
      return id ? { ok: true, reportId: id } : { ok: false, error: 'not_promotable' }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:promotion_state', async () => {
    try {
      return { ok: true, state: reportPromotionService.getState() }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // ── PDF export + signing key info ───────────────────────────────────

  ipcMain.handle('reports:export_pdf', async (_e, params: {
    reportId: string
    recipient?: string
    classificationOverride?: string
  }) => {
    try {
      const report = reportLibraryService.get(params.reportId)
      if (!report) return { ok: false, error: 'report not found' }

      const letterhead = settingsService.get<LetterheadConfig>('letterhead') || DEFAULT_LETTERHEAD

      // Show save dialog
      const safeTitle = report.title.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60)
      const defaultName = `HEIM-${report.id.slice(0, 8).toUpperCase()}_${safeTitle}.pdf`
      const result = await dialog.showSaveDialog({
        title: 'Export report as PDF',
        defaultPath: defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }

      const rendered = await renderReportToPdf(report, letterhead, {
        recipient: params.recipient,
        classificationOverride: params.classificationOverride
      })

      writeFileSync(result.filePath, Buffer.from(rendered.bytes))

      // Distribution-log entry
      try {
        getDatabase().prepare(`
          INSERT INTO report_distributions
            (id, report_id, format, recipient, signature_sha, signature_b64, exported_at, exported_by)
          VALUES (?, ?, 'pdf', ?, ?, ?, ?, ?)
        `).run(
          generateId(),
          params.reportId,
          params.recipient || null,
          rendered.signature?.sha256 || '',
          rendered.signature?.signatureB64 || null,
          Date.now(),
          'analyst'
        )
      } catch (dbErr) { log.debug(`distribution insert failed: ${dbErr}`) }

      return {
        ok: true,
        path: result.filePath,
        pageCount: rendered.pageCount,
        sha256: rendered.signature?.sha256,
        fingerprint: rendered.signature?.fingerprint
      }
    } catch (err) {
      log.error(`reports:export_pdf failed: ${err}`)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('reports:signing_key_info', async () => {
    try {
      const info = await getPublicKeyInfo()
      return { ok: true, ...info }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:distribution_log', async (_e, reportId: string) => {
    try {
      const rows = getDatabase().prepare(`
        SELECT id, format, recipient, signature_sha, exported_at, exported_by
        FROM report_distributions
        WHERE report_id = ? ORDER BY exported_at DESC
      `).all(reportId) as Array<{
        id: string; format: string; recipient: string | null;
        signature_sha: string; exported_at: number; exported_by: string | null
      }>
      return { ok: true, log: rows }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('reports:promotion_run', async () => {
    if (migrationInFlight) {
      return { ok: false, error: 'migration_in_flight', state: reportPromotionService.getState() }
    }
    migrationInFlight = true
    try {
      const state = await reportPromotionService.runStartupMigration((p) => {
        broadcast('reports:promotion_progress', p)
      })
      return { ok: true, state }
    } catch (err) {
      return { ok: false, error: String(err) }
    } finally {
      migrationInFlight = false
    }
  })

  log.info('reports bridge registered')
}

/**
 * Kick off the startup promotion migration in the background. Called from
 * the main process boot. Streams progress to any open renderer windows.
 *
 * Wrapped in a try/catch + setImmediate so a slow/failing migration can
 * never block app boot.
 */
export function startReportPromotionMigration(): void {
  if (migrationInFlight) return
  setImmediate(async () => {
    const state = reportPromotionService.getState()
    if (state.status === 'complete') {
      log.debug('Report promotion migration already complete — skipping')
      return
    }
    migrationInFlight = true
    try {
      await reportPromotionService.runStartupMigration((p: PromotionProgress) => {
        broadcast('reports:promotion_progress', p)
      })
    } catch (err) {
      log.error(`Report promotion migration failed: ${err}`)
    } finally {
      migrationInFlight = false
    }
  })
}
