import { useMemo } from 'react'
import * as Icons from 'lucide-react'
import { Loader2, TrendingUp, TrendingDown } from 'lucide-react'
import type { WidgetConfig, GlobalFilterState } from '@common/analytics/types'
import { useWidgetData } from '../useWidgetData'
import { cn } from '@renderer/lib/utils'

interface Props {
  config: WidgetConfig
  globalFilters?: GlobalFilterState
}

function formatValue(v: number, format: string | undefined, prefix = '', suffix = ''): string {
  if (format === 'percent') return `${prefix}${v.toFixed(1)}%${suffix}`
  if (format === 'currency') return `${prefix}$${v.toLocaleString()}${suffix}`
  if (format === 'compact') {
    if (Math.abs(v) >= 1_000_000) return `${prefix}${(v / 1_000_000).toFixed(1)}M${suffix}`
    if (Math.abs(v) >= 1_000) return `${prefix}${(v / 1_000).toFixed(1)}k${suffix}`
    return `${prefix}${v.toLocaleString()}${suffix}`
  }
  return `${prefix}${v.toLocaleString()}${suffix}`
}

export function KpiWidget({ config, globalFilters }: Props) {
  const { data, loading } = useWidgetData(config, globalFilters)

  const opts = config.kpiOptions || {}
  const Icon = useMemo(() => {
    if (!opts.icon) return null
    return (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[opts.icon] || null
  }, [opts.icon])

  const value = data?.total ?? data?.data?.[0]?.value ?? 0
  const delta = data?.delta

  return (
    <div className="h-full flex flex-col justify-center px-4 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        {Icon && (
          <div
            className="p-1.5 rounded-md"
            style={{ backgroundColor: `${opts.accentColor || '#3b82f6'}20`, color: opts.accentColor || '#3b82f6' }}
          >
            <Icon className="h-4 w-4" />
          </div>
        )}
        <span className="text-xs text-muted-foreground truncate">{config.title}</span>
      </div>
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <div className="flex items-end gap-2">
          <span className="text-2xl font-bold leading-none tabular-nums">
            {formatValue(Number(value) || 0, opts.format, opts.prefix, opts.suffix)}
          </span>
          {opts.delta && typeof delta === 'number' && (
            <span
              className={cn(
                'text-[10px] font-mono flex items-center gap-0.5',
                delta >= 0 ? 'text-green-500' : 'text-red-500'
              )}
            >
              {delta >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {delta >= 0 ? '+' : ''}{delta}%
            </span>
          )}
        </div>
      )}
      {config.subtitle && <p className="text-[10px] text-muted-foreground/70 mt-1">{config.subtitle}</p>}
    </div>
  )
}
