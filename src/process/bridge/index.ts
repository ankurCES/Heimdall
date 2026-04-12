import { registerSettingsBridge } from './settingsBridge'
import { registerIntelBridge } from './intelBridge'
import { registerAppBridge } from './appBridge'
import { registerTestConnectionBridge } from './testConnectionBridge'
import { registerSourcesBridge } from './sourcesBridge'
import { registerObsidianBridge } from './obsidianBridge'
import log from 'electron-log'

export function registerAllBridges(): void {
  registerSettingsBridge()
  registerIntelBridge()
  registerAppBridge()
  registerTestConnectionBridge()
  registerSourcesBridge()
  registerObsidianBridge()
  log.info('All IPC bridges registered')
}
