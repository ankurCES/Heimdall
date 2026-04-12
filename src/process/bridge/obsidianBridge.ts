import { ipcMain } from 'electron'
import { obsidianService } from '../services/obsidian/ObsidianService'
import log from 'electron-log'

export function registerObsidianBridge(): void {
  ipcMain.handle('obsidian:testConnection', async () => {
    return obsidianService.testConnection()
  })

  ipcMain.handle('obsidian:listFiles', async (_event, params: { folder?: string }) => {
    return obsidianService.listFiles(params?.folder)
  })

  ipcMain.handle('obsidian:readFile', async (_event, params: { path: string }) => {
    return obsidianService.readFile(params.path)
  })

  ipcMain.handle('obsidian:search', async (_event, params: { query: string }) => {
    return obsidianService.search(params.query)
  })

  ipcMain.handle('obsidian:getTags', async () => {
    return obsidianService.getTags()
  })

  ipcMain.handle('obsidian:openInObsidian', async (_event, params: { path: string }) => {
    return obsidianService.openFile(params.path)
  })

  ipcMain.handle('obsidian:bulkImport', async () => {
    log.info('Obsidian bulk import requested')
    return obsidianService.bulkImportLocalFiles()
  })

  ipcMain.handle('obsidian:manualSync', async () => {
    log.info('Obsidian manual sync requested')
    return obsidianService.manualSync()
  })

  ipcMain.handle('obsidian:needsInitialImport', async () => {
    return obsidianService.needsInitialImport()
  })

  ipcMain.handle('settings:testObsidian', async () => {
    return obsidianService.testConnection()
  })

  log.info('Obsidian bridge registered')
}
