import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { settingsService } from '../services/settings/SettingsService'
import { modelRouter } from '../services/llm/ModelRouter'
import log from 'electron-log'

export function registerSettingsBridge(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_event, params: { key: string }) => {
    return settingsService.get(params.key)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, params: { key: string; value: unknown }) => {
    settingsService.set(params.key, params.value)
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_SECTION, (_event, params: { section: string }) => {
    return settingsService.getSection(params.section)
  })

  // Model routing — surface the auto-selected (connection, model) for each
  // task class so the analyst can see exactly which model handles which
  // step in the agentic pipeline.
  ipcMain.handle('llm:routing_matrix', () => {
    return modelRouter.routingMatrix().map(({ task, selection }) => ({
      task,
      connectionName: selection?.connection.name ?? null,
      connectionId: selection?.connection.id ?? null,
      model: selection?.model ?? null,
      reason: selection?.reason ?? null,
      score: selection?.score ?? null
    }))
  })

  ipcMain.handle('llm:enabled_models', () => {
    return modelRouter.enabledModels().map(({ conn, model }) => ({
      connectionId: conn.id, connectionName: conn.name, model
    }))
  })

  log.info('Settings bridge registered')
}
