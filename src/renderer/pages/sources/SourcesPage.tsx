import { useEffect, useState } from 'react'
import { useSourceStore } from '@renderer/stores/sourceStore'
import {
  Database, Play, Pause, RefreshCw, AlertCircle,
  Clock, CheckCircle, Loader2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Switch } from '@renderer/components/ui/switch'
import { DISCIPLINE_LABELS, type Discipline, type Source } from '@common/types/intel'
import { formatRelativeTime } from '@renderer/lib/utils'
import { ipc } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'

const DISCIPLINE_COLORS: Record<string, string> = {
  osint: 'bg-blue-500', cybint: 'bg-red-500', finint: 'bg-emerald-500', socmint: 'bg-violet-500',
  geoint: 'bg-amber-500', sigint: 'bg-cyan-500', rumint: 'bg-orange-500', ci: 'bg-pink-500', agency: 'bg-indigo-500'
}

export function SourcesPage() {
  const { sources, loading, fetchSources } = useSourceStore()
  const [collectingIds, setCollectingIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchSources()
    const interval = setInterval(fetchSources, 10000)
    return () => clearInterval(interval)
  }, [fetchSources])

  const handleCollectNow = async (sourceId: string) => {
    setCollectingIds((prev) => new Set(prev).add(sourceId))
    try {
      await ipc.sources.collectNow(sourceId)
    } catch (err) {
      console.error('Collection failed:', err)
    } finally {
      setCollectingIds((prev) => {
        const next = new Set(prev)
        next.delete(sourceId)
        return next
      })
      fetchSources()
    }
  }

  const handleToggle = async (source: Source) => {
    await ipc.sources.update(source.id, { enabled: !source.enabled })
    fetchSources()
  }

  // Group by discipline
  const grouped = new Map<Discipline, Source[]>()
  for (const source of sources) {
    const list = grouped.get(source.discipline) || []
    list.push(source)
    grouped.set(source.discipline, list)
  }

  const enabledCount = sources.filter((s) => s.enabled).length
  const errorCount = sources.filter((s) => s.lastError).length

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Database className="h-6 w-6 text-muted-foreground" />
            Intelligence Sources
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {sources.length} sources configured, {enabledCount} active
            {errorCount > 0 && `, ${errorCount} with errors`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSources} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <Database className="h-8 w-8 text-primary" />
            <div>
              <p className="text-2xl font-bold">{sources.length}</p>
              <p className="text-xs text-muted-foreground">Total Sources</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <Play className="h-8 w-8 text-green-500" />
            <div>
              <p className="text-2xl font-bold">{enabledCount}</p>
              <p className="text-xs text-muted-foreground">Active</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <Pause className="h-8 w-8 text-yellow-500" />
            <div>
              <p className="text-2xl font-bold">{sources.length - enabledCount}</p>
              <p className="text-xs text-muted-foreground">Paused</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <AlertCircle className="h-8 w-8 text-red-500" />
            <div>
              <p className="text-2xl font-bold">{errorCount}</p>
              <p className="text-xs text-muted-foreground">Errors</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sources by discipline */}
      {Array.from(grouped.entries()).map(([discipline, disciplineSources]) => (
        <Card key={discipline}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <span className={cn('h-3 w-3 rounded-full', DISCIPLINE_COLORS[discipline])} />
              <CardTitle className="text-base">
                {DISCIPLINE_LABELS[discipline]} ({discipline.toUpperCase()})
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                {disciplineSources.filter((s) => s.enabled).length}/{disciplineSources.length} active
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-0.5">
              {disciplineSources.map((source) => {
                const isCollecting = collectingIds.has(source.id)
                return (
                  <div
                    key={source.id}
                    className="flex items-center gap-3 py-2.5 px-2 rounded-md hover:bg-accent/30 transition-colors"
                  >
                    {/* Status dot */}
                    <span className={cn(
                      'h-2 w-2 rounded-full shrink-0',
                      !source.enabled ? 'bg-gray-500' :
                      source.lastError ? 'bg-red-500' :
                      source.lastCollectedAt ? 'bg-green-500' : 'bg-yellow-500'
                    )} />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{source.name}</span>
                        <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{source.type}</Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground">
                        {source.schedule && (
                          <span className="flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {source.schedule}
                          </span>
                        )}
                        {source.lastCollectedAt && (
                          <span className="flex items-center gap-0.5">
                            <CheckCircle className="h-2.5 w-2.5 text-green-500" />
                            {formatRelativeTime(source.lastCollectedAt)}
                          </span>
                        )}
                        {source.lastError && (
                          <span className="flex items-center gap-0.5 text-red-400 max-w-xs truncate">
                            <AlertCircle className="h-2.5 w-2.5 shrink-0" />
                            {source.lastError.slice(0, 60)}
                          </span>
                        )}
                        {source.errorCount > 0 && (
                          <span className="text-red-400">({source.errorCount} errors)</span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={!source.enabled || isCollecting}
                      onClick={() => handleCollectNow(source.id)}
                    >
                      {isCollecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <><Play className="h-3 w-3 mr-1" /> Collect</>
                      )}
                    </Button>
                    <Switch
                      checked={source.enabled}
                      onCheckedChange={() => handleToggle(source)}
                    />
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
