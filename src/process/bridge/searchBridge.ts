// searchBridge — v1.5.1 universal search + v1.5.2 saved searches.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { universalSearch, type SearchOptions } from '../services/search/UniversalSearchService'
import { savedSearch, type SavedSearchInput } from '../services/search/SavedSearchService'

export function registerSearchBridge(): void {
  ipcMain.handle('search:universal', (_evt, args: SearchOptions) => {
    return universalSearch.search(args ?? { query: '' })
  })

  // v1.5.2 — saved searches
  ipcMain.handle('search:saved_list', () => savedSearch.list())
  ipcMain.handle('search:saved_create', (_evt, input: SavedSearchInput) => savedSearch.create(input))
  ipcMain.handle('search:saved_update', (_evt, args: { id: string; patch: Parameters<typeof savedSearch.update>[1] }) =>
    savedSearch.update(args.id, args.patch)
  )
  ipcMain.handle('search:saved_delete', (_evt, id: string) => {
    savedSearch.remove(id)
    return { ok: true }
  })
  ipcMain.handle('search:saved_run', (_evt, args: { id: string; limit?: number }) => savedSearch.run(args.id, args.limit ?? 50))

  // v1.5.3 — manual one-shot trigger for the alert cron (Settings UI button)
  ipcMain.handle('search:alerts_run_now', async () => {
    const { savedSearchAlertCron } = await import('../services/search/SavedSearchAlertCron')
    return await savedSearchAlertCron.runOnce()
  })

  log.info('search bridge registered')
}
