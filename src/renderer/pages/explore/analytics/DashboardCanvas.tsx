import { useMemo, useState } from 'react'
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout'
import { Plus, Edit3, Eye, Trash2, Settings, Copy } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useAnalyticsStore } from '@renderer/stores/analyticsStore'
import { WidgetRenderer } from './WidgetRenderer'
import { WidgetEditor } from './WidgetEditor'
import { cn } from '@renderer/lib/utils'
import type { WidgetConfig } from '@common/analytics/types'

import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

const ResponsiveGrid = WidthProvider(GridLayout)

export function DashboardCanvas() {
  const {
    currentReport, editMode, setEditMode, setLayout,
    addWidget, updateWidget, removeWidget
  } = useAnalyticsStore()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null)

  const globalFilters = currentReport?.globalFilters

  const gridLayout = useMemo(() => {
    if (!currentReport) return []
    return currentReport.layout.map<Layout>((l) => ({
      i: l.i,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
      minW: l.minW || 2,
      minH: l.minH || 2
    }))
  }, [currentReport])

  if (!currentReport) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading report...
      </div>
    )
  }

  const handleLayoutChange = (newLayout: Layout[]) => {
    if (!editMode) return
    setLayout(newLayout.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h, minW: l.minW, minH: l.minH })))
  }

  const handleEditWidget = (id: string) => {
    const w = currentReport.widgets[id]
    if (!w) return
    setEditingWidget(w)
    setEditorOpen(true)
  }

  const handleAddWidget = () => {
    setEditingWidget(null)
    setEditorOpen(true)
  }

  const handleSaveWidget = (config: WidgetConfig) => {
    if (editingWidget) {
      updateWidget(editingWidget.id, config)
    } else {
      addWidget(config)
    }
    setEditorOpen(false)
  }

  const handleDuplicateWidget = (id: string) => {
    const w = currentReport.widgets[id]
    if (!w) return
    const newId = `w_${Math.random().toString(36).slice(2, 10)}`
    addWidget({ ...w, id: newId, title: `${w.title} (copy)` })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Top bar — mode toggle + add widget */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/30">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{Object.keys(currentReport.widgets).length} widget(s)</span>
          {currentReport.description && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span className="italic">{currentReport.description}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
            <button
              onClick={() => setEditMode(false)}
              className={cn('px-2 py-0.5 rounded text-[11px] font-medium', !editMode ? 'bg-card text-foreground shadow' : 'text-muted-foreground')}
            >
              <Eye className="h-3 w-3 inline mr-1" />View
            </button>
            <button
              onClick={() => setEditMode(true)}
              className={cn('px-2 py-0.5 rounded text-[11px] font-medium', editMode ? 'bg-card text-foreground shadow' : 'text-muted-foreground')}
            >
              <Edit3 className="h-3 w-3 inline mr-1" />Edit
            </button>
          </div>
          <Button size="sm" onClick={handleAddWidget} className="gap-1.5 h-7">
            <Plus className="h-3.5 w-3.5" />Add Widget
          </Button>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto bg-background/50">
        {gridLayout.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm mb-2">Empty canvas</p>
            <Button size="sm" variant="outline" onClick={handleAddWidget}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Add your first widget
            </Button>
          </div>
        ) : (
          <ResponsiveGrid
            className="layout"
            layout={gridLayout}
            cols={12}
            rowHeight={40}
            margin={[10, 10]}
            containerPadding={[12, 12]}
            isDraggable={editMode}
            isResizable={editMode}
            draggableHandle=".drag-handle"
            onLayoutChange={handleLayoutChange}
          >
            {gridLayout.map((l) => {
              const w = currentReport.widgets[l.i]
              if (!w) return <div key={l.i} />
              return (
                <div
                  key={l.i}
                  className={cn(
                    'rounded-lg border border-border bg-card flex flex-col overflow-hidden',
                    editMode && 'ring-1 ring-primary/20'
                  )}
                >
                  {/* Widget chrome */}
                  <div className={cn(
                    'flex items-center justify-between px-3 py-1.5 border-b border-border/50 shrink-0',
                    editMode ? 'drag-handle cursor-move bg-muted/30' : 'bg-transparent'
                  )}>
                    <span className="text-xs font-semibold truncate">{w.title}</span>
                    {editMode && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditWidget(l.i) }}
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                          title="Edit"
                        >
                          <Settings className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDuplicateWidget(l.i) }}
                          className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                          title="Duplicate"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeWidget(l.i) }}
                          className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500"
                          title="Remove"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Widget body */}
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <WidgetRenderer config={w} globalFilters={globalFilters} />
                  </div>
                </div>
              )
            })}
          </ResponsiveGrid>
        )}
      </div>

      <WidgetEditor
        open={editorOpen}
        initial={editingWidget}
        globalFilters={globalFilters}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveWidget}
      />
    </div>
  )
}
