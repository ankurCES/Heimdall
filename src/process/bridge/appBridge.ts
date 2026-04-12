import { ipcMain, app } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import log from 'electron-log'

export function registerAppBridge(): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, () => {
    return app.getVersion()
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_PLATFORM, () => {
    return process.platform
  })

  log.info('App bridge registered')
}
