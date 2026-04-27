// v1.3 calibration + hardening IPC bridge.
// (Renamed file vs. calibrationBridge to avoid clashing with the v1.1
// calibration bridge that handles indicators / source reliability /
// auto-revision / ethics.)

import { ipcMain } from 'electron'
import log from 'electron-log'
import { forecastAccountabilityService, type OutcomeKind } from '../services/forecast/ForecastAccountabilityService'
import { auditChainAnchorService } from '../services/audit/AuditChainAnchorService'
import { opSecService, type OpSecConfig } from '../services/opsec/OpSecService'
import { reportLibraryService } from '../services/report/ReportLibraryService'

export function registerCalibration2Bridge(): void {
  // Forecast Accountability
  ipcMain.handle('forecast:claims', async (_e, reportId?: string) => {
    try {
      if (reportId) return { ok: true, claims: forecastAccountabilityService.claimsFor(reportId) }
      return { ok: true, claims: forecastAccountabilityService.pendingClaims() }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('forecast:stats', async () => {
    try { return { ok: true, ...forecastAccountabilityService.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('forecast:record_outcome', async (_e, opts: {
    claimId: string; outcome: OutcomeKind; actualProbability?: number;
    evidence?: string; sourceIntelId?: string
  }) => {
    try { return forecastAccountabilityService.recordOutcome({ ...opts, recordedBy: 'analyst' }) }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('forecast:extract', async (_e, reportId: string) => {
    try {
      const r = reportLibraryService.get(reportId)
      if (!r) return { ok: false, error: 'not_found' }
      const n = forecastAccountabilityService.extractAndPersist(r)
      return { ok: true, extracted: n }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('forecast:auto_record', async () => {
    try { return { ok: true, ...forecastAccountabilityService.autoRecordFromIndicatorHits() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // Audit chain anchors
  ipcMain.handle('audit:anchor_now', async () => {
    try { return { ok: true, anchor: await auditChainAnchorService.createAnchor() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('audit:anchors', async (_e, limit?: number) => {
    try { return { ok: true, anchors: auditChainAnchorService.recentAnchors(limit) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('audit:chain_stats', async () => {
    try { return { ok: true, ...await auditChainAnchorService.chainStats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('audit:verify_anchor', async (_e, anchorId: string) => {
    try { return { ok: true, ...auditChainAnchorService.verifyAnchor(anchorId) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('audit:export_anchors', async (_e, limit?: number) => {
    try { return { ok: true, ...auditChainAnchorService.exportAnchors(limit) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // OPSEC
  ipcMain.handle('opsec:config', async () => {
    try { return { ok: true, config: opSecService.config() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('opsec:update', async (_e, patch: Partial<OpSecConfig>) => {
    try { return { ok: true, config: opSecService.update(patch) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('opsec:posture', async () => {
    try { return { ok: true, ...opSecService.airGapPosture() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  log.info('calibration2 + audit + opsec bridge registered')
}
