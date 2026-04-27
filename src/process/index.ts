import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'
import { initDatabase, closeDatabase, isDatabaseReady } from './services/database'
import { registerAllBridges } from './bridge'
import { registerEncryptionBridge } from './bridge/encryptionBridge'
import { encryptionService } from './services/security/EncryptionService'
import { registerAllCollectors } from './collectors/registry'
import { collectorManager } from './collectors/CollectorManager'
import { safeFetcher } from './collectors/SafeFetcher'
import { settingsService } from './services/settings/SettingsService'
import { cronService } from './services/cron/CronService'
import type { SafetyConfig, DarkWebConfig } from '@common/types/settings'
import { seedDefaultSources } from './services/seeder/DefaultSourceSeeder'
import { agentOrchestrator } from './agents/AgentOrchestrator'
import { intelPipeline } from './services/vectordb/IntelPipeline'
import { enrichmentOrchestrator } from './services/enrichment/EnrichmentOrchestrator'
import { resourceManager } from './services/resource/ResourceManager'
import { overnightService } from './services/overnight/OvernightService'
import { consolidationService } from './services/memory/ConsolidationService'
import { disinfoService, insiderThreatService } from './services/counterintel/DisinfoService'
import { conflictService } from './services/forecast/ForecastService'
import { taxiiServer } from './services/taxii/TaxiiServer'
import { registerMediaSchemeAsPrivileged, registerMediaProtocolHandler } from './services/media/MediaProtocolService'

// v1.4.6 — register the heimdall-media:// scheme as privileged BEFORE
// app.whenReady() resolves. The protocol handler itself is wired later
// in initializeDeferred() once the DB is up so transcript/image lookups
// can succeed. This split is mandated by Electron's protocol API.
registerMediaSchemeAsPrivileged()
// Kuzu graph DB removed — buggy native module, dormant for entire history,
// SQLite handled every graph query in practice. See migration 012.

log.transports.file.level = 'info'
log.transports.console.level = 'debug'

// SECURITY (v1.3.2 — finding B3): wire the OPSEC scrubber as an
// electron-log hook. When OpSec mode has scrubLlmLogs on (default in
// paranoid/strict/standard), every log line is run through the scrubber
// before being written. Masks IPs, emails, classification markings,
// SSNs, BTC/CC numbers, hashes. Lazy-loaded to avoid pulling
// OpSecService at very-early boot.
let _opSecScrubber: ((s: string) => string) | null = null
function getScrubber(): ((s: string) => string) | null {
  if (_opSecScrubber !== null) return _opSecScrubber
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const opsec = require('./services/opsec/OpSecService') as typeof import('./services/opsec/OpSecService')
    _opSecScrubber = (s: string): string => {
      try {
        if (!opsec.opSecService.config().scrubLlmLogs) return s
        return opsec.opSecService.scrubForLogging(s)
      } catch { return s }
    }
    return _opSecScrubber
  } catch { return null }
}
log.hooks.push((message) => {
  const scrub = getScrubber()
  if (!scrub) return message
  try {
    message.data = (message.data as unknown[]).map((d) => typeof d === 'string' ? scrub(d) : d)
  } catch { /* */ }
  return message
})

