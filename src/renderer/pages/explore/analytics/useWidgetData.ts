import { useEffect, useRef, useState } from 'react'
import type { WidgetConfig, WidgetQueryResult, GlobalFilterState } from '@common/analytics/types'

interface CacheEntry {
  result: WidgetQueryResult
  ts: number
}

const CACHE = new Map<string, CacheEntry>()
const IN_FLIGHT = new Map<string, Promise<WidgetQueryResult>>()
const CACHE_TTL_MS = 30_000

function cacheKey(config: WidgetConfig, globalFilters: GlobalFilterState | undefined): string {
  return JSON.stringify({ c: config, g: globalFilters })
}

function stripNonQueryFields(config: WidgetConfig) {
  // Only the query-related fields should go to the backend
  return {
    dataSource: config.dataSource,
    metric: config.metric || 'count',
    groupBy: config.groupBy,
    filters: config.filters,
    timeRange: config.timeRange,
    limit: config.limit,
    bucketMinutes: config.bucketMinutes,
    ignoreGlobalFilters: config.ignoreGlobalFilters
  }
}

async function fetchOnce(key: string, payload: unknown): Promise<WidgetQueryResult> {
  const cached = CACHE.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result

  const existing = IN_FLIGHT.get(key)
  if (existing) return existing

  const promise = (async () => {
    try {
      const result = await window.heimdall.invoke('analytics:queryWidget', payload) as WidgetQueryResult
      CACHE.set(key, { result, ts: Date.now() })
      return result
    } finally {
      IN_FLIGHT.delete(key)
    }
  })()
  IN_FLIGHT.set(key, promise)
  return promise
}

export function useWidgetData(
  config: WidgetConfig,
  globalFilters: GlobalFilterState | undefined,
  deps: unknown[] = []
): { data: WidgetQueryResult | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<WidgetQueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (config.type === 'text') { setData(null); setLoading(false); return }
    if (!config.dataSource) { setData(null); setLoading(false); return }

    // Debounce so rapid filter changes don't cause flood
    if (timerRef.current) clearTimeout(timerRef.current)
    setLoading(true)
    setError(null)

    timerRef.current = setTimeout(async () => {
      const payload = {
        ...stripNonQueryFields(config),
        globalFilters: config.ignoreGlobalFilters ? undefined : globalFilters
      }
      const key = cacheKey(config, config.ignoreGlobalFilters ? undefined : globalFilters)
      try {
        const result = await fetchOnce(key, payload)
        setData(result)
        setError(null)
      } catch (err) {
        setError(String(err))
        setData(null)
      } finally {
        setLoading(false)
      }
    }, 250)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config), JSON.stringify(globalFilters), ...deps])

  return { data, loading, error }
}

export function clearWidgetCache(): void {
  CACHE.clear()
}
