import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'
import type { IntelReport } from '@common/types/intel'

interface IntelFilters {
  discipline?: string
  severity?: string
  search?: string
  reviewed?: boolean
  sourceType?: string
  sourceId?: string
}

interface IntelState {
  reports: IntelReport[]
  total: number
  offset: number
  limit: number
  filters: IntelFilters
  loading: boolean
  error: string | null
  fetchReports: () => Promise<void>
  setFilters: (filters: IntelFilters) => void
  setPage: (offset: number) => void
  markReviewed: (ids: string[]) => Promise<void>
}

export const useIntelStore = create<IntelState>((set, get) => ({
  reports: [],
  total: 0,
  offset: 0,
  limit: 50,
  filters: {},
  loading: false,
  error: null,

  fetchReports: async () => {
    const { offset, limit, filters } = get()
    set({ loading: true, error: null })
    try {
      const result = await ipc.intel.getReports({ offset, limit, ...filters })
      set({ reports: result.reports as IntelReport[], total: result.total, loading: false })
    } catch (err) {
      set({ loading: false, error: String(err) })
    }
  },

  setFilters: (filters: IntelFilters) => {
    set({ filters, offset: 0 })
    get().fetchReports()
  },

  setPage: (offset: number) => {
    set({ offset })
    get().fetchReports()
  },

  markReviewed: async (ids: string[]) => {
    await ipc.intel.markReviewed(ids)
    get().fetchReports()
  }
}))
