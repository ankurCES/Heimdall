import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'
import { initDatabase, closeDatabase } from './services/database'
import { registerAllBridges } from './bridge'
import { registerAllCollectors } from './collectors/registry'
import { collectorManager } from './collectors/CollectorManager'
import { safeFetcher } from './collectors/SafeFetcher'
import { settingsService } from './services/settings/SettingsService'
import { cronService } from './services/cron/CronService'
import type { SafetyConfig } from '@common/types/settings'
import { seedDefaultSources } from './services/seeder/DefaultSourceSeeder'
import { agentOrchestrator } from './agents/AgentOrchestrator'
import { intelPipeline } from './services/vectordb/IntelPipeline'
import { enrichmentOrchestrator } from './services/enrichment/EnrichmentOrchestrator'
import { resourceManager } from './services/resource/ResourceManager'
import { kuzuService } from './services/graphdb/KuzuService'
import { graphSync } from './services/graphdb/GraphSync'

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

  initDatabase()
  registerAllBridges()

  log.info('Essentials initialized')
}

async function initializeDeferred(): Promise<void> {
  log.info('Heimdall — Phase 2: Deferred initialization')

  // Apply safety settings to SafeFetcher
  const safety = settingsService.get<SafetyConfig>('safety')
  if (safety) {
    safeFetcher.setRate(safety.rateLimitPerDomain || 30)
    safeFetcher.setRobotsEnabled(safety.respectRobotsTxt ?? true)
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

  // Kuzu graph database — opt-in via the `graphSync.enabled` setting (set by
  // migration 003). Disabled by default because the native module has caused
  // process crashes when accessed concurrently with collectors. The SQLite
  // graph fallback handles every relationship query without it.
  const kuzuEnabled = settingsService.get<string>('graphSync.enabled') === 'true'
    && process.env.HEIMDALL_ENABLE_KUZU !== 'false'
  if (kuzuEnabled) {
    try {
      await kuzuService.initialize()
      if (kuzuService.isReady()) {
        setTimeout(() => {
          graphSync.fullSync()
            .then((r) => log.info(`Kuzu graph sync complete: ${r.nodes} nodes, ${r.links} links`))
            .catch((err) => log.warn(`Kuzu graph sync failed (non-fatal): ${err}`))
        }, 60000)
      }
    } catch (err) {
      log.warn(`Kuzu initialization failed, using SQLite-only graph: ${err}`)
    }
  } else {
    log.info('Kuzu graph DB disabled — using SQLite graph queries (stable). Set graphSync.enabled=true to opt in.')
  }

  // Start resource manager (memory cleanup, WAL checkpoint, cache pruning)
  resourceManager.start()

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
    await initializeDeferred()

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
    kuzuService.close().catch(() => {})
    try { enrichmentOrchestrator.stop() } catch (err) { log.debug(`enrichmentOrchestrator.stop: ${err}`) }
    try { intelPipeline.stop() } catch (err) { log.debug(`intelPipeline.stop: ${err}`) }
    try { agentOrchestrator.stop() } catch (err) { log.debug(`agentOrchestrator.stop: ${err}`) }
    try { collectorManager.shutdownAll() } catch (err) { log.debug(`collectorManager.shutdownAll: ${err}`) }
    try { cronService.stopAll() } catch (err) { log.debug(`cronService.stopAll: ${err}`) }
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
