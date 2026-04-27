import { useEffect, useState, useCallback } from 'react'
import { Activity, RefreshCw, Loader2, Play, Power, AlertTriangle, CheckCircle2, XCircle, MinusCircle, Clock, Cpu, ChevronRight, Zap, Inbox, Bell, Check } from 'lucide-react'
import { Card } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'

/**
 * Health Dashboard — real-time view of every component Sentinel is
 * supervising. Aggregate counters at the top, per-service grid below,
 * resource governor stats + LLM token spend chart, and recent restart
 * history.
 *
 * Auto-refreshes every 5s.
 */

interface ServiceHealth {
  service_id: string
  display_name: string
  category: string
  state: 'running' | 'degraded' | 'failed' | 'stopped' | 'unknown'
  last_check_at: number | null
  last_state_change_at: number | null
  last_error: string | null
  consecutive_failures: number
  restart_count: number
  restart_disabled: number
  uptime_started_at: number | null
  metadata_json: string | null
}

interface RestartEntry {
  id: string
  serviceId: string
  serviceDisplayName: string | null
  triggeredBy: string
  previousState: string | null
  reason: string
  succeeded: 0 | 1
  durationMs: number
  createdAt: number
}

interface GovernorStats {
  config: {
    maxLlmTokensPerHour: number
    maxConcurrentFetches: number
    maxMemoryMb: number
    maxDiskGb: number
    enforceBudget: boolean
  }
  llmTokensLastHour: number
  llmTokensRemaining: number
  inFlightFetches: number
  memoryMb: number
  memoryPct: number
}

interface ModelUsage {
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  avgDurationMs: number
}

interface Snapshot {
  takenAt: number
  servicesRunning: number
  servicesDegraded: number
  servicesFailed: number
  enrichmentQueueDepth: number
  memoryMb: number | null
  llmTokensLastHour: number
}

interface Circuit {
  circuitId: string
  state: 'closed' | 'open' | 'half_open'
  failureCount: number
  openedAt: number | null
  lastFailureAt: number | null
  lastFailureMessage: string | null
}

interface DlqStats {
  active: number
  replayed: number
  discarded: number
  byKind: Record<string, number>
}

interface OpsAlert {
  id: string
  severity: string | null
  source: string | null
  title: string | null
  body: string | null
  created_at: number
  escalated_at: number | null
  acknowledged_at: number | null
}

interface EscalationStats {
  unacknowledged: number
  bySeverity: Record<string, number>
  lastDay: number
}

const STATE_ICONS = {
  running: CheckCircle2, degraded: AlertTriangle, failed: XCircle,
  stopped: Power, unknown: MinusCircle
}
const STATE_COLORS = {
  running: 'text-emerald-400',
  degraded: 'text-amber-400',
  failed: 'text-red-400',
  stopped: 'text-slate-500',
  unknown: 'text-slate-400'
}
const STATE_BADGES = {
  running: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  degraded: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  failed: 'bg-red-500/10 text-red-300 border-red-500/30',
  stopped: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
  unknown: 'bg-slate-500/10 text-slate-400 border-slate-500/30'
}
const CATEGORY_LABELS: Record<string, string> = {
  collector: 'Collectors', enrichment: 'Enrichment', llm: 'LLM',
  sync: 'Sync', infrastructure: 'Infrastructure', calibration: 'Calibration',
  training: 'Training'
}

