import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { settingsService } from '../services/settings/SettingsService'
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

  log.info('Settings bridge registered')
}
