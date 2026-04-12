import { IPC_CHANNELS, IPC_EVENTS } from '@common/adapter/ipcBridge'

function getApi() {
  return window.heimdall
}

export const ipc = {
  settings: {
    get: <T = unknown>(key: string): Promise<T | null> =>
      getApi().invoke(IPC_CHANNELS.SETTINGS_GET, { key }) as Promise<T | null>,
    set: (key: string, value: unknown): Promise<void> =>
      getApi().invoke(IPC_CHANNELS.SETTINGS_SET, { key, value }) as Promise<void>,
    getSection: (section: string): Promise<Record<string, unknown>> =>
      getApi().invoke(IPC_CHANNELS.SETTINGS_GET_SECTION, { section }) as Promise<Record<string, unknown>>
  },

  intel: {
    getReports: (params: {
      offset: number
      limit: number
      discipline?: string
      severity?: string
      search?: string
      reviewed?: boolean
    }) => getApi().invoke(IPC_CHANNELS.INTEL_GET_REPORTS, params) as Promise<{ reports: unknown[]; total: number }>,

    getReport: (id: string) =>
      getApi().invoke(IPC_CHANNELS.INTEL_GET_REPORT, { id }),

    markReviewed: (ids: string[]) =>
      getApi().invoke(IPC_CHANNELS.INTEL_MARK_REVIEWED, { ids }) as Promise<void>,

    getDashboardStats: () =>
      getApi().invoke(IPC_CHANNELS.INTEL_GET_DASHBOARD_STATS) as Promise<unknown>
  },

  sources: {
    getAll: () => getApi().invoke(IPC_CHANNELS.SOURCES_GET_ALL) as Promise<unknown[]>,
    create: (data: unknown) => getApi().invoke(IPC_CHANNELS.SOURCES_CREATE, data),
    update: (id: string, data: unknown) => getApi().invoke(IPC_CHANNELS.SOURCES_UPDATE, { id, data }),
    delete: (id: string) => getApi().invoke(IPC_CHANNELS.SOURCES_DELETE, { id }) as Promise<void>,
    collectNow: (id: string) => getApi().invoke(IPC_CHANNELS.SOURCES_COLLECT_NOW, { id }) as Promise<void>
  },

  alerts: {
    getHistory: (params: { offset: number; limit: number }) =>
      getApi().invoke(IPC_CHANNELS.ALERTS_GET_HISTORY, params) as Promise<{ alerts: unknown[]; total: number }>,
    sendManual: (reportId: string, channel: string) =>
      getApi().invoke(IPC_CHANNELS.ALERTS_SEND_MANUAL, { reportId, channel }) as Promise<void>
  },

  app: {
    getVersion: () => getApi().invoke(IPC_CHANNELS.APP_GET_VERSION) as Promise<string>,
    getPlatform: () => getApi().invoke(IPC_CHANNELS.APP_GET_PLATFORM) as Promise<string>
  },

  on: {
    newReports: (cb: (...args: unknown[]) => void) => getApi().on(IPC_EVENTS.INTEL_NEW_REPORTS, cb),
    alertSent: (cb: (...args: unknown[]) => void) => getApi().on(IPC_EVENTS.INTEL_ALERT_SENT, cb),
    collectorStatus: (cb: (...args: unknown[]) => void) => getApi().on(IPC_EVENTS.COLLECTOR_STATUS_CHANGED, cb),
    notification: (cb: (...args: unknown[]) => void) => getApi().on(IPC_EVENTS.APP_NOTIFICATION, cb)
  }
}