function formatTime(ts: number | null): string {
  if (!ts) return 'never'
  const delta = Date.now() - ts
  if (delta < 1000) return 'just now'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

function formatUptime(ts: number | null): string {
  if (!ts) return '—'
  const delta = Date.now() - ts
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86400_000) {
    const h = Math.floor(delta / 3600_000)
    const m = Math.floor((delta % 3600_000) / 60_000)
    return `${h}h ${m}m`
  }
  return `${Math.floor(delta / 86400_000)}d`
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export function HealthDashboardPage() {
  const [services, setServices] = useState<ServiceHealth[]>([])
  const [restarts, setRestarts] = useState<RestartEntry[]>([])
  const [governor, setGovernor] = useState<GovernorStats | null>(null)
  const [models, setModels] = useState<ModelUsage[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [circuits, setCircuits] = useState<Circuit[]>([])
  const [dlqStats, setDlqStats] = useState<DlqStats | null>(null)
  const [opsAlerts, setOpsAlerts] = useState<OpsAlert[]>([])
  const [escStats, setEscStats] = useState<EscalationStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, r, g, m, sn, c, dlq, oa, es] = await Promise.all([
        window.heimdall.invoke('sentinel:services') as Promise<{ ok: boolean; services?: ServiceHealth[] }>,
        window.heimdall.invoke('sentinel:restart_history', 25) as Promise<{ ok: boolean; history?: RestartEntry[] }>,
        window.heimdall.invoke('governor:stats') as Promise<{ ok: boolean } & GovernorStats>,
        window.heimdall.invoke('governor:usage_by_model', 24) as Promise<{ ok: boolean; models?: ModelUsage[] }>,
        window.heimdall.invoke('sentinel:snapshots', 60) as Promise<{ ok: boolean; snapshots?: Snapshot[] }>,
        window.heimdall.invoke('sentinel:circuits') as Promise<{ ok: boolean; circuits?: Circuit[] }>,
        window.heimdall.invoke('sentinel:dlq_stats') as Promise<{ ok: boolean } & DlqStats>,
        window.heimdall.invoke('escalation:recent_alerts', 30) as Promise<{ ok: boolean; alerts?: OpsAlert[] }>,
        window.heimdall.invoke('escalation:stats') as Promise<{ ok: boolean } & EscalationStats>
      ])
      if (s.ok && s.services) setServices(s.services)
      if (r.ok && r.history) setRestarts(r.history)
      if (g.ok) setGovernor({
        config: g.config, llmTokensLastHour: g.llmTokensLastHour,
        llmTokensRemaining: g.llmTokensRemaining, inFlightFetches: g.inFlightFetches,
        memoryMb: g.memoryMb, memoryPct: g.memoryPct
      })
      if (m.ok && m.models) setModels(m.models)
      if (sn.ok && sn.snapshots) setSnapshots([...sn.snapshots].reverse())
      if (c.ok && c.circuits) setCircuits(c.circuits)
      if (dlq.ok) setDlqStats({ active: dlq.active, replayed: dlq.replayed, discarded: dlq.discarded, byKind: dlq.byKind })
      if (oa.ok && oa.alerts) setOpsAlerts(oa.alerts)
      if (es.ok) setEscStats({ unacknowledged: es.unacknowledged, bySeverity: es.bySeverity, lastDay: es.lastDay })
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const pollNow = async () => {
    setPolling(true)
    try {
      await window.heimdall.invoke('sentinel:poll_now')
      await load()
    } catch (err) { toast.error(String(err)) }
    setPolling(false)
  }

  const restartService = async (id: string) => {
    toast.info(`Restarting ${id}…`)
    try {
      const r = await window.heimdall.invoke('sentinel:restart_service', id) as { ok: boolean; error?: string }
      if (r.ok) toast.success(`${id} restarted`)
      else toast.error(`Restart failed: ${r.error}`)
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const enableAutoRestart = async (id: string) => {
    try {
      await window.heimdall.invoke('sentinel:enable_auto_restart', id)
      toast.success(`Auto-restart re-enabled for ${id}`)
      load()
    } catch (err) { toast.error(String(err)) }
  }

  // Group services by category
  const servicesByCategory: Record<string, ServiceHealth[]> = {}
  for (const s of services) {
    if (!servicesByCategory[s.category]) servicesByCategory[s.category] = []
    servicesByCategory[s.category].push(s)
  }

  // Aggregate counts
  const counts = {
    running: services.filter((s) => s.state === 'running').length,
    degraded: services.filter((s) => s.state === 'degraded').length,
    failed: services.filter((s) => s.state === 'failed').length,
    stopped: services.filter((s) => s.state === 'stopped').length,
    total: services.length
  }

  // Sparkline data — last 60 snapshots
  const maxFailed = Math.max(1, ...snapshots.map((s) => s.servicesFailed + s.servicesDegraded))
  const maxTokens = Math.max(1, ...snapshots.map((s) => s.llmTokensLastHour))

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
    </div>
  )

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="border-b border-border px-6 py-4 sticky top-0 bg-background z-10">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Activity className="w-6 h-6 text-emerald-400" />
            <div>
              <h1 className="text-xl font-semibold">System Health</h1>
              <p className="text-xs text-muted-foreground">
                Sentinel supervisor monitors every long-running service. Auto-refresh every 5s.
              </p>
            </div>
          </div>
          <Button onClick={pollNow} disabled={polling} size="sm">
            {polling ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Poll now
          </Button>
        </div>

        <div className="grid grid-cols-5 gap-2 text-xs">
          <Card className="px-3 py-2">
            <div className="text-muted-foreground">Total services</div>
            <div className="text-2xl font-semibold">{counts.total}</div>
          </Card>
          <Card className="px-3 py-2 border-emerald-500/30">
            <div className="text-emerald-300/70">Running</div>
            <div className="text-2xl font-semibold text-emerald-300">{counts.running}</div>
          </Card>
          <Card className={`px-3 py-2 ${counts.degraded > 0 ? 'border-amber-500/30' : ''}`}>
            <div className="text-amber-300/70">Degraded</div>
            <div className={`text-2xl font-semibold ${counts.degraded > 0 ? 'text-amber-300' : 'text-muted-foreground'}`}>{counts.degraded}</div>
          </Card>
          <Card className={`px-3 py-2 ${counts.failed > 0 ? 'border-red-500/30' : ''}`}>
            <div className="text-red-300/70">Failed</div>
            <div className={`text-2xl font-semibold ${counts.failed > 0 ? 'text-red-300' : 'text-muted-foreground'}`}>{counts.failed}</div>
          </Card>
          <Card className="px-3 py-2">
            <div className="text-muted-foreground">Stopped</div>
            <div className="text-2xl font-semibold text-slate-400">{counts.stopped}</div>
          </Card>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Resource Governor */}
        {governor && (
          <Card>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-400" />
                <div className="text-sm font-semibold">Resource Governor</div>
                {!governor.config.enforceBudget && <Badge variant="outline" className="text-[9px] text-amber-300 border-amber-500/30">enforcement OFF</Badge>}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3 p-5">
              <div>
                <div className="text-xs text-muted-foreground mb-1">LLM tokens (last hour)</div>
                <div className="text-lg font-semibold font-mono">{formatNum(governor.llmTokensLastHour)} / {formatNum(governor.config.maxLlmTokensPerHour)}</div>
                <div className="h-1.5 bg-card border border-border rounded-full mt-2 overflow-hidden">
                  <div className={`h-full ${governor.llmTokensLastHour / governor.config.maxLlmTokensPerHour > 0.8 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${Math.min(100, 100 * governor.llmTokensLastHour / governor.config.maxLlmTokensPerHour)}%` }} />
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">In-flight fetches</div>
                <div className="text-lg font-semibold font-mono">{governor.inFlightFetches} / {governor.config.maxConcurrentFetches}</div>
                <div className="h-1.5 bg-card border border-border rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-cyan-400"
                    style={{ width: `${Math.min(100, 100 * governor.inFlightFetches / governor.config.maxConcurrentFetches)}%` }} />
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Process memory</div>
                <div className="text-lg font-semibold font-mono">{governor.memoryMb} MB / {governor.config.maxMemoryMb} MB</div>
                <div className="h-1.5 bg-card border border-border rounded-full mt-2 overflow-hidden">
                  <div className={`h-full ${governor.memoryPct > 80 ? 'bg-red-400' : governor.memoryPct > 60 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${governor.memoryPct}%` }} />
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Tokens remaining (hour)</div>
                <div className="text-lg font-semibold font-mono text-emerald-300">{formatNum(governor.llmTokensRemaining)}</div>
                <div className="text-[10px] text-muted-foreground mt-2">resets at next clock minute</div>
              </div>
            </div>
            {/* LLM usage by model */}
            {models.length > 0 && (
              <div className="px-5 py-3 border-t border-border">
                <div className="text-xs text-muted-foreground mb-2 uppercase">LLM usage (last 24h)</div>
                <div className="space-y-1">
                  {models.slice(0, 6).map((m) => (
                    <div key={m.model} className="flex items-center gap-3 text-xs">
                      <span className="font-mono w-44 truncate">{m.model}</span>
                      <span className="text-muted-foreground w-20 text-right">{m.calls} calls</span>
                      <span className="font-mono text-cyan-300 w-24 text-right">{formatNum(m.totalTokens)} tok</span>
                      <span className="text-muted-foreground w-20 text-right">{m.avgDurationMs}ms avg</span>
                      <div className="flex-1 h-1.5 bg-card border border-border rounded-full overflow-hidden">
                        <div className="h-full bg-cyan-400/60"
                          style={{ width: `${Math.min(100, 100 * m.totalTokens / models[0].totalTokens)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Services grouped by category */}
        {Object.entries(servicesByCategory).map(([cat, svcs]) => (
          <Card key={cat}>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="text-sm font-semibold">{CATEGORY_LABELS[cat] || cat}</div>
              <span className="text-xs text-muted-foreground">{svcs.length} service{svcs.length === 1 ? '' : 's'}</span>
            </div>
            <div className="divide-y divide-border">
              {svcs.map((s) => {
                const Icon = STATE_ICONS[s.state]
                const meta = s.metadata_json ? JSON.parse(s.metadata_json) as Record<string, unknown> : null
                return (
                  <div key={s.service_id} className="px-5 py-3 flex items-start gap-3 hover:bg-accent/20">
                    <Icon className={`w-4 h-4 mt-1 shrink-0 ${STATE_COLORS[s.state]}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{s.display_name}</span>
                        <Badge variant="outline" className={`text-[9px] capitalize ${STATE_BADGES[s.state]}`}>{s.state}</Badge>
                        {s.restart_disabled === 1 && (
                          <Badge variant="outline" className="text-[9px] bg-red-500/10 text-red-300 border-red-500/30">circuit broken</Badge>
                        )}
                        {s.restart_count > 0 && (
                          <Badge variant="outline" className="text-[9px]">{s.restart_count} restart{s.restart_count === 1 ? '' : 's'}</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground font-mono">
                        <span className="flex items-center gap-1"><Clock className="w-2.5 h-2.5" /> uptime {formatUptime(s.uptime_started_at)}</span>
                        <span>checked {formatTime(s.last_check_at)}</span>
                        {s.consecutive_failures > 0 && <span className="text-red-300">consec failures: {s.consecutive_failures}</span>}
                      </div>
                      {s.last_error && (
                        <div className="text-[11px] text-red-300/80 italic mt-1 truncate" title={s.last_error}>{s.last_error}</div>
                      )}
                      {meta && Object.keys(meta).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {Object.entries(meta).slice(0, 6).map(([k, v]) => (
                            <span key={k} className="text-[9px] px-1.5 py-0.5 rounded bg-card border border-border font-mono text-muted-foreground">
                              {k}: {String(v).slice(0, 30)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {s.restart_disabled === 1 ? (
                        <Button size="sm" variant="outline" onClick={() => enableAutoRestart(s.service_id)} className="h-7 text-xs">
                          Re-enable auto
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => restartService(s.service_id)} className="h-7 text-xs" title="Manual restart">
                        <Play className="w-3 h-3 mr-1" /> Restart
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        ))}

        {/* Self-healing: Circuit Breakers + Dead-Letter Queue */}
        {(circuits.length > 0 || (dlqStats && dlqStats.active > 0)) && (
          <Card>
            <div className="px-5 py-3 border-b border-border">
              <div className="text-sm font-semibold flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-400" /> Self-Healing
              </div>
              <div className="text-[10px] text-muted-foreground">
                Circuit breakers wrap fragile operations (LLM calls, fetches). Dead-Letter Queue holds jobs that exhausted retries.
              </div>
            </div>
            <div className="px-5 py-3 grid grid-cols-2 gap-4">
              {/* Circuits */}
              <div>
                <div className="text-xs text-muted-foreground mb-2 uppercase">Circuit breakers ({circuits.length})</div>
                {circuits.length === 0 ? (
                  <p className="text-xs italic text-muted-foreground">No circuits yet — they appear after the first failure.</p>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {circuits.map((c) => (
                      <div key={c.circuitId} className="flex items-center gap-2 text-xs border border-border rounded px-2 py-1">
                        <span className={`w-2 h-2 rounded-full ${
                          c.state === 'open' ? 'bg-red-400' : c.state === 'half_open' ? 'bg-amber-400' : 'bg-emerald-400'
                        }`} />
                        <span className="font-mono flex-1 truncate" title={c.circuitId}>{c.circuitId}</span>
                        <Badge variant="outline" className="text-[9px] capitalize">{c.state.replace('_', ' ')}</Badge>
                        {c.failureCount > 0 && <span className="text-red-300 text-[9px]">{c.failureCount} fail</span>}
                        {c.state !== 'closed' && (
                          <button
                            onClick={async () => {
                              await window.heimdall.invoke('sentinel:circuit_reset', c.circuitId)
                              toast.success(`Circuit ${c.circuitId} reset`)
                              load()
                            }}
                            className="text-[9px] text-cyan-300 hover:text-cyan-200"
                            title="Manually reset to CLOSED"
                          >
                            reset
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* DLQ */}
              <div>
                <div className="text-xs text-muted-foreground mb-2 uppercase">Dead-Letter Queue</div>
                {dlqStats ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="font-semibold text-amber-300">{dlqStats.active} active</span>
                      <span className="text-muted-foreground">{dlqStats.replayed} replayed</span>
                      <span className="text-muted-foreground">{dlqStats.discarded} discarded</span>
                    </div>
                    {Object.keys(dlqStats.byKind).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(dlqStats.byKind).map(([k, n]) => (
                          <Badge key={k} variant="outline" className="text-[9px]">{k}: {n}</Badge>
                        ))}
                      </div>
                    )}
                    {dlqStats.active === 0 && <p className="text-xs italic text-muted-foreground">Queue empty.</p>}
                  </div>
                ) : <Loader2 className="w-4 h-4 animate-spin" />}
              </div>
            </div>
          </Card>
        )}

        {/* Operational alerts + escalation */}
        {escStats && (
          <Card>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div className="text-sm font-semibold flex items-center gap-2">
                <Bell className="w-4 h-4 text-cyan-400" /> Operational Alerts
              </div>
              <div className="flex items-center gap-2 text-xs">
                {escStats.unacknowledged > 0 && (
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-300 border-amber-500/30">
                    {escStats.unacknowledged} unacknowledged
                  </Badge>
                )}
                <span className="text-muted-foreground">{escStats.lastDay} in last 24h</span>
              </div>
            </div>
            <div className="divide-y divide-border max-h-72 overflow-y-auto">
              {opsAlerts.length === 0 ? (
                <p className="text-xs italic text-muted-foreground px-5 py-4">No operational alerts yet.</p>
              ) : opsAlerts.map((a) => (
                <div key={a.id} className="px-5 py-2 flex items-start gap-3 text-xs">
                  <span className={`w-2 h-2 rounded-full mt-1.5 ${
                    a.severity === 'critical' ? 'bg-red-500' :
                    a.severity === 'high' ? 'bg-orange-400' :
                    a.severity === 'medium' ? 'bg-amber-400' : 'bg-slate-400'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[9px] capitalize">{a.severity}</Badge>
                      {a.source && <span className="text-muted-foreground font-mono">{a.source}</span>}
                      <span className="font-medium truncate">{a.title}</span>
                      {a.escalated_at && !a.acknowledged_at && (
                        <Badge variant="outline" className="text-[9px] bg-cyan-500/10 text-cyan-300 border-cyan-500/30">escalated</Badge>
                      )}
                      {a.acknowledged_at && (
                        <Badge variant="outline" className="text-[9px] bg-emerald-500/10 text-emerald-300 border-emerald-500/30">acked</Badge>
                      )}
                    </div>
                    {a.body && <div className="text-[10px] text-muted-foreground italic mt-0.5 truncate">{a.body}</div>}
                    <div className="text-[9px] text-muted-foreground mt-0.5">{formatTime(a.created_at)}</div>
                  </div>
                  {!a.acknowledged_at && (
                    <button
                      onClick={async () => {
                        await window.heimdall.invoke('escalation:acknowledge', { alertId: a.id })
                        toast.success('Alert acknowledged')
                        load()
                      }}
                      className="text-cyan-300 hover:text-cyan-200 px-2 py-1 rounded text-[10px] border border-border"
                    >
                      <Check className="w-3 h-3 inline mr-1" /> Ack
                    </button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Health snapshot history (mini-chart) */}
        {snapshots.length > 0 && (
          <Card>
            <div className="px-5 py-3 border-b border-border">
              <div className="text-sm font-semibold">Recent history</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Last {snapshots.length} snapshots (~30s apart). Top: failed/degraded count. Bottom: hourly LLM tokens.</div>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Failed + Degraded</div>
                <div className="flex items-end gap-0.5 h-10">
                  {snapshots.map((s, i) => {
                    const v = s.servicesFailed + s.servicesDegraded
                    const h = Math.max(2, Math.round(40 * v / maxFailed))
                    return <div key={i} className={`flex-1 ${v === 0 ? 'bg-emerald-400/30' : v >= 3 ? 'bg-red-400' : 'bg-amber-400'} rounded-sm`} style={{ height: h }} title={`${v} unhealthy at ${formatTime(s.takenAt)}`} />
                  })}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">LLM tokens (rolling hour)</div>
                <div className="flex items-end gap-0.5 h-10">
                  {snapshots.map((s, i) => {
                    const h = Math.max(2, Math.round(40 * s.llmTokensLastHour / maxTokens))
                    return <div key={i} className="flex-1 bg-cyan-400/60 rounded-sm" style={{ height: h }} title={`${formatNum(s.llmTokensLastHour)} tok at ${formatTime(s.takenAt)}`} />
                  })}
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Recent restarts */}
        {restarts.length > 0 && (
          <Card>
            <div className="px-5 py-3 border-b border-border">
              <div className="text-sm font-semibold">Recent restarts</div>
            </div>
            <div className="divide-y divide-border max-h-72 overflow-y-auto">
              {restarts.map((r) => (
                <div key={r.id} className="px-5 py-2 flex items-center gap-3 text-xs">
                  {r.succeeded === 1 ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <XCircle className="w-3.5 h-3.5 text-red-400" />}
                  <span className="font-medium w-44 truncate">{r.serviceDisplayName || r.serviceId}</span>
                  <Badge variant="outline" className="text-[9px]">{r.triggeredBy}</Badge>
                  {r.previousState && <span className="text-muted-foreground">from {r.previousState}</span>}
                  <span className="font-mono text-muted-foreground">{r.durationMs}ms</span>
                  <span className="ml-auto text-muted-foreground">{formatTime(r.createdAt)}</span>
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
