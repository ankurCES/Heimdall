import { useMemo } from 'react'
import { Bar, Line, Pie, Doughnut } from 'react-chartjs-2'
import { Loader2 } from 'lucide-react'
import type { WidgetConfig, GlobalFilterState } from '@common/analytics/types'
import { useWidgetData } from '../useWidgetData'
import { ensureChartRegistered, CHART_DEFAULTS, colorFor } from '../chartSetup'
import { DISCIPLINE_LABELS } from '@common/types/intel'

ensureChartRegistered()

interface Props {
  config: WidgetConfig
  globalFilters?: GlobalFilterState
}

function prettify(label: string, groupBy: string | undefined): string {
  if (groupBy === 'discipline') return DISCIPLINE_LABELS[label as keyof typeof DISCIPLINE_LABELS] || label
  if (groupBy === 'hour') return `${label.padStart(2, '0')}:00`
  if (groupBy === 'severity') return label.charAt(0).toUpperCase() + label.slice(1)
  return label || 'Unknown'
}

export function ChartWidget({ config, globalFilters }: Props) {
  const { data, loading } = useWidgetData(config, globalFilters)
  const opts = config.chartOptions || {}

  const chartData = useMemo(() => {
    if (config.type === 'timeline' && data?.timeline) {
      return {
        labels: data.timeline.map((t) => new Date(t.bucket).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })),
        datasets: [{
          label: config.title,
          data: data.timeline.map((t) => t.count),
          backgroundColor: 'rgba(59,130,246,0.15)',
          borderColor: '#3b82f6',
          borderWidth: 2,
          fill: true,
          tension: opts.smooth ? 0.3 : 0,
          pointRadius: 0,
          pointHoverRadius: 4
        }]
      }
    }

    const rows = data?.data || []
    const labels = rows.map((r) => prettify(r.label, config.groupBy))
    const values = rows.map((r) => r.value)
    const colors = rows.map((r, i) => colorFor(r.label, opts.colorScheme || 'default', i))

    return {
      labels,
      datasets: [{
        label: config.title,
        data: values,
        backgroundColor: colors,
        borderColor: config.type === 'line' ? '#3b82f6' : colors,
        borderWidth: config.type === 'line' ? 2 : 0,
        borderRadius: config.type === 'bar' ? 4 : 0,
        fill: config.type === 'line' ? { target: 'origin' as const, above: 'rgba(59,130,246,0.1)' } : false,
        tension: opts.smooth ? 0.3 : 0,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    }
  }, [data, config, opts.colorScheme, opts.smooth])

  const chartOpts = useMemo(() => {
    const isPie = config.type === 'pie' || config.type === 'doughnut'
    const legendDisplay = opts.legend && opts.legend !== 'hidden'
    return {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: {
          display: legendDisplay || isPie,
          position: (opts.legend && opts.legend !== 'hidden' ? opts.legend : (isPie ? 'right' : 'top')) as 'top' | 'bottom' | 'left' | 'right',
          labels: { color: '#9ca3af', font: { size: 10 }, boxWidth: 10 }
        }
      },
      scales: isPie ? undefined : {
        x: { ticks: { color: '#9ca3af', font: { size: 9 }, maxRotation: 45 }, grid: { display: false }, stacked: !!opts.stacked },
        y: { ticks: { color: '#9ca3af', font: { size: 9 } }, grid: { color: '#1f2937' }, stacked: !!opts.stacked, beginAtZero: true }
      }
    } as const
  }, [config.type, opts.legend, opts.stacked])

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }

  const empty = (config.type === 'timeline' ? data?.timeline?.length === 0 : data?.data?.length === 0)
  if (!data || empty) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">No data</div>
  }

  const Comp = (() => {
    switch (config.type) {
      case 'line':
      case 'timeline':
        return Line
      case 'pie':
        return Pie
      case 'doughnut':
        return Doughnut
      default:
        return Bar
    }
  })()

  return (
    <div className="h-full w-full p-2">
      <Comp data={chartData as never} options={chartOpts as never} />
    </div>
  )
}
