import { useState } from 'react'
import { BarChart3, Network } from 'lucide-react'
import { RelationshipGraph } from './RelationshipGraph'
import { ReportSelector } from './analytics/ReportSelector'
import { GlobalSlicers } from './analytics/GlobalSlicers'
import { DashboardCanvas } from './analytics/DashboardCanvas'
import { cn } from '@renderer/lib/utils'

type ViewMode = 'analytics' | 'graph'

export function ExplorePage() {
  const [viewMode, setViewMode] = useState<ViewMode>('analytics')

  return (
    <div className="flex flex-col h-full">
      {/* Top view-mode toggle + report selector */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-card/50 flex-wrap">
        <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
          <button
            onClick={() => setViewMode('analytics')}
            className={cn('px-3 py-1 rounded text-xs font-medium', viewMode === 'analytics' ? 'bg-card text-foreground shadow' : 'text-muted-foreground')}
          >
            <BarChart3 className="h-3 w-3 inline mr-1" />Analytics
          </button>
          <button
            onClick={() => setViewMode('graph')}
            className={cn('px-3 py-1 rounded text-xs font-medium', viewMode === 'graph' ? 'bg-card text-foreground shadow' : 'text-muted-foreground')}
          >
            <Network className="h-3 w-3 inline mr-1" />Relationship Graph
          </button>
        </div>

        {viewMode === 'analytics' && <ReportSelector />}
      </div>

      {viewMode === 'analytics' ? (
        <>
          <GlobalSlicers />
          <DashboardCanvas />
        </>
      ) : (
        <div className="flex-1">
          <RelationshipGraph />
        </div>
      )}
    </div>
  )
}
