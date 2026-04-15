import { Clock, Filter, X } from 'lucide-react'
import { useAnalyticsStore } from '@renderer/stores/analyticsStore'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Button } from '@renderer/components/ui/button'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import { cn } from '@renderer/lib/utils'
import type { TimeRange } from '@common/analytics/types'

const TIME_RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '3d', label: 'Last 3 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' }
]

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const

export function GlobalSlicers() {
  const { currentReport, setGlobalFilters } = useAnalyticsStore()
  if (!currentReport) return null

  const f = currentReport.globalFilters || { timeRange: '24h' }
  const disciplines = new Set(f.disciplines || [])
  const severities = new Set(f.severities || [])

  const toggleDiscipline = (d: string) => {
    const next = new Set(disciplines)
    if (next.has(d)) next.delete(d); else next.add(d)
    setGlobalFilters({ ...f, disciplines: next.size > 0 ? Array.from(next) : undefined })
  }

  const toggleSeverity = (s: string) => {
    const next = new Set(severities)
    if (next.has(s)) next.delete(s); else next.add(s)
    setGlobalFilters({ ...f, severities: next.size > 0 ? Array.from(next) : undefined })
  }

  const hasFilters = disciplines.size > 0 || severities.size > 0

  return (
    <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-border bg-card/30">
      <div className="flex items-center gap-1.5 mr-2">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <Select value={f.timeRange} onValueChange={(v) => setGlobalFilters({ ...f, timeRange: v as TimeRange })}>
          <SelectTrigger className="h-7 text-xs w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TIME_RANGES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
        {Object.entries(DISCIPLINE_LABELS).map(([k, label]) => {
          const on = disciplines.has(k)
          return (
            <button
              key={k}
              onClick={() => toggleDiscipline(k)}
              className={cn(
                'px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors',
                on ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>

      <span className="mx-1 text-muted-foreground/40">|</span>

      <div className="flex items-center gap-1 flex-wrap">
        {SEVERITIES.map((s) => {
          const on = severities.has(s)
          return (
            <button
              key={s}
              onClick={() => toggleSeverity(s)}
              className={cn(
                'px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors capitalize',
                on ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              )}
            >
              {s}
            </button>
          )
        })}
      </div>

      {hasFilters && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs ml-auto"
          onClick={() => setGlobalFilters({ timeRange: f.timeRange })}
        >
          <X className="h-3 w-3 mr-1" />Reset
        </Button>
      )}
    </div>
  )
}