// Global crash handlers — prevent silent process death
process.on('uncaughtException', (err) => {
  log.error(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`)
})
process.on('unhandledRejection', (reason) => {
  log.error(`UNHANDLED REJECTION: ${reason}`)
})

let mainWindow: BrowserWindow | null = null

async function initializeEssentials(): Promise<void> {
  log.info('Heimdall starting — Phase 1: Essentials')

  // Encryption gate: if the user has enabled at-rest encryption, the DB stays
  // locked until the renderer hands us a passphrase via encryption:unlock.
  // In that mode we register only the encryption bridge; the rest wait until
  // unlock completes (see initializeAfterUnlock below).
  if (encryptionService.isEnabled()) {
    log.info('Encryption is enabled — deferring DB init until unlock')
    registerEncryptionBridge()
    return
  }

  initDatabase()
  registerEncryptionBridge()
  registerAllBridges()

  log.info('Essentials initialized')
}

async function initializeAfterUnlock(): Promise<void> {
  log.info('Heimdall — finishing boot after unlock')
  // DB was opened by encryptionService.unlock() during the unlock call.
  if (!isDatabaseReady()) {
    log.error('initializeAfterUnlock called with no live DB — aborting')
    return
  }
  registerAllBridges()
  await initializeDeferred()
  log.info('Post-unlock boot complete')
}

async function initializeDeferred(): Promise<void> {
  log.info('Heimdall — Phase 2: Deferred initialization')

  // Apply safety settings to SafeFetcher
  const safety = settingsService.get<SafetyConfig>('safety')
  if (safety) {
    safeFetcher.setRate(safety.rateLimitPerDomain || 30)
    safeFetcher.setRobotsEnabled(safety.respectRobotsTxt ?? true)
    safeFetcher.setAirGap(safety.airGapMode ?? false, safety.airGapAllowlist ?? [])
  }

  // Dark-web SOCKS5 proxy (Tor) — only enabled when the user opts in.
  // After binding SafeFetcher, also probe + register the running Tor with
  // TorService so its `getState()` reflects reality. Without this, the
  // chat-time `onion_fetch` tool's pre-check would reject calls (state
  // stays 'stopped' across restarts even though the proxy IS bound from
  // settings) — analyst would have to manually click "Connect to Tor"
  // every restart. Probe is non-blocking + best-effort.
  const darkWeb = settingsService.get<DarkWebConfig>('darkWeb')
  if (darkWeb?.enabled) {
    safeFetcher.setSocks5(darkWeb.socks5Host || '127.0.0.1', darkWeb.socks5Port || 9050)
    log.info(`darkweb: SOCKS5 proxy enabled at ${darkWeb.socks5Host || '127.0.0.1'}:${darkWeb.socks5Port || 9050}`)
    // Sync TorService state so onion_fetch's pre-check sees a live Tor.
    void (async () => {
      try {
        const { torService } = await import('./services/darkweb/TorService')
        const r = await torService.connect()
        if (r.ok) log.info(`darkweb: Tor auto-attached (${r.mode})`)
        else log.debug(`darkweb: Tor auto-attach failed (${r.error}) — analyst must connect manually`)
      } catch (err) {
        log.debug(`darkweb: Tor auto-attach exception: ${err}`)
      }
    })()
  }

  // MCP servers — spawn child processes for each enabled server, register
  // their tools in ToolRegistry. Lazy import to keep bootstrap light.
  try {
    const { mcpClientService } = await import('./services/mcp/McpClientService')
    void mcpClientService.start()
      .then(async () => {
        // After MCP tools are registered, expose them as workflow nodes.
        try {
          const mod = await import('./services/workflow/NodeRegistry')
          mod.registerMcpToolNodes()
        } catch (err) { log.debug(`registerMcpToolNodes: ${err}`) }
      })
      .catch((err) => log.warn(`mcp.start failed: ${err}`))
  } catch (err) {
    log.warn(`mcp service load failed: ${err}`)
  }

  // Seed default sources on first run
  seedDefaultSources()

  // Register all collector factories
  registerAllCollectors()

  // v1.4 — register premium OSINT integrations as agent-callable tools
  // (Shodan, VirusTotal, GreyNoise, AbuseIPDB, HIBP, urlscan). Each
  // reads its API key from settings.osint.apiKeys; missing keys produce
  // a helpful "configure in Settings" error rather than a silent failure.
  try {
    const { registerPremiumOsintTools } = await import('./services/osint/PremiumOsintTools')
    registerPremiumOsintTools()
  } catch (err) { log.warn(`Premium OSINT tools registration failed: ${err}`) }

  // v1.4.3 — seamless local-model bootstrap. Load the registry, then
  // background-fetch any required asset that's missing (Whisper base
  // model, Tesseract data). Non-blocking; UI keeps loading in
  // parallel. Renderer subscribes to models:status_update for the
  // download-progress chrome.
  try {
    const { modelDownloadManager } = await import('./services/models/ModelDownloadManager')
    await modelDownloadManager.start()
    setImmediate(() => modelDownloadManager.ensureRequired())
  } catch (err) { log.warn(`Model download manager init failed: ${err}`) }

  // v1.4.6 — wire the heimdall-media:// handler now that the DB is
  // ready (so transcript/image ID → path lookups can succeed).
  try {
    registerMediaProtocolHandler()
  } catch (err) { log.warn(`Media protocol handler init failed: ${err}`) }

  // v1.5.0 — schedule the daily transcription retention purge. No-op
  // unless the analyst sets transcription.retentionDays > 0; the
  // service reads the setting per-tick so the cron itself is harmless
  // for users who don't opt in.
  try {
    const { transcriptionRetention } = await import('./services/transcription/TranscriptionRetentionService')
    transcriptionRetention.start()
  } catch (err) { log.warn(`Transcription retention init failed: ${err}`) }

  // v1.5.3 — schedule cron-driven alerts for saved searches with
  // alert_enabled. Idempotent; per-tick cap of 5 new alerts per
  // search; first-run records cursor without emitting (no flood).
  try {
    const { savedSearchAlertCron } = await import('./services/search/SavedSearchAlertCron')
    savedSearchAlertCron.start()
  } catch (err) { log.warn(`Saved-search alert cron init failed: ${err}`) }

  // v1.6.0 — schedule the automated daily intelligence briefing.
  // Cron expression honours briefing.dailyCron (default '0 17 * * *'
  // = 17:00 server time); the tick itself is gated on
  // briefing.dailyEnabled so the cron is harmless until the analyst
  // opts in.
  try {
    const { dailyBriefingService } = await import('./services/briefing/DailyBriefingService')
    dailyBriefingService.start()
  } catch (err) { log.warn(`Daily briefing init failed: ${err}`) }

  // Load enabled sources from DB and schedule them
  await collectorManager.loadFromDatabase()

  // Start agent orchestrator (enrichment, analysis, summaries)
  agentOrchestrator.start()

  // Start vector DB ingestion pipeline
  await intelPipeline.start()

  // Start background enrichment orchestrator (Multica-style)
  enrichmentOrchestrator.start()

  // Graph DB: SQLite-only. Kuzu was removed in v0.4 — its native module was
  // unstable and dormant in practice. SQLite indices on intel_links handle
  // every graph query the app runs (Theme 4 features in the roadmap will
  // add in-memory graphology when scale demands it).

  // Start resource manager (memory cleanup, WAL checkpoint, cache pruning)
  resourceManager.start()

  // Overnight collection cycle — 02:30 local, daily. Writes no files, only
  // DB rows, so clash-with-migration is not a concern.
  cronService.schedule('overnight.cycle', '30 2 * * *', 'Overnight collection cycle', async () => {
    try { await overnightService.runCycle({ periodHours: 24 }) }
    catch (err) { log.error(`overnight.cycle failed: ${err}`) }
  })

  // Memory consolidation — 03:00 local, daily. Runs AFTER overnight cycle
  // so newly-generated sessions from the overnight brief can be included.
  cronService.schedule('memory.consolidate', '0 3 * * *', 'Memory consolidation', async () => {
    try { await consolidationService.runOnce() }
    catch (err) { log.error(`memory.consolidate failed: ${err}`) }
  })

  // Daily disinfo sweep (Theme J) — 03:30 local. Pure SQL, always safe to run.
  cronService.schedule('disinfo.sweep', '30 3 * * *', 'Daily disinfo sweep', async () => {
    try { disinfoService.sweep(48) }
    catch (err) { log.error(`disinfo.sweep failed: ${err}`) }
  })

  // Conflict probability heatmap refresh — 04:00 local.
  cronService.schedule('conflict.compute', '0 4 * * *', 'Conflict probability recompute', async () => {
    try { conflictService.compute(14) }
    catch (err) { log.error(`conflict.compute failed: ${err}`) }
  })

  // Insider threat scan — 04:30 local, daily.
  cronService.schedule('insider.scan', '30 4 * * *', 'Insider threat scan', async () => {
    try { insiderThreatService.scan() }
    catch (err) { log.error(`insider.scan failed: ${err}`) }
  })

  // MITRE ATT&CK refresh — Mondays 05:00 local, weekly. The bundle changes
  // roughly twice a year so weekly is overkill but cheap (~3MB). Lazy import
  // to keep boot light.
  cronService.schedule('training.mitre', '0 5 * * 1', 'MITRE ATT&CK weekly refresh', async () => {
    try {
      const { mitreIngester } = await import('./services/training/MitreIngester')
      const stats = await mitreIngester.run()
      log.info(`training.mitre: ${stats.inserted} indicators in ${stats.durationMs}ms`)
    } catch (err) { log.error(`training.mitre failed: ${err}`) }
  })

  // MISP public feeds — 04:45 local, daily. Free + no-auth feeds (CIRCL,
  // botvrij, optionally ThreatFox). Pull most-recent N events per feed.
  cronService.schedule('training.misp', '45 4 * * *', 'MISP public feeds daily refresh', async () => {
    try {
      const { mispFeedIngester } = await import('./services/training/MispFeedIngester')
      const results = await mispFeedIngester.runAll()
      const total = results.reduce((s, r) => s + r.inserted, 0)
      log.info(`training.misp: ${total} indicators across ${results.length} feeds`)
    } catch (err) { log.error(`training.misp failed: ${err}`) }
  })

  // Bootstrap MITRE on first run — fire 30s after boot if threat_feeds is
  // empty, so a fresh install gets useful threat data without waiting for
  // Monday 5am. Wrapped in a slight delay to let Phase 2 init settle.
  setTimeout(async () => {
    try {
      const { threatFeedMatcher } = await import('./services/training/ThreatFeedMatcher')
      const stats = threatFeedMatcher.getStats()
      if (stats.total === 0) {
        log.info('training: threat_feeds empty — bootstrapping MITRE ATT&CK')
        const { mitreIngester } = await import('./services/training/MitreIngester')
        await mitreIngester.run()
      } else {
        log.info(`training: threat_feeds already populated (${stats.total} indicators)`)
      }
    } catch (err) { log.warn(`training bootstrap failed: ${err}`) }
  }, 30_000)

  // TAXII server — honour the settings.enabled flag. Silent if disabled.
  try { await taxiiServer.ensureRunning() }
  catch (err) { log.warn(`taxii ensureRunning: ${(err as Error).message}`) }

  // Auto-pull Meshtastic data on startup if configured. Outer catch logs at
  // debug because a missing/malformed config is expected on first run; inner
  // catch keeps the deferred pull from blowing up the main process.
  try {
    const meshConfig = settingsService.get<any>('meshtastic')
    if (meshConfig?.address) {
      let addr = meshConfig.address
      if (!addr.startsWith('http')) addr = `http://${addr}`
      log.info(`Auto-pulling Meshtastic from ${addr}...`)
      setTimeout(async () => {
        try {
          const { pullMeshtasticHttp } = await import('./bridge/meshtasticBridge')
          const result = await pullMeshtasticHttp(addr)
          log.info(`Meshtastic auto-pull: ${result.message}`)
        } catch (err) {
          log.debug(`Meshtastic auto-pull failed: ${err}`)
        }
      }, 20000) // 20s delay — let UI render first
    }
  } catch (err) {
    log.debug(`Meshtastic config read failed at startup: ${err}`)
  }

  // v1.1 — Reports library promotion. Scans existing chat_messages and
  // moves anything that looks like a generated report into the new
  // report_products table. Idempotent — exits immediately if the previous
  // run completed. Streams progress to the renderer for the splash UI.
  // Wrapped in setTimeout to let the renderer fully mount first so the
  // splash event subscriber is ready.
  setTimeout(async () => {
    try {
      const { startReportPromotionMigration } = await import('./bridge/reportsBridge')
      startReportPromotionMigration()
    } catch (err) {
      log.warn(`Report promotion migration kick-off failed: ${err}`)
    }
  }, 3000)

  // FUNCTIONAL FIX (v1.3.2 — finding C3): subscribe SafeFetcher + Tor
  // re-binding to settings changes so the analyst doesn't need to
  // restart the app after editing safety / darkWeb config.
  settingsService.on('change:section:safety', () => {
    try {
      const next = settingsService.get<SafetyConfig>('safety')
      if (next) {
        safeFetcher.setRate(next.rateLimitPerDomain || 30)
        safeFetcher.setRobotsEnabled(next.respectRobotsTxt ?? true)
        safeFetcher.setAirGap(next.airGapMode ?? false, next.airGapAllowlist ?? [])
        log.info('SafeFetcher: rebound from settings change')
      }
    } catch (err) { log.warn(`safety re-bind failed: ${err}`) }
  })
  settingsService.on('change:section:darkWeb', () => {
    try {
      const dw = settingsService.get<DarkWebConfig>('darkWeb')
      if (dw?.enabled) {
        safeFetcher.setSocks5(dw.socks5Host || '127.0.0.1', dw.socks5Port || 9050)
        log.info(`SafeFetcher: SOCKS5 rebound to ${dw.socks5Host}:${dw.socks5Port}`)
      }
    } catch (err) { log.warn(`darkWeb re-bind failed: ${err}`) }
  })

  // v1.1 calibration loops — Indicator Tracker + Auto-Revision both run
  // on their own internal timers. Source Reliability recompute runs
  // nightly via cron.
  try {
    const { indicatorTrackerService } = await import('./services/calibration/IndicatorTrackerService')
    indicatorTrackerService.start()
  } catch (err) { log.warn(`indicator tracker start failed: ${err}`) }

  try {
    const { autoRevisionService } = await import('./services/calibration/AutoRevisionService')
    autoRevisionService.start()
  } catch (err) { log.warn(`auto-revision start failed: ${err}`) }

  cronService.schedule('calibration.reliability', '0 6 * * *', 'Source-reliability nightly recompute', async () => {
    try {
      const { sourceReliabilityService } = await import('./services/calibration/SourceReliabilityService')
      sourceReliabilityService.recomputeAll()
    } catch (err) { log.error(`calibration.reliability failed: ${err}`) }
  })

  // v1.2 — Sentinel + Service Registry. Each long-running service registers
  // itself so the supervisor can poll health, log state transitions, and
  // auto-restart on failure. We register the major services here directly
  // (rather than scattering registration calls) so the wiring is auditable
  // in one place.
  try {
    const { serviceRegistry } = await import('./services/sentinel/ServiceRegistry')
    const { sentinelSupervisor } = await import('./services/sentinel/SentinelSupervisor')

    serviceRegistry.register({
      id: 'collector-manager',
      displayName: 'Collector Manager',
      category: 'collector',
      autoRestart: true,
      healthCheck: () => {
        const status = collectorManager.getStatus?.() ?? []
        const total = status.length
        const running = status.filter((s) => s.running).length
        if (total === 0) return { state: 'stopped' as const, detail: 'no collectors registered' }
        const ratio = running / total
        if (ratio < 0.5) {
          return { state: 'degraded' as const, detail: `${running}/${total} collectors running`, metadata: { total, running } }
        }
        return { state: 'running' as const, metadata: { total, running } }
      },
      restart: async () => { await collectorManager.loadFromDatabase() }
    })

    serviceRegistry.register({
      id: 'enrichment-orchestrator',
      displayName: 'Enrichment Orchestrator',
      category: 'enrichment',
      autoRestart: true,
      healthCheck: () => {
        const isRunning = enrichmentOrchestrator.isRunning()
        const stats = enrichmentOrchestrator.getStats()
        return isRunning
          ? { state: 'running' as const, metadata: stats }
          : { state: 'stopped' as const, metadata: stats }
      },
      restart: async () => { enrichmentOrchestrator.start() }
    })

    serviceRegistry.register({
      id: 'intel-pipeline',
      displayName: 'Vector Pipeline',
      category: 'enrichment',
      autoRestart: true,
      healthCheck: () => {
        const isRunning = (intelPipeline as { isRunning?: () => boolean }).isRunning?.() ?? true
        return isRunning ? { state: 'running' as const } : { state: 'stopped' as const }
      },
      restart: async () => { await intelPipeline.start() }
    })

    serviceRegistry.register({
      id: 'agent-orchestrator',
      displayName: 'Agent Orchestrator',
      category: 'enrichment',
      autoRestart: true,
      healthCheck: () => {
        const isRunning = (agentOrchestrator as { isRunning?: () => boolean }).isRunning?.() ?? true
        return isRunning ? { state: 'running' as const } : { state: 'stopped' as const }
      },
      restart: async () => { agentOrchestrator.start() }
    })

    serviceRegistry.register({
      id: 'cron-scheduler',
      displayName: 'Cron Scheduler',
      category: 'infrastructure',
      autoRestart: false,    // restart would require recreating every job
      healthCheck: () => {
        const count = (cronService as { jobCount?: () => number }).jobCount?.() ?? 0
        return count > 0 ? { state: 'running' as const, metadata: { jobs: count } } : { state: 'degraded' as const, detail: 'no scheduled jobs' }
      }
    })

    serviceRegistry.register({
      id: 'indicator-tracker',
      displayName: 'I&W Indicator Tracker',
      category: 'calibration',
      autoRestart: true,
      healthCheck: async () => {
        const { indicatorTrackerService } = await import('./services/calibration/IndicatorTrackerService')
        return { state: 'running' as const, metadata: indicatorTrackerService.stats() }
      },
      restart: async () => {
        const { indicatorTrackerService } = await import('./services/calibration/IndicatorTrackerService')
        indicatorTrackerService.stop()
        indicatorTrackerService.start()
      }
    })

    serviceRegistry.register({
      id: 'auto-revision',
      displayName: 'Auto-Revision Detector',
      category: 'calibration',
      autoRestart: true,
      healthCheck: async () => {
        const { autoRevisionService } = await import('./services/calibration/AutoRevisionService')
        return { state: 'running' as const, metadata: { pending: autoRevisionService.pendingCount() } }
      },
      restart: async () => {
        const { autoRevisionService } = await import('./services/calibration/AutoRevisionService')
        autoRevisionService.stop()
        autoRevisionService.start()
      }
    })

    serviceRegistry.register({
      id: 'resource-manager',
      displayName: 'Resource Manager',
      category: 'infrastructure',
      autoRestart: true,
      healthCheck: () => ({ state: 'running' as const }),
      restart: async () => { resourceManager.stop(); resourceManager.start() }
    })

    sentinelSupervisor.start()
    log.info(`Sentinel: registered ${serviceRegistry.list().length} services and started supervisor`)

    // Register the supervisor itself + escalation as services
    serviceRegistry.register({
      id: 'sentinel-supervisor',
      displayName: 'Sentinel Supervisor',
      category: 'infrastructure',
      autoRestart: false,
      healthCheck: () => ({ state: 'running' as const, detail: 'self-monitoring' })
    })
  } catch (err) {
    log.error(`Sentinel start failed: ${err}`)
  }

  // v1.3 — Audit Chain Anchor service. Hourly signing of audit chain head
  // for third-party verifiability.
  try {
    const { auditChainAnchorService } = await import('./services/audit/AuditChainAnchorService')
    auditChainAnchorService.start()
    const { serviceRegistry } = await import('./services/sentinel/ServiceRegistry')
    serviceRegistry.register({
      id: 'audit-anchor',
      displayName: 'Audit Chain Anchor',
      category: 'infrastructure',
      autoRestart: true,
      healthCheck: async () => {
        const stats = await auditChainAnchorService.chainStats()
        return { state: 'running' as const, metadata: { chainLength: stats.chainLength, coverage: stats.coveragePercent + '%' } }
      },
      restart: async () => { auditChainAnchorService.stop(); auditChainAnchorService.start() }
    })
  } catch (err) { log.warn(`AuditChainAnchor start failed: ${err}`) }

  // v1.3 — Forecast Accountability auto-record loop. Periodically scans
  // claims with no recorded outcome and tries to match them against
  // high-priority indicator hits.
  cronService.schedule('forecast.auto_record', '*/30 * * * *', 'Forecast outcome auto-record', async () => {
    try {
      const { forecastAccountabilityService } = await import('./services/forecast/ForecastAccountabilityService')
      forecastAccountabilityService.autoRecordFromIndicatorHits()
    } catch (err) { log.error(`forecast.auto_record failed: ${err}`) }
  })

  // v1.2.1 — Alert Escalation. Polls alerts table every 30s, dispatches
  // unacknowledged ops alerts via configured channels, re-escalates if
  // unacknowledged after on-call.escalation_after_minutes minutes.
  try {
    const { alertEscalationService } = await import('./services/alerts/escalation/AlertEscalationService')
    alertEscalationService.start()
    const { serviceRegistry } = await import('./services/sentinel/ServiceRegistry')
    serviceRegistry.register({
      id: 'alert-escalation',
      displayName: 'Alert Escalation',
      category: 'infrastructure',
      autoRestart: true,
      healthCheck: async () => {
        return { state: 'running' as const, metadata: alertEscalationService.stats() }
      },
      restart: async () => { alertEscalationService.stop(); alertEscalationService.start() }
    })
  } catch (err) { log.warn(`AlertEscalation start failed: ${err}`) }

  log.info('Deferred initialization complete')
}

