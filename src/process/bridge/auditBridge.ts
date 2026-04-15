import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@common/adapter/ipcBridge'
import { auditService } from '../services/audit/AuditService'
import { auditChainService } from '../services/audit/AuditChainService'
import log from 'electron-log'

export function registerAuditBridge(): void {
  ipcMain.handle(IPC_CHANNELS.AUDIT_GET_ENTRIES, (_event, params: { offset: number; limit: number; action?: string }) => {
    return auditService.getEntries(params.offset, params.limit, params.action)
  })

  // Hash-chained tamper-evident audit log (Theme 10.4)
  ipcMain.handle('audit:chain:list', (_event, params: { limit?: number; offset?: number; entityType?: string; entityId?: string } = {}) => {
    return {
      total: auditChainService.count(),
      entries: auditChainService.list(params)
    }
  })
  ipcMain.handle('audit:chain:verify', () => auditChainService.verify())

  log.info('Audit bridge registered')
}
