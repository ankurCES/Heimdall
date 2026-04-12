import { create } from 'zustand'
import { ipc } from '@renderer/lib/ipc'
import type { Source } from '@common/types/intel'

interface SourceState {
  sources: Source[]
  loading: boolean
  error: string | null
  fetchSources: () => Promise<void>
}

export const useSourceStore = create<SourceState>((set) => ({
  sources: [],
  loading: false,
  error: null,

  fetchSources: async () => {
    set({ loading: true, error: null })
    try {
      const sources = (await ipc.sources.getAll()) as Source[]
      set({ sources, loading: false })
    } catch (err) {
      set({ loading: false, error: String(err) })
    }
  }
}))
