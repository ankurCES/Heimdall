import { useEffect, useState } from 'react'
import { Bug, RefreshCw, Loader2, Unlock, ShieldCheck, AlertOctagon, UserX, Scan } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

type Severity = 'low' | 'med' | 'high'
type Action = 'annotate' | 'quarantine'

interface FlaggedRow {
  report_id: string; title: string; source_name: string; discipline: string;
  severity: Severity; action: Action; matched_rules: string[];
  created_at: number; flagged_at: number; released_at: number | null
}

interface RunRow {
  id: number; started_at: number; finished_at: number;
  reports_scanned: number; reports_flagged: number; duration_ms: number
}

interface RuleDef { id: string; name: string; severity: Severity; hint: string }

type Tab = 'quarantined' | 'all' | 'rules' | 'redaction'

interface RedactionEvent {
  id: string; report_id: string; kind: string; original_snippet: string | null;
  offset_start: number; offset_end: number; status: string; created_at: number
}

const SEVERITY_COLOR: Record<Severity, string> = {
  high: 'bg-red-500/15 border-red-500/40 text-red-300',
  med: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
  low: 'bg-slate-500/15 border-slate-500/40 text-slate-300'
}

export function QuarantinePage() {
  const [tab, setTab] = useState<Tab>('quarantined')
  const [run, setRun] = useState<RunRow | null>(null)
  const [quarantined, setQuarantined] = useState<FlaggedRow[]>([])
  const [flagged, setFlagged] = useState<FlaggedRow[]>([])
  const [rules, setRules] = useState<RuleDef[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [redactionEvents, setRedactionEvents] = useState<RedactionEvent[]>([])
  const [redactBusy, setRedactBusy] = useState(false)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setError(null)
    try {
      const [r, q, f, rs, re] = await Promise.all([
        window.heimdall.invoke('inj:latest'),
        window.heimdall.invoke('inj:quarantined', { limit: 200 }),
        window.heimdall.invoke('inj:flagged', { limit: 200 }),
        window.heimdall.invoke('inj:rules'),
        window.heimdall.invoke('redaction:pending', { limit: 200 })
      ]) as [RunRow | null, FlaggedRow[], FlaggedRow[], RuleDef[], RedactionEvent[]]
      setRun(r); setQuarantined(q); setFlagged(f); setRules(rs); setRedactionEvents(re)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function screen() {
    setBusy(true); setError(null)
    try {
      await window.heimdall.invoke('inj:screen_corpus')
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  async function release(reportId: string) {
    try {
      await window.heimdall.invoke('inj:release', { report_id: reportId })
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const rules_by_id = new Map(rules.map((r) => [r.id, r]))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <Bug className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Quarantine</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Prompt-injection screener output. Reports matching any high-severity
            rule are quarantined (hidden from the LLM agent context) until an
            analyst releases them. Medium and low matches are annotated but
            still flow through.
          </p>
        </div>
        <Button onClick={screen} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Re-screen corpus
        </Button>
      </div>

      <div className="px-6 py-3 border-b border-border">
        <Card>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Stat label="Reports scanned" value={run?.reports_scanned ?? 0} />
            <Stat label="Reports flagged" value={run?.reports_flagged ?? 0} />
            <Stat label="Currently quarantined" value={quarantined.length} hint="active" />
            <Stat label="Duration" value={run?.duration_ms != null ? `${run.duration_ms} ms` : '—'} />
            <Stat label="Last run" value={run ? formatRelativeTime(run.finished_at) : 'never'} />
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      <div className="px-6 pt-3 border-b border-border flex items-center gap-1">
        <TabBtn active={tab === 'quarantined'} onClick={() => setTab('quarantined')} icon={AlertOctagon} label={`Quarantined (${quarantined.length})`} />
        <TabBtn active={tab === 'all'} onClick={() => setTab('all')} icon={Bug} label={`All flagged (${flagged.length})`} />
        <TabBtn active={tab === 'rules'} onClick={() => setTab('rules')} icon={ShieldCheck} label={`Rules (${rules.length})`} />
        <TabBtn active={tab === 'redaction'} onClick={() => setTab('redaction')} icon={UserX} label={`PII Redaction (${redactionEvents.length})`} />
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'quarantined' && (
          quarantined.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              Nothing in quarantine. Re-screen the corpus to repopulate.
            </div>
          ) : quarantined.map((r) => (
            <div key={r.report_id} className="px-6 py-3 border-b border-border/40">
              <div className="flex items-start gap-3">
                <span className={cn(
                  'shrink-0 text-[10px] px-2 py-0.5 rounded font-mono font-bold border uppercase',
                  SEVERITY_COLOR[r.severity]
                )}>{r.severity}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{r.title}</div>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground flex-wrap">
                    <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{r.discipline}</Badge>
                    <span>{r.source_name}</span>
                    <span className="ml-auto">flagged {formatRelativeTime(r.flagged_at)}</span>
                  </div>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {r.matched_rules.map((rid) => (
                      <span key={rid} className="text-[9px] px-1 py-0.5 rounded border border-border bg-muted font-mono" title={rules_by_id.get(rid)?.hint}>
                        {rules_by_id.get(rid)?.name || rid}
                      </span>
                    ))}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => void release(r.report_id)}>
                  <Unlock className="h-3.5 w-3.5 mr-1.5" />Release
                </Button>
              </div>
            </div>
          ))
        )}

        {tab === 'all' && (
          flagged.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No flagged reports.</div>
          ) : flagged.map((r) => (
            <div key={r.report_id} className="px-6 py-2 border-b border-border/40">
              <div className="flex items-start gap-3">
                <span className={cn(
                  'shrink-0 text-[10px] px-2 py-0.5 rounded font-mono font-bold border uppercase',
                  SEVERITY_COLOR[r.severity]
                )}>{r.severity}</span>
                <Badge variant={r.action === 'quarantine' ? 'destructive' : 'secondary'} className="text-[9px] font-mono">
                  {r.action}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{r.title}</div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {r.source_name} · {r.matched_rules.map((rid) => rules_by_id.get(rid)?.name || rid).join(', ')}
                    {r.released_at && <span className="ml-2 text-emerald-400">released</span>}
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(r.flagged_at)}</span>
              </div>
            </div>
          ))
        )}

        {tab === 'rules' && (
          <div className="p-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Screener rules</CardTitle>
                <CardDescription className="text-xs">
                  Hard-coded in <code className="font-mono">InjectionScreener.ts</code>. Deployers
                  can extend by editing the source; future work will move them to a DB table.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left py-2 font-medium">Severity</th>
                      <th className="text-left py-2 font-medium">Rule</th>
                      <th className="text-left py-2 font-medium">Intent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id} className="border-b border-border/40">
                        <td className="py-1.5">
                          <span className={cn(
                            'text-[10px] px-2 py-0.5 rounded font-mono font-bold border uppercase',
                            SEVERITY_COLOR[r.severity]
                          )}>{r.severity}</span>
                        </td>
                        <td className="py-1.5 text-xs font-medium">{r.name}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">{r.hint}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === 'redaction' && (
          <div className="p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <UserX className="h-4 w-4" />PII redaction (US-persons / EEA-persons)
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  compromise.js NLP detects person names + regex matches SSNs, phone numbers,
                  emails, and US street addresses. Pending hits need analyst review — dismiss
                  false positives or auto-redact to replace with [REDACTED-KIND] tokens.
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={async () => {
                  setRedactBusy(true)
                  try { await window.heimdall.invoke('redaction:scan_corpus'); await loadAll() }
                  finally { setRedactBusy(false) }
                }} disabled={redactBusy}>
                  {redactBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Scan className="h-3.5 w-3.5 mr-1.5" />}
                  Scan corpus
                </Button>
              </div>
            </div>
            {redactionEvents.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No pending PII detections. Click <strong>Scan corpus</strong> to check all reports.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left py-2 font-medium">Kind</th>
                    <th className="text-left py-2 font-medium">Snippet</th>
                    <th className="text-left py-2 font-medium">Report</th>
                    <th className="text-left py-2 font-medium">Detected</th>
                    <th className="text-left py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {redactionEvents.map((e) => (
                    <tr key={e.id} className="border-b border-border/40">
                      <td className="py-1.5">
                        <Badge variant="destructive" className="text-[9px] py-0 px-1 font-mono uppercase">{e.kind.replace('_', ' ')}</Badge>
                      </td>
                      <td className="py-1.5 text-xs font-mono truncate max-w-[240px]">{e.original_snippet ?? '[redacted]'}</td>
                      <td className="py-1.5 text-[10px] font-mono text-muted-foreground truncate max-w-[160px]">{e.report_id}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">{formatRelativeTime(e.created_at)}</td>
                      <td className="py-1.5">
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={async () => {
                            await window.heimdall.invoke('redaction:apply', e.report_id)
                            await loadAll()
                          }}>Redact</Button>
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={async () => {
                            await window.heimdall.invoke('redaction:dismiss', e.id)
                            await loadAll()
                          }}>Dismiss</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold font-mono">{value}</div>
      {hint && <div className="text-[9px] text-muted-foreground italic mt-0.5">{hint}</div>}
    </div>
  )
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Bug; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-2 text-xs border-b-2 -mb-px flex items-center gap-1.5',
        active ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  )
}
