import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS } from '@common/adapter/ipcBridge'

const testChannels = [
  'settings:testSmtp', 'settings:testTelegram', 'settings:testMeshtastic', 'settings:testObsidian',
  'obsidian:testConnection', 'obsidian:listFiles', 'obsidian:readFile',
  'obsidian:search', 'obsidian:getTags', 'obsidian:openInObsidian',
  'obsidian:bulkImport', 'obsidian:manualSync', 'obsidian:needsInitialImport',
  'alerts:getRules', 'alerts:saveRules',
  'chat:send', 'chat:getHistory', 'chat:clearHistory', 'chat:getConnections',
  'chat:createSession', 'chat:getSessions', 'chat:renameSession', 'chat:deleteSession',
  'chat:generateDailySummary', 'chat:generateWeeklySummary',
  'chat:savePreliminaryReport', 'chat:getPreliminaryReports', 'chat:getGaps',
  'chat:recordHumint', 'chat:getHumintReports',
  'chat:generateLearnings', 'chat:getVectorStats', 'chat:getTokenStats',
  'chat:getSessionData', 'chat:isIngesting', 'explore:getData',
  'settings:testLlm', 'settings:listLlmModels', 'settings:listSerialPorts',
  'enrichment:getTags', 'enrichment:getEntities', 'enrichment:getLinks',
  'enrichment:getTopTags', 'enrichment:getTopEntities', 'enrichment:getEnrichedReports', 'enrichment:getGraph',
  'meshtastic:getNodes', 'meshtastic:getNodeCount', 'meshtastic:getMessages', 'meshtastic:getRecommendedMode', 'meshtastic:pullDeviceData', 'meshtastic:checkCli', 'meshtastic:discover',
  'sync:getJobs', 'sync:runJob', 'sync:runAll', 'sync:isRunning',
  'watch:getTerms', 'watch:addTerm', 'watch:toggleTerm', 'watch:removeTerm', 'watch:scan',
  'intel:getTrajectories', 'intel:getSourceTypes', 'intel:getDashboardExtras',
  'sources:test', 'sources:listPresets', 'sources:syncAll',
  'markets:getLatestQuotes', 'markets:getHistory', 'markets:getKpis',
  'markets:getMarketIntel', 'markets:getCommodityDetail',
  'markets:backfillHistory', 'markets:backfillStatus',
  'analytics:listReports', 'analytics:getReport', 'analytics:saveReport',
  'analytics:deleteReport', 'analytics:duplicateReport', 'analytics:queryWidget',
  'intel:setClassification',
  'audit:chain:list', 'audit:chain:verify',
  'council:run', 'council:get', 'council:list',
  'iw:events:list', 'iw:events:get', 'iw:events:create', 'iw:events:update', 'iw:events:delete',
  'iw:indicators:add', 'iw:indicators:update', 'iw:indicators:delete', 'iw:indicators:history',
  'iw:evaluate:indicator', 'iw:evaluate:event', 'iw:evaluate:all',
  'dpb:generate', 'dpb:latest', 'dpb:list', 'dpb:get',
  'ach:sessions:list', 'ach:sessions:get', 'ach:sessions:create', 'ach:sessions:update', 'ach:sessions:delete',
  'ach:hypotheses:add', 'ach:hypotheses:update', 'ach:hypotheses:delete',
  'ach:evidence:add', 'ach:evidence:update', 'ach:evidence:delete',
  'ach:scores:set', 'ach:scores:clear', 'ach:agent:generateHypotheses',
  'export:write',
  'compartments:list', 'compartments:list_with_grants', 'compartments:get',
  'compartments:create', 'compartments:update', 'compartments:delete',
  'compartments:grant', 'compartments:revoke', 'compartments:granted_ids',
  'compartments:tag', 'compartments:get_for_artifact',
  'encryption:status', 'encryption:unlock', 'encryption:enable',
  'encryption:change', 'encryption:finish_boot',
  'network:refresh', 'network:latest', 'network:top',
  'network:communities', 'network:node', 'network:search', 'network:predict',
  'entity:resolve', 'entity:latest', 'entity:top', 'entity:types',
  'entity:aliases', 'entity:reports', 'entity:pol',
  'ci:analyze', 'ci:latest', 'ci:top', 'ci:for_report',
  'ci:state_media', 'ci:bias_list',
  'cybint:tactics', 'cybint:techniques', 'cybint:tag_techniques',
  'cybint:top_techniques', 'cybint:reports_for_technique',
  'cybint:sync_kev', 'cybint:kev_count', 'cybint:kev_in_corpus',
  'cybint:latest_run',
  'safety:airgap_status', 'safety:apply_airgap',
  'safety:panic_wipe_targets', 'safety:panic_wipe',
  'inj:screen_corpus', 'inj:screen_report', 'inj:release',
  'inj:quarantined', 'inj:flagged', 'inj:latest', 'inj:rules',
  'overnight:run_now', 'overnight:latest', 'overnight:recent',
  'overnight:prune_expired',
  'geofence:list', 'geofence:create', 'geofence:update', 'geofence:delete',
  'geofence:scan', 'geofence:alerts', 'geofence:latest', 'geofence:stats'
]
const allowedChannels = [...Object.values(IPC_CHANNELS), ...testChannels]
const chatEvents = ['chat:chunk', 'chat:done', 'chat:error']
const syncEvents = ['sync:progress', 'enrichment:progress', 'watch:hits', 'markets:backfillProgress']
const allowedEvents = [...Object.values(IPC_EVENTS), ...chatEvents, ...syncEvents]

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
