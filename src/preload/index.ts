import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '@common/adapter/ipcBridge'

const testChannels = [
  'settings:testSmtp', 'settings:testTelegram', 'settings:testMeshtastic', 'settings:testObsidian',
  'obsidian:testConnection', 'obsidian:listFiles', 'obsidian:readFile',
  'obsidian:search', 'obsidian:getTags', 'obsidian:openInObsidian',
  'obsidian:bulkImport', 'obsidian:manualSync', 'obsidian:needsInitialImport',
  'alerts:getRules', 'alerts:saveRules'
]
const allowedChannels = [...Object.values(IPC_CHANNELS), ...testChannels]
const allowedEvents = Object.values(IPC_EVENTS)

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!allowedChannels.includes(channel as never)) {
      throw new Error(`IPC channel not allowed: ${channel}`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on: (event: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (!allowedEvents.includes(event as never)) {
      throw new Error(`IPC event not allowed: ${event}`)
    }
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  },

  once: (event: string, callback: (...args: unknown[]) => void): void => {
    if (!allowedEvents.includes(event as never)) {
      throw new Error(`IPC event not allowed: ${event}`)
    }
    ipcRenderer.once(event, (_event, ...args) => callback(...args))
  }
}

contextBridge.exposeInMainWorld('heimdall', api)
