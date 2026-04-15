import { create } from 'zustand'
import type {
  AnalyticsReport, ReportMeta, WidgetConfig, GlobalFilterState, LayoutItem
} from '@common/analytics/types'
import { makeBlankReport } from '@common/analytics/presets'

interface AnalyticsState {
  reports: ReportMeta[]
  currentReport: AnalyticsReport | null
  dirty: boolean
  editMode: boolean
  loading: boolean

  loadReports: () => Promise<void>
  loadReport: (id: string) => Promise<void>
  newReport: () => void
  saveReport: (overrides?: Partial<Pick<AnalyticsReport, 'name' | 'description' | 'icon'>>) => Promise<{ id: string; forked: boolean } | null>
  deleteReport: (id: string) => Promise<boolean>
  duplicateReport: (id: string, name?: string) => Promise<string | null>

  setEditMode: (on: boolean) => void
  setGlobalFilters: (f: GlobalFilterState) => void
  setLayout: (layout: LayoutItem[]) => void
  addWidget: (w: WidgetConfig) => void
  updateWidget: (id: string, patch: Partial<WidgetConfig>) => void
  removeWidget: (id: string) => void
  renameReport: (name: string) => void
}

const invoke = <T = unknown>(ch: string, p?: unknown): Promise<T> =>
  window.heimdall.invoke(ch, p) as Promise<T>

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  reports: [],
  currentReport: null,
  dirty: false,
  editMode: false,
  loading: false,

  loadReports: async () => {
    const reports = await invoke<ReportMeta[]>('analytics:listReports')
    set({ reports: reports || [] })
  },

  loadReport: async (id: string) => {
    set({ loading: true })
    const report = await invoke<AnalyticsReport | null>('analytics:getReport', { id })
    set({ currentReport: report, dirty: false, loading: false })
  },

  newReport: () => {
    const id = `draft_${Date.now()}`
    const rep = makeBlankReport(id, 'Untitled Report')
    set({ currentReport: rep, dirty: true, editMode: true })
  },

  saveReport: async (overrides) => {
    const cur = get().currentReport
    if (!cur) return null
    const next: AnalyticsReport = {
      ...cur,
      ...overrides,
      updatedAt: Date.now()
    }
    const result = await invoke<{ id: string; forked: boolean }>('analytics:saveReport', next)
    if (result?.id) {
      // After save, reload meta list and re-fetch canonical report from DB
      await get().loadReports()
      await get().loadReport(result.id)
    }
    return result
  },

  deleteReport: async (id: string) => {
    const res = await invoke<{ ok: boolean; error?: string }>('analytics:deleteReport', { id })
    if (res?.ok) {
      await get().loadReports()
      // If the deleted report was current, pick the first available
      if (get().currentReport?.id === id) {
        const first = get().reports[0]
        if (first) await get().loadReport(first.id)
        else set({ currentReport: null })
      }
      return true
    }
    return false
  },

  duplicateReport: async (id: string, name?: string) => {
    const res = await invoke<{ id: string }>('analytics:duplicateReport', { id, name })
    if (res?.id) {
      await get().loadReports()
      await get().loadReport(res.id)
      return res.id
    }
    return null
  },

  setEditMode: (on) => set({ editMode: on }),

  setGlobalFilters: (f) => {
    const cur = get().currentReport
    if (!cur) return
    set({ currentReport: { ...cur, globalFilters: f }, dirty: true })
  },

  setLayout: (layout) => {
    const cur = get().currentReport
    if (!cur) return
    set({ currentReport: { ...cur, layout }, dirty: true })
  },

  addWidget: (w) => {
    const cur = get().currentReport
    if (!cur) return
    const newLayout: LayoutItem[] = [...cur.layout, { i: w.id, x: 0, y: Infinity, w: 6, h: 4, minW: 2, minH: 2 }]
    set({
      currentReport: {
        ...cur,
        widgets: { ...cur.widgets, [w.id]: w },
        layout: newLayout
      },
      dirty: true
    })
  },

  updateWidget: (id, patch) => {
    const cur = get().currentReport
    if (!cur || !cur.widgets[id]) return
    set({
      currentReport: {
        ...cur,
        widgets: { ...cur.widgets, [id]: { ...cur.widgets[id], ...patch } }
      },
      dirty: true
    })
  },

  removeWidget: (id) => {
    const cur = get().currentReport
    if (!cur) return
    const { [id]: _removed, ...remaining } = cur.widgets
    set({
      currentReport: {
        ...cur,
        widgets: remaining,
        layout: cur.layout.filter((l) => l.i !== id)
      },
      dirty: true
    })
  },

  renameReport: (name) => {
    const cur = get().currentReport
    if (!cur) return
    set({ currentReport: { ...cur, name }, dirty: true })
  }
}))
