import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  'entity:aliases', 'entity:reports', 'entity:pol', 'entity:timeline',
  'entity:co_mentions', 'entity:geo_pins', 'entity:merge', 'entity:split',
  'entity:watch_add', 'entity:watch_remove', 'entity:watch_status',
  'entity:watch_list', 'entity:watch_set_enabled',
  'graph:list', 'graph:get', 'graph:create_from_entity', 'graph:expand',
  'graph:save', 'graph:delete',
  'ci:analyze', 'ci:latest', 'ci:top', 'ci:for_report',
  'ci:state_media', 'ci:bias_list',
  'cybint:tactics', 'cybint:techniques', 'cybint:tag_techniques',
  'cybint:top_techniques', 'cybint:reports_for_technique',
  'cybint:sync_kev', 'cybint:kev_count', 'cybint:kev_in_corpus',
  'cybint:latest_run', 'cybint:apt_attribute', 'cybint:ioc_pivot',
  'safety:airgap_status', 'safety:apply_airgap',
  'safety:panic_wipe_targets', 'safety:panic_wipe',
  'inj:screen_corpus', 'inj:screen_report', 'inj:release',
  'inj:quarantined', 'inj:flagged', 'inj:latest', 'inj:rules',
  'overnight:run_now', 'overnight:latest', 'overnight:recent',
  'overnight:prune_expired',
  'geofence:list', 'geofence:create', 'geofence:update', 'geofence:delete',
  'geofence:scan', 'geofence:alerts', 'geofence:latest', 'geofence:stats',
  'anomaly:detect', 'anomaly:recent', 'anomaly:latest', 'anomaly:signals',
  'iw:suggest_indicators',
  'image:ingest_file', 'image:ingest_pick', 'image:list', 'image:get', 'image:delete',
  'transcription:ingest_file', 'transcription:ingest_pick', 'transcription:list',
  'transcription:get', 'transcription:delete', 'transcription:test_engine',
  'transcription:translate', 'transcription:save_blob',
  'transcription:ingest_pick_folder', 'transcription:enqueue_paths',
  'transcription:queue_status', 'transcription:queue_cancel', 'transcription:queue_clear',
  'transcription:export', 'transcription:permanently_redact',
  'transcription:engine_stats', 'transcription:purge_now',
  'search:universal',
  'search:saved_list', 'search:saved_create', 'search:saved_update',
  'search:saved_delete', 'search:saved_run', 'search:alerts_run_now',
  'briefing:daily_list', 'briefing:daily_get', 'briefing:daily_generate_now',
  'briefing:daily_delete', 'briefing:daily_export', 'briefing:daily_email',
  'briefing:daily_diff',
  'comparison:list', 'comparison:get', 'comparison:delete',
  'comparison:generate_entities', 'comparison:generate_time_windows',
  'hypothesis:list', 'hypothesis:get', 'hypothesis:create',
  'hypothesis:update', 'hypothesis:delete', 'hypothesis:evidence',
  'hypothesis:set_override', 'hypothesis:evaluate_pair', 'hypothesis:run_now',
  'chronology:list', 'chronology:get', 'chronology:create', 'chronology:update',
  'chronology:delete', 'chronology:add_event', 'chronology:update_event',
  'chronology:remove_event', 'chronology:replace_events', 'chronology:export_markdown',
  'critique:list', 'critique:list_for_parent', 'critique:get', 'critique:delete',
  'critique:create_for_parent', 'critique:create_freeform',
  'models:list', 'models:status', 'models:ensure_required', 'models:download_one',
  'models:reinstall', 'models:cancel', 'models:locate_binary', 'models:install_via_brew',
  'stix:export', 'stix:import', 'stix:import_pick', 'stix:runs',
  'memory:consolidate', 'memory:latest_run', 'memory:recent_runs',
  'tradecraft:adjust_credibility', 'tradecraft:source_trust',
  'tradecraft:manual_demote', 'tradecraft:credibility_events',
  'tradecraft:ach_diagnosticity',
  // Phase 5 sweep
  'briefing:templates_list', 'briefing:template_save', 'briefing:template_delete',
  'briefing:tearline', 'briefing:snapshot', 'briefing:snapshots_list', 'briefing:diff',
  'disinfo:sweep', 'disinfo:clusters', 'disinfo:latest',
  'canary:create', 'canary:list', 'canary:mark', 'canary:scan_corpus',
  'insider:scan', 'insider:recent',
  'influence:simulate',
  'reasoning:for_session', 'reasoning:by_kind',
  'forecast:scenarios', 'forecast:recent_scenarios',
  'conflict:compute', 'conflict:recent', 'conflict:top_regions',
  'detection:generate_sigma', 'detection:generate_yara',
  'detection:list', 'detection:get', 'detection:delete',
  'misp:configured', 'misp:test', 'misp:push', 'misp:pull', 'misp:runs',
  'taxii:status', 'taxii:start', 'taxii:stop', 'taxii:rotate_token', 'taxii:runs',
  'document:ingest_pick', 'document:ingest_file', 'document:list', 'document:get', 'document:delete',
  'image:geolocate',
  'redaction:scan', 'redaction:flag_report', 'redaction:apply',
  'redaction:dismiss', 'redaction:pending', 'redaction:scan_corpus',
  'wargame:start', 'wargame:get', 'wargame:rounds', 'wargame:list',
  'twoperson:status', 'twoperson:set_passphrase', 'twoperson:disable',
  'twoperson:require', 'twoperson:approve', 'twoperson:reject',
  'twoperson:pending', 'twoperson:history',
  'mcp:list_servers', 'mcp:list_tools', 'mcp:add_server',
  'mcp:update_server', 'mcp:remove_server', 'mcp:restart_server', 'mcp:test_server',
  'tor:status', 'tor:connect', 'tor:disconnect', 'tor:health',
  'chat:classifyQuery', 'chat:followUp',
  'chat:planRequest', 'chat:executePlan', 'chat:cancelPlan',
  'llm:routing_matrix', 'llm:enabled_models',
  'darkweb:list', 'darkweb:get_content', 'darkweb:hosts',
  'darkweb:refresh_all', 'darkweb:refresh_status', 'darkweb:cancel_refresh', 'darkweb:tor_status',
  'darkweb:seeds_list', 'darkweb:seeds_categories', 'darkweb:seeds_toggle',
  'darkweb:seeds_add_custom', 'darkweb:seeds_delete', 'darkweb:seeds_run',
  'darkweb:seeds_run_all', 'darkweb:seeds_cancel', 'darkweb:seeds_status',
  'darkweb:explorer_search', 'darkweb:add_from_search', 'darkweb:add_batch_from_search',
  'darkweb:enrich_all', 'darkweb:enrich_status', 'darkweb:enrich_one',
  'darkweb:hosts_health', 'darkweb:hosts_unquarantine',
  'darkweb:tags_for_picker', 'darkweb:enrichment_summary',
  'darkweb:crawler_status', 'darkweb:crawler_toggle', 'darkweb:crawler_reset_visited',
  'darkweb:graph_data',
  'telegram-intel:get_config', 'telegram-intel:set_config', 'telegram-intel:test_token',
  'telegram-intel:start', 'telegram-intel:stop', 'telegram-intel:status',
  'telegram-intel:list', 'telegram-intel:get',
  'telegram-intel:approve', 'telegram-intel:reject',
  'telegram-intel:bulk_approve', 'telegram-intel:bulk_reject',
  'telegram-intel:delete', 'telegram-intel:media_preview', 'telegram-intel:pending_count',
  'workflow:node_types', 'workflow:register_custom_node',
  'workflow:list', 'workflow:get', 'workflow:save', 'workflow:delete',
  'workflow:execute', 'workflow:runs',
  'training:status', 'training:mitre_sync', 'training:misp_sync_all',
  'training:misp_sync_one', 'training:feeds_list', 'training:scan_text',
  'training:crest_ingest', 'training:exemplar_preview', 'training:tradecraft_history',
  'reports:list', 'reports:get', 'reports:search', 'reports:stats',
  'reports:create', 'reports:update', 'reports:delete', 'reports:publish',
  'reports:revise', 'reports:version_chain',
  'reports:promote_one', 'reports:promotion_state', 'reports:promotion_run',
  'reports:export_pdf', 'reports:signing_key_info', 'reports:distribution_log',
  'cases:list', 'cases:get', 'cases:create', 'cases:update', 'cases:delete',
  'cases:list_items', 'cases:add_item', 'cases:remove_item',
  'cases:containing', 'cases:stats',
  'indicators:list', 'indicators:observations', 'indicators:recent_hits',
  'indicators:stats', 'indicators:run_now',
  'sources:reliability_list', 'sources:reliability_claims',
  'sources:reliability_recompute', 'sources:reliability_stats', 'sources:reliability_mark',
  'revisions:pending', 'revisions:pending_count',
  'revisions:acknowledge', 'revisions:dismiss', 'revisions:run_now',
  'ethics:unresolved', 'ethics:flags_for_report', 'ethics:resolve',
  'ethics:stats', 'ethics:rescreen_report',
  'sentinel:services', 'sentinel:restart_history', 'sentinel:restart_service',
  'sentinel:enable_auto_restart', 'sentinel:poll_now', 'sentinel:snapshots',
  'governor:stats', 'governor:usage_by_model', 'governor:usage_by_task',
  'governor:update_config',
  'sentinel:circuits', 'sentinel:circuit_reset',
  'sentinel:dlq_list', 'sentinel:dlq_stats', 'sentinel:dlq_replay', 'sentinel:dlq_discard',
  'escalation:rules', 'escalation:create_rule', 'escalation:update_rule', 'escalation:delete_rule',
  'escalation:on_call', 'escalation:update_on_call',
  'escalation:recent_alerts', 'escalation:stats', 'escalation:acknowledge', 'escalation:poll_now',
  'forecast:claims', 'forecast:stats', 'forecast:record_outcome',
  'forecast:extract', 'forecast:auto_record',
  'audit:anchor_now', 'audit:anchors', 'audit:chain_stats',
  'audit:verify_anchor', 'audit:export_anchors',
  'opsec:config', 'opsec:update', 'opsec:posture',
  'memgraph:snapshot', 'memgraph:neighborhood', 'memgraph:top_central',
  'briefing:build'
]
const allowedChannels = [...Object.values(IPC_CHANNELS), ...testChannels]
const chatEvents = ['chat:chunk', 'chat:done', 'chat:error', 'chat:planRefined']
const darkwebEvents = ['darkweb:refresh_progress', 'darkweb:refresh_complete',
  'darkweb:seed_progress', 'darkweb:enrich_progress', 'darkweb:crawl_progress']
const telegramIntelEvents = ['telegram-intel:status_update', 'telegram-intel:new_message']
const workflowEvents = ['workflow:node_progress', 'workflow:run_complete']
const reportsEvents = ['reports:promotion_progress']
const alertEvents = ['alert:incoming']
const syncEvents = ['sync:progress', 'enrichment:progress', 'watch:hits', 'markets:backfillProgress']
const modelsEvents = ['models:status_update']
const transcriptionEvents = ['transcription:queue_progress', 'transcription:chunk_progress']
const searchEvents = ['search:alert_hit']
const allowedEvents = [...Object.values(IPC_EVENTS), ...chatEvents, ...syncEvents, ...darkwebEvents, ...telegramIntelEvents, ...workflowEvents, ...reportsEvents, ...alertEvents, ...modelsEvents, ...transcriptionEvents, ...searchEvents]

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
  },

  // Resolve the absolute filesystem path of a File dropped onto the
  // renderer. Electron 32+ removed the legacy `File.path` property so
  // contextBridge'd `webUtils.getPathForFile` is the supported route.
  // Used by drag-and-drop ingest UIs (Transcripts, Images, Documents).
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  }
}

contextBridge.exposeInMainWorld('heimdall', api)
