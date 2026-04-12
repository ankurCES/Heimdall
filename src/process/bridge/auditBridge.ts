import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { auditService } from '../services/audit/AuditService'
import log from 'electron-log'

export function registerAuditBridge(): void {
  ipcMain.handle(IPC_CHANNELS.AUDIT_GET_ENTRIES, (_event, params: { offset: number; limit: number; action?: string }) => {
    return auditService.getEntries(params.offset, params.limit, params.action)
  })

  log.info('Audit bridge registered')
}
