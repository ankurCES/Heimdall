import { useMemo, useState } from 'react'
import { Loader2, ArrowUpDown } from 'lucide-react'
import type { WidgetConfig, GlobalFilterState } from '@common/analytics/types'
import { useWidgetData } from '../useWidgetData'
import { DISCIPLINE_LABELS } from '@common/types/intel'

interface Props {
  config: WidgetConfig
  globalFilters?: GlobalFilterState
}

export function TableWidget({ config, globalFilters }: Props) {
  const { data, loading } = useWidgetData(config, globalFilters)
  const [sortDesc, setSortDesc] = useState(true)

  const rows = useMemo(() => {
    const list = (data?.data || []).slice()
    list.sort((a, b) => sortDesc ? b.value - a.value : a.value - b.value)
    return list
  }, [data, sortDesc])

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }
  if (rows.length === 0) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">No rows</div>
  }

  const labelCol = config.groupBy ? config.groupBy.replace(/_/g, ' ') : 'Label'

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card z-10">
          <tr className="border-b border-border">
            <th className="text-left py-1.5 px-3 font-semibold capitalize">{labelCol}</th>
            <th className="text-right py-1.5 px-3 font-semibold">
              <button
                onClick={() => setSortDesc((s) => !s)}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                Value <ArrowUpDown className="h-3 w-3" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const label = config.groupBy === 'discipline'
              ? (DISCIPLINE_LABELS[r.label as keyof typeof DISCIPLINE_LABELS] || r.label)
              : r.label
            return (
              <tr key={`${r.label}-${i}`} className="border-b border-border/50 hover:bg-accent/30">
                <td className="py-1 px-3 truncate max-w-[300px]">{label}</td>
                <td className="py-1 px-3 text-right font-mono tabular-nums">{r.value.toLocaleString()}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
