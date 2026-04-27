// Sentinel + Resource Governor IPC bridge.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { serviceRegistry } from '../services/sentinel/ServiceRegistry'
import { sentinelSupervisor } from '../services/sentinel/SentinelSupervisor'
import { resourceGovernor, type ResourceConfig } from '../services/sentinel/ResourceGovernor'
import { circuitBreaker } from '../services/sentinel/CircuitBreaker'
import { deadLetterQueue } from '../services/sentinel/DeadLetterQueue'
import { alertEscalationService, type EscalationRule, type OnCallConfig } from '../services/alerts/escalation/AlertEscalationService'

export function registerSentinelBridge(): void {
  ipcMain.handle('sentinel:services', async () => {
    try {
      return { ok: true, services: serviceRegistry.allHealth() }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sentinel:restart_history', async (_e, limit: number = 50) => {
    try { return { ok: true, history: serviceRegistry.recentRestarts(limit) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sentinel:restart_service', async (_e, serviceId: string) => {
    try { return await sentinelSupervisor.manualRestart(serviceId) }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sentinel:enable_auto_restart', async (_e, serviceId: string) => {
    try {
      serviceRegistry.enableAutoRestart(serviceId)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sentinel:poll_now', async () => {
    try { await sentinelSupervisor.poll(); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('sentinel:snapshots', async (_e, limit: number = 60) => {
    try { return { ok: true, snapshots: sentinelSupervisor.recentSnapshots(limit) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // Resource Governor
  ipcMain.handle('governor:stats', async () => {
    try { return { ok: true, ...resourceGovernor.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('governor:usage_by_model', async (_e, hours: number = 24) => {
    try { return { ok: true, models: resourceGovernor.usageByModel(hours) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('governor:usage_by_task', async (_e, hours: number = 24) => {
    try { return { ok: true, tasks: resourceGovernor.usageByTask(hours) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('governor:update_config', async (_e, patch: Partial<ResourceConfig>) => {
    try {
      resourceGovernor.updateConfig(patch)
      return { ok: true, config: resourceGovernor.config() }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  // Circuit breakers
  ipcMain.handle('sentinel:circuits', async () => {
    try { return { ok: true, circuits: circuitBreaker.list() } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('sentinel:circuit_reset', async (_e, circuitId: string) => {
    try { circuitBreaker.reset(circuitId); return { ok: true } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // Dead-letter queue
  ipcMain.handle('sentinel:dlq_list', async (_e, filter = {}) => {
    try { return { ok: true, entries: deadLetterQueue.list(filter) } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('sentinel:dlq_stats', async () => {
    try { return { ok: true, ...deadLetterQueue.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('sentinel:dlq_replay', async (_e, id: string) => {
    try { return await deadLetterQueue.replay(id) }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('sentinel:dlq_discard', async (_e, id: string) => {
    try { return { ok: deadLetterQueue.discard(id) } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  // Alert escalation
  ipcMain.handle('escalation:rules', async () => {
    try { return { ok: true, rules: alertEscalationService.listRules() } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:create_rule', async (_e, rule: Omit<EscalationRule, 'id' | 'createdAt' | 'updatedAt'>) => {
    try { return { ok: true, rule: alertEscalationService.createRule(rule) } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:update_rule', async (_e, params: { id: string; patch: Partial<EscalationRule> }) => {
    try {
      const r = alertEscalationService.updateRule(params.id, params.patch)
      return r ? { ok: true, rule: r } : { ok: false, error: 'not_found' }
    } catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:delete_rule', async (_e, id: string) => {
    try { return { ok: alertEscalationService.deleteRule(id) } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:on_call', async () => {
    try { return { ok: true, config: alertEscalationService.getOnCallConfig() } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:update_on_call', async (_e, patch: Partial<OnCallConfig>) => {
    try { return { ok: true, config: alertEscalationService.updateOnCallConfig(patch) } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:recent_alerts', async (_e, limit: number = 50) => {
    try { return { ok: true, alerts: alertEscalationService.recentAlerts(limit) } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:stats', async () => {
    try { return { ok: true, ...alertEscalationService.stats() } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:acknowledge', async (_e, params: { alertId: string; notes?: string }) => {
    try { return { ok: alertEscalationService.acknowledge(params.alertId, 'analyst', params.notes) } }
    catch (err) { return { ok: false, error: String(err) } }
  })
  ipcMain.handle('escalation:poll_now', async () => {
    try { return { ok: true, ...await alertEscalationService.poll() } }
    catch (err) { return { ok: false, error: String(err) } }
  })

  log.info('sentinel bridge registered')
}
