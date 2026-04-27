// Sentinel + Resource Governor IPC bridge.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { serviceRegistry } from '../services/sentinel/ServiceRegistry'
import { sentinelSupervisor } from '../services/sentinel/SentinelSupervisor'
import { resourceGovernor, type ResourceConfig } from '../services/sentinel/ResourceGovernor'

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

  log.info('sentinel bridge registered')
}
