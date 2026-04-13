import { ipcMain } from 'electron'
import { watchTermsService } from '../services/watch/WatchTermsService'
import log from 'electron-log'

export function registerWatchBridge(): void {
  ipcMain.handle('watch:getTerms', () => watchTermsService.getAll())

  ipcMain.handle('watch:addTerm', (_event, params: { term: string; category?: string; priority?: string }) => {
    return watchTermsService.addManual(params.term, params.category, params.priority)
  })

  ipcMain.handle('watch:toggleTerm', (_event, params: { id: string; enabled: boolean }) => {
    watchTermsService.toggle(params.id, params.enabled)
  })

  ipcMain.handle('watch:removeTerm', (_event, params: { id: string }) => {
    watchTermsService.remove(params.id)
  })

  ipcMain.handle('watch:scan', () => {
    return watchTermsService.scanForMatches()
  })

  log.info('Watch bridge registered')
}
