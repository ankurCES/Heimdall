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

  // Kuzu graph database — disabled by default to prevent native module crashes
  // Enable via Settings when needed. SQLite graph fallback works for all queries.
  const kuzuEnabled = false // TODO: make configurable via settings
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
    log.info('Kuzu graph DB disabled — using SQLite graph queries (stable)')
  }

  // Start resource manager (memory cleanup, WAL checkpoint, cache pruning)
  resourceManager.start()

  // Auto-pull Meshtastic data on startup if configured
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
  } catch {}

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

  app.on('window-all-closed', () => {
    resourceManager.stop()
    kuzuService.close().catch(() => {})
    enrichmentOrchestrator.stop()
    intelPipeline.stop()
    agentOrchestrator.stop()
    collectorManager.shutdownAll()
    cronService.stopAll()
    closeDatabase()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    resourceManager.stop()
    kuzuService.close().catch(() => {})
    enrichmentOrchestrator.stop()
    intelPipeline.stop()
    agentOrchestrator.stop()
    collectorManager.shutdownAll()
    cronService.stopAll()
    closeDatabase()
  })
}
