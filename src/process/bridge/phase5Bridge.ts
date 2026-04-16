import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import path from 'path'
import log from 'electron-log'

/** Validate user-supplied paths stay within the home directory. */
function validatePath(p: string): string {
  const resolved = path.resolve(p)
  const home = app.getPath('home')
  if (!resolved.startsWith(home)) {
    throw new Error(`Path traversal blocked: ${resolved} is outside ${home}`)
  }
  return resolved
}

import { briefingService } from '../services/briefing/BriefingService'
import { disinfoService, canaryService, insiderThreatService } from '../services/counterintel/DisinfoService'
import { influenceService, reasoningGraphService } from '../services/graph/InfluenceService'
import { forecastService, conflictService } from '../services/forecast/ForecastService'
import { detectionRuleService } from '../services/detection/DetectionRuleService'
import { mispService } from '../services/misp/MispService'
import { taxiiServer } from '../services/taxii/TaxiiServer'
import { documentOcrService } from '../services/document/DocumentOcrService'

/**
 * Phase 5 sweep bridge — all IPC channels for batches 5C – 5J in one file
 * to avoid bridge sprawl.
 */
export function registerPhase5Bridge(): void {
  // 5C briefing
  ipcMain.handle('briefing:templates_list', () => briefingService.listTemplates())
  ipcMain.handle('briefing:template_save', (_e, input: { id?: string; name: string; body_md: string; is_default?: boolean }) => briefingService.saveTemplate(input))
  ipcMain.handle('briefing:template_delete', (_e, id: string) => { briefingService.deleteTemplate(id); return { ok: true } })
  ipcMain.handle('briefing:tearline', async (_e, args: { body_md: string; release_marking: string; target_classification?: string }) => await briefingService.tearline(args))
  ipcMain.handle('briefing:snapshot', (_e, args?: { label?: string }) => briefingService.snapshot(args?.label))
  ipcMain.handle('briefing:snapshots_list', () => briefingService.listSnapshots())
  ipcMain.handle('briefing:diff', (_e, args: { from_id: string; to_id?: string }) => briefingService.diff(args.from_id, args.to_id))

  // 5D disinfo + insider + canary
  ipcMain.handle('disinfo:sweep', (_e, args?: { window_hours?: number }) => disinfoService.sweep(args?.window_hours ?? 48))
  ipcMain.handle('disinfo:clusters', (_e, args?: { limit?: number }) => disinfoService.recentClusters(args?.limit ?? 50))
  ipcMain.handle('disinfo:latest', () => disinfoService.latestRun())
  ipcMain.handle('canary:create', (_e, args: { label: string; artifact_type?: string; artifact_id?: string }) =>
    canaryService.create(args.label, args.artifact_type, args.artifact_id)
  )
  ipcMain.handle('canary:list', () => canaryService.list())
  ipcMain.handle('canary:mark', (_e, args: { id: string; source: string; notes?: string }) => {
    canaryService.markObserved(args.id, args.source, args.notes); return { ok: true }
  })
  ipcMain.handle('canary:scan_corpus', () => canaryService.scanCorpus())
  ipcMain.handle('insider:scan', () => insiderThreatService.scan())
  ipcMain.handle('insider:recent', (_e, args?: { limit?: number }) => insiderThreatService.recent(args?.limit ?? 50))

  // 5E influence + reasoning
  ipcMain.handle('influence:simulate', (_e, args: { seed_node_id: string; max_steps?: number; trials?: number; seed?: number }) =>
    influenceService.simulate(args.seed_node_id, { max_steps: args.max_steps, trials: args.trials, seed: args.seed })
  )
  ipcMain.handle('reasoning:for_session', (_e, args: { session_id: string; limit?: number }) =>
    reasoningGraphService.forSession(args.session_id, args.limit ?? 500)
  )
  ipcMain.handle('reasoning:by_kind', (_e, args: { kind: string; limit?: number }) =>
    reasoningGraphService.byKind(args.kind, args.limit ?? 100)
  )

  // 5F forecast + conflict
  ipcMain.handle('forecast:scenarios', async (_e, args: { topic: string; event_id?: string | null }) =>
    await forecastService.scenarios(args.topic, args.event_id)
  )
  ipcMain.handle('forecast:recent_scenarios', (_e, args?: { limit?: number }) =>
    forecastService.recentScenarios(args?.limit ?? 30)
  )
  ipcMain.handle('conflict:compute', (_e, args?: { window_days?: number }) =>
    conflictService.compute(args?.window_days ?? 14)
  )
  ipcMain.handle('conflict:recent', (_e, args?: { region?: string; limit?: number }) =>
    conflictService.recent(args?.region, args?.limit ?? 100)
  )
  ipcMain.handle('conflict:top_regions', (_e, args?: { limit?: number }) =>
    conflictService.topRegions(args?.limit ?? 15)
  )

  // 5G detection rules
  ipcMain.handle('detection:generate_sigma', async (_e, reportId: string) => await detectionRuleService.generateSigma(reportId))
  ipcMain.handle('detection:generate_yara', async (_e, reportId: string) => await detectionRuleService.generateYara(reportId))
  ipcMain.handle('detection:list', (_e, args?: { kind?: 'sigma' | 'yara'; limit?: number }) => detectionRuleService.list(args?.kind, args?.limit ?? 100))
  ipcMain.handle('detection:get', (_e, id: string) => detectionRuleService.get(id))
  ipcMain.handle('detection:delete', (_e, id: string) => { detectionRuleService.delete(id); return { ok: true } })

  // 5H MISP
  ipcMain.handle('misp:configured', () => mispService.configured())
  ipcMain.handle('misp:test', async () => await mispService.testConnection())
  ipcMain.handle('misp:push', async (_e, args?: { since_ms?: number; discipline?: string | null }) => await mispService.push(args ?? {}))
  ipcMain.handle('misp:pull', async (_e, args?: { since_ms?: number }) => await mispService.pull(args ?? {}))
  ipcMain.handle('misp:runs', (_e, args?: { limit?: number }) => mispService.recentRuns(args?.limit ?? 50))

  // 5I TAXII
  ipcMain.handle('taxii:status', () => ({ running: taxiiServer.isRunning() }))
  ipcMain.handle('taxii:start', async () => { await taxiiServer.start(); return { ok: true } })
  ipcMain.handle('taxii:stop', async () => { await taxiiServer.stop(); return { ok: true } })
  ipcMain.handle('taxii:rotate_token', () => ({ token: taxiiServer.rotateToken() }))
  ipcMain.handle('taxii:runs', (_e, args?: { limit?: number }) => taxiiServer.recentRuns(args?.limit ?? 50))

  // 5J document OCR
  ipcMain.handle('document:ingest_pick', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select documents to OCR',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return []
    const out = []
    for (const p of res.filePaths) {
      try { out.push(await documentOcrService.ingest(p)) }
      catch (err) { log.warn(`document:ingest skipping ${path.basename(p)}: ${(err as Error).message}`) }
    }
    return out
  })
  ipcMain.handle('document:ingest_file', async (_e, args: { path: string; report_id?: string | null }) =>
    await documentOcrService.ingest(validatePath(args.path), { report_id: args.report_id ?? null })
  )
  ipcMain.handle('document:list', (_e, args?: { limit?: number }) => documentOcrService.list(args?.limit ?? 100))
  ipcMain.handle('document:get', (_e, id: string) => documentOcrService.get(id))
  ipcMain.handle('document:delete', (_e, id: string) => { documentOcrService.remove(id); return { ok: true } })

  log.info('phase 5 sweep bridge registered (briefing + disinfo + insider + canary + influence + reasoning + forecast + conflict + detection + misp + taxii + document)')
}
