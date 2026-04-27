// searchBridge — v1.5.1 IPC for universal cross-corpus search.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { universalSearch, type SearchOptions } from '../services/search/UniversalSearchService'

export function registerSearchBridge(): void {
  ipcMain.handle('search:universal', (_evt, args: SearchOptions) => {
    return universalSearch.search(args ?? { query: '' })
  })
  log.info('search bridge registered')
}
