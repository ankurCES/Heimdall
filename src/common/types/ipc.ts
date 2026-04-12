import type { IntelReport, Source, AuditEntry, Alert } from './intel'

export interface IpcChannels {
  // Settings
  'settings:get': { params: { key: string }; result: unknown }
  'settings:set': { params: { key: string; value: unknown }; result: void }
  'settings:getSection': { params: { section: string }; result: unknown }

  // Intel Reports
  'intel:getReports': {
    params: {
      offset: number
      limit: number
      discipline?: string
      severity?: string
      search?: string
      reviewed?: boolean
    }
    result: { reports: IntelReport[]; total: number }
  }
  'intel:getReport': { params: { id: string }; result: IntelReport | null }
  'intel:markReviewed': { params: { ids: string[] }; result: void }
  'intel:getDashboardStats': { params: void; result: DashboardStats }

  // Sources
  'sources:getAll': { params: void; result: Source[] }
  'sources:create': { params: Omit<Source, 'id' | 'createdAt' | 'updatedAt' | 'lastCollectedAt' | 'lastError' | 'errorCount'>; result: Source }
  'sources:update': { params: { id: string; data: Partial<Source> }; result: Source }
  'sources:delete': { params: { id: string }; result: void }
  'sources:collectNow': { params: { id: string }; result: void }

  // Alerts
  'alerts:getHistory': { params: { offset: number; limit: number }; result: { alerts: Alert[]; total: number } }
  'alerts:sendManual': { params: { reportId: string; channel: string }; result: void }

  // Audit
  'audit:getEntries': { params: { offset: number; limit: number; action?: string }; result: { entries: AuditEntry[]; total: number } }

  // App
  'app:getVersion': { params: void; result: string }
  'app:getPlatform': { params: void; result: string }
}

export interface IpcEvents {
  'intel:newReports': IntelReport[]
  'intel:alertSent': Alert
  'collector:statusChanged': { sourceId: string; status: 'running' | 'idle' | 'error'; error?: string }
  'app:notification': { title: string; body: string; severity: string }
}

export interface DashboardStats {
  totalReports: number
  last24h: {
    critical: number
    high: number
    medium: number
    low: number
    info: number
  }
  byDiscipline: Record<string, number>
  activeCollectors: number
  totalCollectors: number
  recentCritical: IntelReport[]
}
