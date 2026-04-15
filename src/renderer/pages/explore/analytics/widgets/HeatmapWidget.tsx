import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import type { WidgetConfig, GlobalFilterState } from '@common/analytics/types'
import { useWidgetData } from '../useWidgetData'

interface Props {
  config: WidgetConfig
  globalFilters?: GlobalFilterState
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Day-of-week x hour-of-day heatmap. Expects groupBy='dow_hour' which produces
 * labels like '3-14' (Wednesday, 14:00).
 */
export function HeatmapWidget({ config, globalFilters }: Props) {
  const specialConfig = { ...config, groupBy: 'dow_hour' as const }
  const { data, loading } = useWidgetData(specialConfig, globalFilters)

  const matrix = useMemo(() => {
    const m: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
    for (const row of data?.data || []) {
      const parts = row.label.split('-')
      if (parts.length !== 2) continue
      const dow = parseInt(parts[0], 10)
      const hour = parseInt(parts[1], 10)
      if (isNaN(dow) || isNaN(hour)) continue
      if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) m[dow][hour] = row.value
    }
    return m
  }, [data])

  const max = useMemo(() => {
    let mx = 0
    for (const r of matrix) for (const v of r) if (v > mx) mx = v
    return mx
  }, [matrix])

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }
  if (max === 0) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">No data</div>
  }

  return (
    <div className="h-full w-full p-2 flex flex-col">
      <div className="flex items-center gap-1 ml-8 mb-1">
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} className="flex-1 text-[8px] text-muted-foreground/70 text-center">{h % 3 === 0 ? h : ''}</div>
        ))}
      </div>
      <div className="flex-1 flex flex-col gap-1">
        {matrix.map((row, dow) => (
          <div key={dow} className="flex items-center gap-1">
            <div className="w-7 text-[9px] text-muted-foreground/70 text-right">{DOW[dow]}</div>
            <div className="flex-1 flex gap-1">
              {row.map((v, h) => {
                const intensity = v / max
                const bg = v === 0
                  ? 'rgba(148,163,184,0.08)'
                  : `rgba(59,130,246,${0.15 + 0.85 * intensity})`
                return (
                  <div
                    key={h}
                    className="flex-1 rounded-sm"
                    style={{ backgroundColor: bg, minHeight: 12 }}
                    title={`${DOW[dow]} ${h}:00 — ${v}`}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
