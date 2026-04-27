// Case Files IPC bridge.

import { ipcMain } from 'electron'
import log from 'electron-log'
import { caseFileService, type CaseFileItemType, type CaseFileStatus } from '../services/cases/CaseFileService'

export function registerCasesBridge(): void {
  ipcMain.handle('cases:list', async (_e, filters: { status?: CaseFileStatus | CaseFileStatus[]; tag?: string } = {}) => {
    try {
      return { ok: true, cases: caseFileService.list(filters) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:get', async (_e, id: string) => {
    try {
      const c = caseFileService.get(id)
      return c ? { ok: true, case: c } : { ok: false, error: 'not_found' }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:create', async (_e, input) => {
    try {
      const c = caseFileService.create(input)
      return { ok: true, case: c }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:update', async (_e, params: { id: string; patch: Record<string, unknown> }) => {
    try {
      const c = caseFileService.update(params.id, params.patch)
      return c ? { ok: true, case: c } : { ok: false, error: 'not_found' }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:delete', async (_e, id: string) => {
    try {
      return { ok: caseFileService.delete(id) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:list_items', async (_e, params: { caseFileId: string; type?: CaseFileItemType }) => {
    try {
      return { ok: true, items: caseFileService.listItems(params.caseFileId, params.type) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:add_item', async (_e, params: {
    caseFileId: string; itemType: CaseFileItemType; itemId: string; notes?: string
  }) => {
    try {
      const r = caseFileService.addItem(params.caseFileId, params.itemType, params.itemId, { notes: params.notes })
      return r
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:remove_item', async (_e, itemId: string) => {
    try {
      return { ok: caseFileService.removeItem(itemId) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:containing', async (_e, params: { itemType: CaseFileItemType; itemId: string }) => {
    try {
      return { ok: true, cases: caseFileService.casesContaining(params.itemType, params.itemId) }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('cases:stats', async () => {
    try {
      return { ok: true, ...caseFileService.stats() }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  log.info('cases bridge registered')
}
