import { registerSettingsBridge } from './settingsBridge'
import { registerIntelBridge } from './intelBridge'
import { registerAppBridge } from './appBridge'
import { registerTestConnectionBridge } from './testConnectionBridge'
import { registerSourcesBridge } from './sourcesBridge'
import { registerObsidianBridge } from './obsidianBridge'
import { registerAlertsBridge } from './alertsBridge'
import { registerChatBridge } from './chatBridge'
import { registerEnrichmentBridge } from './enrichmentBridge'
import { registerAuditBridge } from './auditBridge'
import log from 'electron-log'

export function registerAllBridges(): void {
  registerSettingsBridge()
  registerIntelBridge()
  registerAppBridge()
  registerTestConnectionBridge()
  registerSourcesBridge()
  registerObsidianBridge()
  registerAlertsBridge()
  registerChatBridge()
  registerEnrichmentBridge()
  registerAuditBridge()
  log.info('All IPC bridges registered')
}
