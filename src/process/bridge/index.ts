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
import { registerOvernightBridge } from './overnightBridge'
import { registerGeofenceBridge } from './geofenceBridge'
import { registerAnomalyBridge } from './anomalyBridge'
import { registerImageBridge } from './imageBridge'
import { registerStixBridge } from './stixBridge'
import { registerConsolidationBridge } from './consolidationBridge'
import { registerTradecraftBridge } from './tradecraftBridge'
import { registerPhase5Bridge } from './phase5Bridge'
import { registerRedactionBridge } from './redactionBridge'
import { registerWargameBridge } from './wargameBridge'
import { registerMcpBridge } from './mcpBridge'
import { registerTorBridge } from './torBridge'
import { registerDarkWebBridge } from './darkwebBridge'
import { registerDarkWebExplorerBridge } from './darkwebExplorerBridge'
import { registerTelegramIntelBridge } from './telegramIntelBridge'
import { registerWorkflowBridge } from './workflowBridge'
import { registerTrainingBridge } from './trainingBridge'
import { registerReportsBridge } from './reportsBridge'
import { registerCasesBridge } from './casesBridge'
import { registerCalibrationBridge } from './calibrationBridge'
import { registerSentinelBridge } from './sentinelBridge'
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
  registerOvernightBridge()
  registerGeofenceBridge()
  registerAnomalyBridge()
  registerImageBridge()
  registerStixBridge()
  registerConsolidationBridge()
  registerTradecraftBridge()
  registerPhase5Bridge()
  registerRedactionBridge()
  registerWargameBridge()
  registerMcpBridge()
  registerTorBridge()
  registerDarkWebBridge()
  registerDarkWebExplorerBridge()
  registerTelegramIntelBridge()
  registerWorkflowBridge()
  registerTrainingBridge()
  registerReportsBridge()
  registerCasesBridge()
  registerCalibrationBridge()
  registerSentinelBridge()
  log.info('All IPC bridges registered')
}
