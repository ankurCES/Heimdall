// Calibration + ethics IPC bridge — covers Phase 1.1.5 / 1.1.6 / 1.1.7 /
// 1.1.8 endpoints in one file. All channels namespaced as
// indicators:* / sources:* / revisions:* / ethics:*.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { indicatorTrackerService } from '../services/calibration/IndicatorTrackerService'
import { sourceReliabilityService } from '../services/calibration/SourceReliabilityService'
import { autoRevisionService } from '../services/calibration/AutoRevisionService'
import { ethicsGuardrailsService, type EthicsSeverity } from '../services/ethics/EthicsGuardrailsService'
import { reportLibraryService } from '../services/report/ReportLibraryService'

export function registerCalibrationBridge(): void {
  // ── Indicators (Phase 1.1.5) ────────────────────────────────────────
  ipcMain.handle('indicators:list', async () => {
    try { return { ok: true, indicators: indicatorTrackerService.listActiveIndicators() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('indicators:observations', async (_e, indicatorId: string) => {
    try { return { ok: true, observations: indicatorTrackerService.observationsFor(indicatorId) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('indicators:recent_hits', async (_e, limit: number = 50) => {
    try { return { ok: true, hits: indicatorTrackerService.recentHits(limit) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('indicators:stats', async () => {
    try { return { ok: true, ...indicatorTrackerService.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('indicators:run_now', async () => {
    try { return { ok: true, ...await indicatorTrackerService.runOnce() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Source Reliability (Phase 1.1.6) ────────────────────────────────
  ipcMain.handle('sources:reliability_list', async (_e, filter = {}) => {
    try { return { ok: true, sources: sourceReliabilityService.list(filter) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sources:reliability_claims', async (_e, sourceKey: string) => {
    try { return { ok: true, claims: sourceReliabilityService.claimsFor(sourceKey) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sources:reliability_recompute', async () => {
    try { return { ok: true, ...sourceReliabilityService.recomputeAll() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sources:reliability_stats', async () => {
    try { return { ok: true, ...sourceReliabilityService.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sources:reliability_mark', async (_e, params: {
    claimId: string; status: 'confirmed' | 'contradicted'; evidence?: string
  }) => {
    try {
      if (params.status === 'confirmed') {
        sourceReliabilityService.markConfirmed(params.claimId, params.evidence)
      } else {
        sourceReliabilityService.markContradicted(params.claimId, params.evidence)
      }
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Auto-revision (Phase 1.1.7) ─────────────────────────────────────
  ipcMain.handle('revisions:pending', async () => {
    try { return { ok: true, revisions: autoRevisionService.pendingRevisions() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('revisions:pending_count', async () => {
    try { return { ok: true, count: autoRevisionService.pendingCount() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('revisions:acknowledge', async (_e, params: { id: string; notes?: string }) => {
    try { return { ok: autoRevisionService.acknowledge(params.id, params.notes) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('revisions:dismiss', async (_e, params: { id: string; notes?: string }) => {
    try { return { ok: autoRevisionService.dismiss(params.id, params.notes) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('revisions:run_now', async () => {
    try { return { ok: true, ...await autoRevisionService.runOnce() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // ── Ethics (Phase 1.1.8) ────────────────────────────────────────────
  ipcMain.handle('ethics:unresolved', async (_e, filter: { severity?: EthicsSeverity[] } = {}) => {
    try { return { ok: true, flags: ethicsGuardrailsService.unresolvedFlags(filter) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('ethics:flags_for_report', async (_e, reportId: string) => {
    try { return { ok: true, flags: ethicsGuardrailsService.flagsForReport(reportId) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('ethics:resolve', async (_e, params: {
    flagId: string; action: 'overridden' | 'redacted' | 'dismissed'; notes?: string
  }) => {
    try { return { ok: ethicsGuardrailsService.resolve(params.flagId, params.action, params.notes) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('ethics:stats', async () => {
    try { return { ok: true, ...ethicsGuardrailsService.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('ethics:rescreen_report', async (_e, reportId: string) => {
    try {
      const r = reportLibraryService.get(reportId)
      if (!r) return { ok: false, error: 'not_found' }
      return { ok: true, ...await ethicsGuardrailsService.screenReport(r) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  log.info('calibration + ethics bridge registered')
}
