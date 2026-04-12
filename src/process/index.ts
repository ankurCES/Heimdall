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

log.transports.file.level = 'info'
log.transports.console.level = 'debug'

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

  log.info('Deferred initialization complete')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Heimdall',
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
    collectorManager.shutdownAll()
    cronService.stopAll()
    closeDatabase()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    collectorManager.shutdownAll()
    cronService.stopAll()
    closeDatabase()
  })
}
