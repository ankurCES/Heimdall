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
import { registerMeshtasticBridge } from './meshtasticBridge'
import { registerSyncBridge } from './syncBridge'
import { registerWatchBridge } from './watchBridge'
import { registerMarketsBridge } from './marketsBridge'
import { registerAnalyticsBridge } from './analyticsBridge'
import { registerIwBridge } from './iwBridge'
import { registerAchBridge } from './achBridge'
import { registerExportBridge } from './exportBridge'
import { registerCompartmentBridge } from './compartmentBridge'
import { registerNetworkBridge } from './networkBridge'
import { registerEntityBridge } from './entityBridge'
import { registerCounterintelBridge } from './counterintelBridge'
import { registerCybintBridge } from './cybintBridge'
import { registerSafetyBridge } from './safetyBridge'
import { registerInjectionBridge } from './injectionBridge'
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
  registerMeshtasticBridge()
  registerSyncBridge()
  registerWatchBridge()
  registerMarketsBridge()
  registerAnalyticsBridge()
  registerIwBridge()
  registerAchBridge()
  registerExportBridge()
  registerCompartmentBridge()
  registerNetworkBridge()
  registerEntityBridge()
  registerCounterintelBridge()
  registerCybintBridge()
  registerSafetyBridge()
  registerInjectionBridge()
  log.info('All IPC bridges registered')
}
