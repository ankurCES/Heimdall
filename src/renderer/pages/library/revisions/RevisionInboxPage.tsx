import { useEffect, useState, useCallback } from 'react'
import { Inbox, Loader2, RefreshCw, Check, X, AlertTriangle, FileText } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { toast } from 'sonner'

/**
 * Revision Inbox — pending auto-revision suggestions. The
 * AutoRevisionService detects when new intel contradicts a published
 * report's key judgment and creates a row here. Analyst reviews and
 * either acknowledges (intent to manually revise), dismisses (false
 * positive), or triggers regeneration (Phase 1.1.7b).
 */

interface Revision {
  id: string
  reportId: string
  reportTitle: string
  triggerType: string
  affectedJudgment: string | null
  triggerEvidence: string | null
  triggerIntelId: string | null
  triggerIntelTitle: string | null
  createdAt: number
  status: string
}

function formatTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

export function RevisionInboxPage() {
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.heimdall.invoke('revisions:pending') as { ok: boolean; revisions?: Revision[] }
      if (r.ok) setRevisions(r.revisions || [])
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t) }, [load])

  const runNow = async () => {
    setRunning(true)
    toast.info('Running contradiction scan…')
    try {
      const r = await window.heimdall.invoke('revisions:run_now') as { ok: boolean; pendingCreated?: number }
      if (r.ok) toast.success(`Scan complete — ${r.pendingCreated} new revision(s) flagged`)
    } catch (err) { toast.error(String(err)) }
    setRunning(false)
    load()
  }

  const acknowledge = async (id: string) => {
    try {
      await window.heimdall.invoke('revisions:acknowledge', { id })
      toast.success('Revision acknowledged')
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const dismiss = async (id: string) => {
    try {
      await window.heimdall.invoke('revisions:dismiss', { id })
      toast.success('Revision dismissed')
      load()
    } catch (err) { toast.error(String(err)) }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Inbox className="w-6 h-6 text-amber-400" />
            <div>
              <h1 className="text-xl font-semibold">Revision Inbox</h1>
              <p className="text-xs text-muted-foreground">
                Pending revisions where new intel contradicts a published report's key judgment.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">{revisions.length} pending</Badge>
            <Button onClick={runNow} disabled={running} size="sm">
              {running ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Scan now
            </Button>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {loading && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}
        {!loading && revisions.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <Check className="w-10 h-10 mx-auto mb-3 opacity-30 text-emerald-400" />
            <p className="text-sm">Inbox empty — no pending revisions.</p>
            <p className="text-xs mt-2 opacity-70">Scan runs automatically every 30 minutes.</p>
          </div>
        )}
        {revisions.length > 0 && (
          <div className="space-y-3">
            {revisions.map((rev) => (
              <Card key={rev.id} className="p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-300 border-amber-500/30 capitalize">
                        {rev.triggerType.replace('_', ' ')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{formatTime(rev.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm font-medium mb-2">
                      <FileText className="w-3.5 h-3.5 text-cyan-400" />
                      <span className="truncate">{rev.reportTitle}</span>
                    </div>
                    {rev.affectedJudgment && (
                      <div className="text-xs mb-2">
                        <span className="text-muted-foreground uppercase mr-2">Judgment at risk:</span>
                        <span className="italic">"{rev.affectedJudgment}"</span>
                      </div>
                    )}
                    {rev.triggerEvidence && (
                      <div className="text-xs mb-2 border-l-2 border-amber-500/40 pl-3 py-1 bg-amber-500/5">
                        <span className="text-muted-foreground uppercase mr-2">Contradicting evidence:</span>
                        <span>{rev.triggerEvidence}</span>
                        {rev.triggerIntelTitle && (
                          <div className="text-[10px] text-muted-foreground mt-1">— from "{rev.triggerIntelTitle}"</div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="outline" onClick={() => acknowledge(rev.id)} className="h-7 text-xs">
                        <Check className="w-3 h-3 mr-1" /> Acknowledge
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => dismiss(rev.id)} className="h-7 text-xs text-muted-foreground">
                        <X className="w-3 h-3 mr-1" /> Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
