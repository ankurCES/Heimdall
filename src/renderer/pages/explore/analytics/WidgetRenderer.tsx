import type { WidgetConfig, GlobalFilterState } from '@common/analytics/types'
import { KpiWidget } from './widgets/KpiWidget'
import { ChartWidget } from './widgets/ChartWidget'
import { TableWidget } from './widgets/TableWidget'
import { HeatmapWidget } from './widgets/HeatmapWidget'
import { TextWidget } from './widgets/TextWidget'

interface Props {
  config: WidgetConfig
  globalFilters?: GlobalFilterState
}

export function WidgetRenderer({ config, globalFilters }: Props) {
  switch (config.type) {
    case 'kpi':
      return <KpiWidget config={config} globalFilters={globalFilters} />
    case 'bar':
    case 'line':
    case 'pie':
    case 'doughnut':
    case 'timeline':
      return <ChartWidget config={config} globalFilters={globalFilters} />
    case 'table':
      return <TableWidget config={config} globalFilters={globalFilters} />
    case 'heatmap':
      return <HeatmapWidget config={config} globalFilters={globalFilters} />
    case 'text':
      return <TextWidget config={config} />
    default:
      return <div className="p-4 text-xs text-muted-foreground">Unknown widget type: {config.type}</div>
  }
}
