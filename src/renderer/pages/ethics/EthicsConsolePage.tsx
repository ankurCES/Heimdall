import { useEffect, useState, useCallback } from 'react'
import { ShieldCheck, Loader2, RefreshCw, AlertOctagon, ShieldAlert, Info, FileText, X } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { toast } from 'sonner'

/**
 * Ethics Console — review unresolved ethics flags raised by the
 * EthicsGuardrailsService on report publish. Resolution actions:
 * Override (analyst accepts the flag and proceeds), Redact (analyst
 * will redact the flagged content), Dismiss (false positive).
 *
 * Full blocking enforcement (preventing publication of `block`-severity
 * flags) ships in v1.2 with RBAC (requires two-person sign-off).
 */

interface EthicsFlag {
  id: string
  subjectType: string
  subjectId: string
  flagType: string
  severity: 'info' | 'warning' | 'block'
  evidence: string | null
  createdAt: number
  subjectTitle?: string
}

const SEVERITY_COLORS: Record<string, string> = {
  block: 'bg-red-500/10 text-red-300 border-red-500/30',
  warning: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  info: 'bg-blue-500/10 text-blue-300 border-blue-500/30'
}

const FLAG_TYPE_LABELS: Record<string, string> = {
  targeted_violence: 'Targeted Violence',
  civilian_combatant: 'Civilian/Combatant Ambiguity',
  csam: 'CSAM Pattern',
  humanrights: 'Human-Rights Concern',
  bias: 'Source Bias',
  pii_leak: 'PII Leakage',
  disinfo: 'Disinformation Amplification',
  disclaimer: 'AI-Use Disclaimer'
}

function formatTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

export function EthicsConsolePage() {
  const [flags, setFlags] = useState<EthicsFlag[]>([])
  const [stats, setStats] = useState<{ totalFlags: number; unresolved: number; blocking: number; byType: Record<string, number> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [flagRes, statRes] = await Promise.all([
        window.heimdall.invoke('ethics:unresolved', {
          severity: severityFilter.size > 0 ? Array.from(severityFilter) : undefined
        }) as Promise<{ ok: boolean; flags?: EthicsFlag[] }>,
        window.heimdall.invoke('ethics:stats') as Promise<{ ok: boolean; totalFlags: number; unresolved: number; blocking: number; byType: Record<string, number> }>
      ])
      if (flagRes.ok) setFlags(flagRes.flags || [])
      if (statRes.ok) setStats({ totalFlags: statRes.totalFlags, unresolved: statRes.unresolved, blocking: statRes.blocking, byType: statRes.byType })
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [severityFilter])

  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t) }, [load])

  const resolve = async (id: string, action: 'overridden' | 'redacted' | 'dismissed') => {
    try {
      await window.heimdall.invoke('ethics:resolve', { flagId: id, action })
      toast.success(`Flag ${action}`)
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const toggle = (set: Set<string>, value: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value); else next.add(value)
    setter(next)
  }

  const SeverityIcon = (s: string) => s === 'block' ? AlertOctagon : s === 'warning' ? ShieldAlert : Info

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            <div>
              <h1 className="text-xl font-semibold">Ethics Console</h1>
              <p className="text-xs text-muted-foreground">
                Unresolved ethical-safety flags from generated reports.
                Block-severity flags will require two-person sign-off in v1.2.
              </p>
            </div>
          </div>
          <Button onClick={load} size="sm" variant="outline">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
        {stats && (
          <>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Unresolved</div>
                <div className="text-xl font-semibold">{stats.unresolved}</div>
              </div>
              <div className="border border-red-500/30 rounded px-3 py-2 bg-red-500/5">
                <div className="text-red-300/70">Blocking</div>
                <div className="text-xl font-semibold text-red-300">{stats.blocking}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Total ever raised</div>
                <div className="text-xl font-semibold">{stats.totalFlags}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Categories</div>
                <div className="text-xl font-semibold">{Object.keys(stats.byType).length}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3 text-xs">
              <span className="text-muted-foreground">Severity:</span>
              {(['block', 'warning', 'info'] as const).map((s) => (
                <button key={s} onClick={() => toggle(severityFilter, s, setSeverityFilter)}
                  className={`text-[10px] px-2 py-0.5 rounded border capitalize transition-colors ${severityFilter.has(s) ? SEVERITY_COLORS[s] : 'border-border text-muted-foreground hover:bg-accent'}`}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}
        {!loading && flags.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30 text-emerald-400" />
            <p className="text-sm">No unresolved ethics flags.</p>
            <p className="text-xs mt-2 opacity-70">Flags are raised automatically when reports are published.</p>
          </div>
        )}
        {flags.length > 0 && (
          <div className="space-y-2">
            {flags.map((flag) => {
              const Icon = SeverityIcon(flag.severity)
              return (
                <Card key={flag.id} className="p-3">
                  <div className="flex items-start gap-3">
                    <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${
                      flag.severity === 'block' ? 'text-red-400'
                      : flag.severity === 'warning' ? 'text-amber-400'
                      : 'text-blue-400'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Badge variant="outline" className={`text-[10px] capitalize ${SEVERITY_COLORS[flag.severity]}`}>
                          {flag.severity}
                        </Badge>
                        <span className="text-xs font-medium">{FLAG_TYPE_LABELS[flag.flagType] || flag.flagType}</span>
                        <span className="text-[10px] text-muted-foreground">{formatTime(flag.createdAt)}</span>
                      </div>
                      {flag.subjectTitle && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                          <FileText className="w-3 h-3" />
                          <span className="truncate">{flag.subjectTitle}</span>
                        </div>
                      )}
                      {flag.evidence && (
                        <div className="text-xs italic text-muted-foreground border-l-2 border-border pl-3 my-2">
                          {flag.evidence}
                        </div>
                      )}
                      <div className="flex gap-1 mt-2">
                        <Button size="sm" variant="outline" onClick={() => resolve(flag.id, 'overridden')} className="h-6 text-[10px]">
                          Override
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => resolve(flag.id, 'redacted')} className="h-6 text-[10px]">
                          Mark Redacted
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => resolve(flag.id, 'dismissed')} className="h-6 text-[10px] text-muted-foreground">
                          <X className="w-3 h-3 mr-1" /> Dismiss
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
