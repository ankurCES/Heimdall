import { ipcMain } from 'electron'
import { achService, type Score } from '../services/ach/AchService'
import log from 'electron-log'

/**
 * IPC bridge for the Analysis of Competing Hypotheses workbench
 * (Themes 2.1–2.6 of the agency roadmap).
 */
export function registerAchBridge(): void {
  // Sessions
  ipcMain.handle('ach:sessions:list', (_e, params: { status?: 'open' | 'closed' } = {}) => {
    return achService.listSessions(params)
  })
  ipcMain.handle('ach:sessions:get', (_e, params: { id: string }) => {
    return achService.getSession(params.id)
  })
  ipcMain.handle('ach:sessions:create', (_e, params: {
    title: string; question?: string; chat_session_id?: string;
    preliminary_report_id?: string; classification?: string;
  }) => {
    return achService.createSession(params)
  })
  ipcMain.handle('ach:sessions:update', (_e, params: { id: string; patch: Record<string, unknown> }) => {
    return achService.updateSession(params.id, params.patch)
  })
  ipcMain.handle('ach:sessions:delete', (_e, params: { id: string }) => {
    achService.deleteSession(params.id)
    return { ok: true }
  })

  // Hypotheses
  ipcMain.handle('ach:hypotheses:add', (_e, params: {
    session_id: string; label: string; description?: string; source?: 'analyst' | 'agent'
  }) => {
    return achService.addHypothesis(params)
  })
  ipcMain.handle('ach:hypotheses:update', (_e, params: { id: string; patch: { label?: string; description?: string } }) => {
    return achService.updateHypothesis(params.id, params.patch)
  })
  ipcMain.handle('ach:hypotheses:delete', (_e, params: { id: string }) => {
    achService.deleteHypothesis(params.id)
    return { ok: true }
  })

  // Evidence
  ipcMain.handle('ach:evidence:add', (_e, params: {
    session_id: string; claim: string; source_intel_id?: string; source_humint_id?: string;
    source_label?: string; weight?: number; credibility?: number; notes?: string;
  }) => {
    return achService.addEvidence(params)
  })
  ipcMain.handle('ach:evidence:update', (_e, params: { id: string; patch: Record<string, unknown> }) => {
    return achService.updateEvidence(params.id, params.patch)
  })
  ipcMain.handle('ach:evidence:delete', (_e, params: { id: string }) => {
    achService.deleteEvidence(params.id)
    return { ok: true }
  })

  // Scoring
  ipcMain.handle('ach:scores:set', (_e, params: {
    session_id: string; hypothesis_id: string; evidence_id: string; score: Score; rationale?: string;
  }) => {
    return achService.setScore(params)
  })
  ipcMain.handle('ach:scores:clear', (_e, params: { hypothesis_id: string; evidence_id: string }) => {
    achService.clearScore(params.hypothesis_id, params.evidence_id)
    return { ok: true }
  })

  // AI hypothesis generation (Theme 2.2)
  ipcMain.handle('ach:agent:generateHypotheses', async (_e, params: {
    session_id: string; connectionId?: string; count?: number;
  }) => {
    return achService.generateHypotheses(params.session_id, { connectionId: params.connectionId, count: params.count })
  })

  log.info('ACH bridge registered')
}