function createWindow(): void {
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../../build/icon.icns')
    : join(__dirname, '../../build/icon.png')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Heimdall',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // SECURITY (v1.3.2 — finding B1/E1.1): only allow http/https/mailto
  // schemes through to shell.openExternal. Untrusted RSS / dark-web
  // crawl content can include file://, javascript:, vscode:, smb://,
  // ms-msdt: etc. — all of which become one-click RCE vectors when
  // handed to shell.openExternal.
  const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const u = new URL(details.url)
      if (SAFE_URL_PROTOCOLS.has(u.protocol)) {
        void shell.openExternal(details.url)
      } else {
        log.warn(`Blocked external open of unsafe protocol: ${u.protocol} (url=${details.url.slice(0, 100)})`)
      }
    } catch {
      // malformed URL — silently ignore
    }
    return { action: 'deny' }
  })

  // SECURITY (v1.3.2 — finding B10): block top-level navigation to any
  // origin other than the bundled renderer. Prevents an XSS or rogue
  // third-party widget from navigating away and exposing the
  // window.heimdall API to a remote attacker-controlled origin.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const allowed = is.dev && process.env['ELECTRON_RENDERER_URL']
        ? new URL(process.env['ELECTRON_RENDERER_URL']!).origin
        : 'file://'
      if (!url.startsWith(allowed)) {
        event.preventDefault()
        log.warn(`Blocked top-level navigation to ${url.slice(0, 100)}`)
        const u = new URL(url)
        if (SAFE_URL_PROTOCOLS.has(u.protocol)) {
          void shell.openExternal(url)
        }
      }
    } catch {
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.ankurces.heimdall')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // SECURITY (v1.3.2 — defense-in-depth): every webContents created
    // anywhere in the app rejects window.open by default. The main
    // window's setWindowOpenHandler already enforces this, but this
    // catches any new BrowserView / popup the app might create later.
    app.on('web-contents-created', (_event, contents) => {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    })

    await initializeEssentials()
    createWindow()

    if (isDatabaseReady()) {
      // Unencrypted boot — run deferred init immediately.
      await initializeDeferred()
    } else {
      // Encrypted boot — wait for the renderer to call encryption:unlock.
      // `heimdall-unlocked` is emitted by encryptionBridge on finish_boot.
      app.once('heimdall-unlocked', () => {
        initializeAfterUnlock().catch((err) => log.error(`post-unlock init failed: ${err}`))
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  // Cleanup is idempotent — both events fire on different platforms and each
  // shutdown method tolerates being called twice. Centralizing prevents
  // drift between the two handlers and ensures a single audit point for
  // adding new shutdown steps.
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    log.info('Heimdall shutting down — running cleanup')
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sup = require('./services/sentinel/SentinelSupervisor') as typeof import('./services/sentinel/SentinelSupervisor')
      sup.sentinelSupervisor.stop()
    } catch (err) { log.debug(`sentinelSupervisor.stop: ${err}`) }
    try { resourceManager.stop() } catch (err) { log.debug(`resourceManager.stop: ${err}`) }
    try { enrichmentOrchestrator.stop() } catch (err) { log.debug(`enrichmentOrchestrator.stop: ${err}`) }
    try { intelPipeline.stop() } catch (err) { log.debug(`intelPipeline.stop: ${err}`) }
    try { agentOrchestrator.stop() } catch (err) { log.debug(`agentOrchestrator.stop: ${err}`) }
    try { collectorManager.shutdownAll() } catch (err) { log.debug(`collectorManager.shutdownAll: ${err}`) }
    try { cronService.stopAll() } catch (err) { log.debug(`cronService.stopAll: ${err}`) }
    try { void taxiiServer.stop() } catch (err) { log.debug(`taxiiServer.stop: ${err}`) }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mcp = require('./services/mcp/McpClientService') as typeof import('./services/mcp/McpClientService')
      void mcp.mcpClientService.stop()
    } catch (err) { log.debug(`mcpClientService.stop: ${err}`) }

    // FUNCTIONAL FIX (v1.3.2 — finding E1): stop the v1.x background
    // services that previously leaked their setInterval references on
    // shutdown. Process exit makes these benign, but they break any
    // re-init code path (encrypted boot → unlock → second init).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('./services/calibration/IndicatorTrackerService') as typeof import('./services/calibration/IndicatorTrackerService')
      m.indicatorTrackerService.stop()
    } catch (err) { log.debug(`indicatorTrackerService.stop: ${err}`) }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('./services/calibration/AutoRevisionService') as typeof import('./services/calibration/AutoRevisionService')
      m.autoRevisionService.stop()
    } catch (err) { log.debug(`autoRevisionService.stop: ${err}`) }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('./services/alerts/escalation/AlertEscalationService') as typeof import('./services/alerts/escalation/AlertEscalationService')
      m.alertEscalationService.stop()
    } catch (err) { log.debug(`alertEscalationService.stop: ${err}`) }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = require('./services/audit/AuditChainAnchorService') as typeof import('./services/audit/AuditChainAnchorService')
      m.auditChainAnchorService.stop()
    } catch (err) { log.debug(`auditChainAnchorService.stop: ${err}`) }

    try { closeDatabase() } catch (err) { log.debug(`closeDatabase: ${err}`) }
  }

  app.on('window-all-closed', () => {
    cleanup()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', cleanup)
}
