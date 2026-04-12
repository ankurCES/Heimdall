import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'
import type { DashboardStats } from '@common/types/ipc'

interface DashboardState {
  stats: DashboardStats | null
  loading: boolean
  error: string | null
  fetchStats: () => Promise<void>
}

const emptyStats: DashboardStats = {
  totalReports: 0,
  last24h: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  byDiscipline: {},
  activeCollectors: 0,
  totalCollectors: 0,
  recentCritical: []
}

export const useDashboardStore = create<DashboardState>((set) => ({
  stats: null,
  loading: false,
  error: null,

  fetchStats: async () => {
    set({ loading: true, error: null })
    try {
      const stats = (await ipc.intel.getDashboardStats()) as DashboardStats
      set({ stats, loading: false })
    } catch (err) {
      set({ stats: emptyStats, loading: false, error: String(err) })
    }
  }
}))
