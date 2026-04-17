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
// Kuzu graph DB removed — buggy native module, dormant for entire history,
// SQLite handled every graph query in practice. See migration 012.

log.transports.file.level = 'info'
log.transports.console.level = 'debug'

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
    void mcpClientService.start().catch((err) => log.warn(`mcp.start failed: ${err}`))
  } catch (err) {
    log.warn(`mcp service load failed: ${err}`)
  }

  // Seed default sources on first run
  seedDefaultSources()

  // Register all collector factories
  registerAllCollectors()

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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
