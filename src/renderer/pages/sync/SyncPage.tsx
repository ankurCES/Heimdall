import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw, Play, CheckCircle, AlertCircle, Clock,
  Loader2, CloudUpload, Database, Brain, Radio, Layers, BookOpen
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { toast } from 'sonner'
import { formatRelativeTime, cn } from '@renderer/lib/utils'

interface SyncJob {
  id: string
  type: string
  label: string
  status: 'idle' | 'running' | 'completed' | 'error'
  progress: number
  current: number
  total: number
  lastSyncAt: number | null
  lastError: string | null
  itemsSynced: number
}

const JOB_ICONS: Record<string, typeof RefreshCw> = {
  'obsidian-push': CloudUpload,
  'obsidian-pull': BookOpen,
  'vector-db': Database,
  'local-memory': Database,
  'enrichment': Brain,
  'meshtastic': Radio,
  'collectors': Layers
}

const STATUS_CONFIG = {
  idle: { color: 'text-muted-foreground', bg: 'bg-muted', label: 'Idle', icon: Clock },
  running: { color: 'text-blue-500', bg: 'bg-blue-500/10', label: 'Running', icon: Loader2 },
  completed: { color: 'text-green-500', bg: 'bg-green-500/10', label: 'Completed', icon: CheckCircle },
  error: { color: 'text-red-500', bg: 'bg-red-500/10', label: 'Error', icon: AlertCircle }
}

export function SyncPage() {
  const [jobs, setJobs] = useState<SyncJob[]>([])
  const [loading, setLoading] = useState(true)
  const [syncingAll, setSyncingAll] = useState(false)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadJobs = async () => {
    try {
      const result = await invoke('sync:getJobs') as SyncJob[]
      setJobs(result || [])
    } catch {}
    setLoading(false)
  }

  // PERF v1.3.2 D7: dropped the 3s polling loop. The sync:progress push
  // subscription below already streams fresh state on every change.
  // We only need a one-shot initial load.
  useEffect(() => { loadJobs() }, [])

  // Subscribe to real-time progress
  useEffect(() => {
    const unsub = window.heimdall.on('sync:progress', (data: unknown) => {
      setJobs(data as SyncJob[])
    })
    return unsub
  }, [])

  const runJob = async (type: string) => {
    try {
      await invoke('sync:runJob', { type })
      toast.info(`Sync started: ${jobs.find((j) => j.type === type)?.label}`)
      loadJobs()
    } catch (err) {
      toast.error(`Sync failed: ${err}`)
    }
  }

  const runAll = async () => {
    setSyncingAll(true)
    try {
      await invoke('sync:runAll')
      toast.info('Sync all started — running in background')
    } catch (err) {
      toast.error(`Sync all failed: ${err}`)
    }
    setSyncingAll(false)
  }

  const anyRunning = jobs.some((j) => j.status === 'running')
  const totalSynced = jobs.reduce((sum, j) => sum + j.itemsSynced, 0)

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RefreshCw className={cn('h-6 w-6', anyRunning && 'animate-spin text-blue-500')} />
            Sync Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor and control data synchronization across all sources
          </p>
        </div>
        <div className="flex items-center gap-2">
          {anyRunning && <Badge variant="default" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Syncing...</Badge>}
          <Button onClick={runAll} disabled={syncingAll || anyRunning}>
            {syncingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            Sync All
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Synced</p>
            <p className="text-2xl font-bold mt-1">{totalSynced.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Active Jobs</p>
            <p className="text-2xl font-bold mt-1 text-blue-500">{jobs.filter((j) => j.status === 'running').length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Completed</p>
            <p className="text-2xl font-bold mt-1 text-green-500">{jobs.filter((j) => j.status === 'completed').length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Errors</p>
            <p className="text-2xl font-bold mt-1 text-red-500">{jobs.filter((j) => j.status === 'error').length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Jobs list */}
      <div className="space-y-3">
        {jobs.map((job) => {
          const Icon = JOB_ICONS[job.type] || RefreshCw
          const statusCfg = STATUS_CONFIG[job.status]
          const StatusIcon = statusCfg.icon

          return (
            <Card key={job.type} className={cn(job.status === 'running' && 'border-blue-500/30')}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn('p-2 rounded-lg', statusCfg.bg)}>
                      <Icon className={cn('h-5 w-5', statusCfg.color)} />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{job.label}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className={cn('text-[9px] py-0 gap-1', statusCfg.color)}>
                          <StatusIcon className={cn('h-2.5 w-2.5', job.status === 'running' && 'animate-spin')} />
                          {statusCfg.label}
                        </Badge>
                        {job.itemsSynced > 0 && (
                          <span className="text-[10px] text-muted-foreground">{job.itemsSynced.toLocaleString()} items synced</span>
                        )}
                        {job.lastSyncAt && (
                          <span className="text-[10px] text-muted-foreground">Last: {formatRelativeTime(job.lastSyncAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* Progress */}
                    {job.status === 'running' && job.total > 0 && (
                      <div className="text-right">
                        <div className="text-xs font-mono">{job.current} / {job.total}</div>
                        <div className="w-32 h-1.5 bg-muted rounded-full mt-1 overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-300"
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Error */}
                    {job.status === 'error' && job.lastError && (
                      <span className="text-[10px] text-red-400 max-w-48 truncate">{job.lastError}</span>
                    )}

                    {/* Sync button */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => runJob(job.type)}
                      disabled={job.status === 'running'}
                    >
                      {job.status === 'running' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <><Play className="h-3.5 w-3.5 mr-1" /> Sync</>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
