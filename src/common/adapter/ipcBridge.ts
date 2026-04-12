export const IPC_CHANNELS = {
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_SECTION: 'settings:getSection',

  // Intel
  INTEL_GET_REPORTS: 'intel:getReports',
  INTEL_GET_REPORT: 'intel:getReport',
  INTEL_MARK_REVIEWED: 'intel:markReviewed',
  INTEL_GET_DASHBOARD_STATS: 'intel:getDashboardStats',

  // Sources
  SOURCES_GET_ALL: 'sources:getAll',
  SOURCES_CREATE: 'sources:create',
  SOURCES_UPDATE: 'sources:update',
  SOURCES_DELETE: 'sources:delete',
  SOURCES_COLLECT_NOW: 'sources:collectNow',

  // Alerts
  ALERTS_GET_HISTORY: 'alerts:getHistory',
  ALERTS_SEND_MANUAL: 'alerts:sendManual',

  // Audit
  AUDIT_GET_ENTRIES: 'audit:getEntries',

  // App
  APP_GET_VERSION: 'app:getVersion',
  APP_GET_PLATFORM: 'app:getPlatform'
} as const

export const IPC_EVENTS = {
  INTEL_NEW_REPORTS: 'intel:newReports',
  INTEL_ALERT_SENT: 'intel:alertSent',
  COLLECTOR_STATUS_CHANGED: 'collector:statusChanged',
  APP_NOTIFICATION: 'app:notification'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
export type IpcEvent = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
