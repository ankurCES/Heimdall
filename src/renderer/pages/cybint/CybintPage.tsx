import { useEffect, useState } from 'react'
import { Shield, RefreshCw, Download, Loader2, Flame, Target, Bug } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

interface TechniqueFrequency {
  id: string; name: string; tactic: string; is_sub: number; parent_id: string | null; mention_count: number
}

interface KevRow {
  cve_id: string; vendor_project: string | null; product: string | null;
  vulnerability_name: string | null; date_added: string | null;
  short_description: string | null; due_date: string | null;
  known_ransomware_use: number; mention_count: number
}

interface RunRow {
  id: number; kind: string; started_at: number; finished_at: number;
  items_processed: number; items_written: number; duration_ms: number
}

interface TechniqueReport {
  report_id: string; title: string; source_name: string; discipline: string;
  severity: string; created_at: number; confidence: number; matched_via: string
}

type Tab = 'attack' | 'kev'

export function CybintPage() {
  const [tab, setTab] = useState<Tab>('attack')
  const [techniques, setTechniques] = useState<TechniqueFrequency[]>([])
  const [kevRows, setKevRows] = useState<KevRow[]>([])
  const [kevCount, setKevCount] = useState<{ total: number; ransomware: number; last_sync: number | null } | null>(null)
  const [attackRun, setAttackRun] = useState<RunRow | null>(null)
  const [kevRun, setKevRun] = useState<RunRow | null>(null)
  const [selected, setSelected] = useState<TechniqueFrequency | null>(null)
  const [reports, setReports] = useState<TechniqueReport[]>([])
  const [busyAttack, setBusyAttack] = useState(false)
  const [busyKev, setBusyKev] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setError(null)
    try {
      const [top, kevCorpus, kc, aRun, kRun] = await Promise.all([
        window.heimdall.invoke('cybint:top_techniques', { limit: 30 }),
        window.heimdall.invoke('cybint:kev_in_corpus', { limit: 100 }),
        window.heimdall.invoke('cybint:kev_count'),
        window.heimdall.invoke('cybint:latest_run', 'attack-tag'),
        window.heimdall.invoke('cybint:latest_run', 'kev-sync')
      ]) as [TechniqueFrequency[], KevRow[], { total: number; ransomware: number; last_sync: number | null }, RunRow | null, RunRow | null]
      setTechniques(top); setKevRows(kevCorpus); setKevCount(kc); setAttackRun(aRun); setKevRun(kRun)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function tagTechniques() {
    setBusyAttack(true); setError(null)
    try {
      await window.heimdall.invoke('cybint:tag_techniques')
      setSelected(null)
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusyAttack(false) }
  }

  async function syncKev() {
    setBusyKev(true); setError(null)
    try {
      await window.heimdall.invoke('cybint:sync_kev')
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusyKev(false) }
  }

  const selectTechnique = async (t: TechniqueFrequency) => {
    setSelected(t); setReports([])
    try {
      const rows = await window.heimdall.invoke('cybint:reports_for_technique', { id: t.id, limit: 50 }) as TechniqueReport[]
      setReports(rows)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">CYBINT</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            MITRE ATT&amp;CK technique tagging over report content (exact ID
            + name regex) and CISA Known Exploited Vulnerabilities cross-reference
            against CVEs extracted from the corpus. ATT&amp;CK re-tag runs
            against all reports; KEV sync pulls the public CISA feed.
          </p>
        </div>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      {/* Tabs */}
      <div className="px-6 pt-3 border-b border-border flex items-center gap-1">
        <TabBtn active={tab === 'attack'} onClick={() => setTab('attack')} icon={Target} label="MITRE ATT&CK" />
        <TabBtn active={tab === 'kev'} onClick={() => setTab('kev')} icon={Flame} label="KEV in corpus" />
      </div>

      {tab === 'attack' ? (
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Run summary + action */}
          <div className="px-6 py-3 border-b border-border flex items-center gap-4 flex-wrap">
            <Card className="flex-1 min-w-[300px]">
              <CardContent className="p-3 grid grid-cols-4 gap-4 text-sm">
                <Stat label="Reports scanned" value={attackRun?.items_processed ?? 0} />
                <Stat label="Mappings" value={attackRun?.items_written ?? 0} />
                <Stat label="Duration" value={attackRun?.duration_ms != null ? `${attackRun.duration_ms} ms` : '—'} />
                <Stat label="Last run" value={attackRun ? formatRelativeTime(attackRun.finished_at) : 'never'} />
              </CardContent>
            </Card>
            <Button onClick={tagTechniques} disabled={busyAttack}>
              {busyAttack ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Re-tag all
            </Button>
          </div>

          <div className="flex-1 overflow-hidden flex">
            {/* Left — techniques list */}
            <div className="w-1/2 border-r border-border overflow-auto">
              {techniques.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  No technique mappings yet. Click <strong>Re-tag all</strong> above.
                </div>
              ) : techniques.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void selectTechnique(t)}
                  className={cn(
                    'w-full text-left px-4 py-2 border-b border-border/40 text-sm hover:bg-accent/30',
                    selected?.id === t.id && 'bg-accent/50'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Badge variant="outline" className="font-mono text-[10px] shrink-0">{t.id}</Badge>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{t.name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mt-0.5">{t.tactic}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-mono font-semibold">{t.mention_count}</div>
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">reports</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* Right — reports mentioning selected technique */}
            <div className="flex-1 overflow-auto">
              {selected ? (
                <div className="p-6">
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <Badge variant="outline" className="font-mono">{selected.id}</Badge>
                    <h2 className="text-lg font-semibold">{selected.name}</h2>
                    <Badge variant="outline" className="ml-auto font-mono text-[10px]">{selected.tactic}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    {selected.mention_count} report{selected.mention_count === 1 ? '' : 's'} tagged with this technique.
                  </p>
                  {reports.map((r) => (
                    <div key={r.report_id} className="py-2 border-b border-border/40">
                      <div className="flex items-start gap-2">
                        <Badge variant={r.matched_via === 'id' ? 'default' : 'secondary'} className="text-[9px] py-0 px-1 font-mono shrink-0">
                          {r.matched_via} · {(r.confidence * 100).toFixed(0)}%
                        </Badge>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{r.title}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {r.source_name} · {r.discipline} · {formatRelativeTime(r.created_at)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Target className="h-10 w-10 mb-2 opacity-30" />
                  <p className="text-sm">Select a technique to see matching reports</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="px-6 py-3 border-b border-border flex items-center gap-4 flex-wrap">
            <Card className="flex-1 min-w-[300px]">
              <CardContent className="p-3 grid grid-cols-4 gap-4 text-sm">
                <Stat label="KEV entries" value={kevCount?.total ?? 0} />
                <Stat label="Known-ransomware" value={kevCount?.ransomware ?? 0} hint="flagged by CISA" />
                <Stat label="CVEs in corpus" value={kevRows.length} hint="≥1 mention" />
                <Stat label="Last sync" value={kevCount?.last_sync ? formatRelativeTime(kevCount.last_sync) : 'never'} />
              </CardContent>
            </Card>
            <Button onClick={syncKev} disabled={busyKev}>
              {busyKev ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Sync CISA KEV
            </Button>
          </div>

          <div className="flex-1 overflow-auto">
            {kevRows.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No KEV matches in the corpus yet. Sync the catalog first, then ensure
                CVEs are being extracted into <code className="font-mono">intel_entities</code>.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background border-b border-border">
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">CVE</th>
                    <th className="text-left px-4 py-2 font-medium">Vendor / Product</th>
                    <th className="text-left px-4 py-2 font-medium">Vulnerability</th>
                    <th className="text-left px-4 py-2 font-medium">Ransomware?</th>
                    <th className="text-right px-4 py-2 font-medium">Mentions</th>
                  </tr>
                </thead>
                <tbody>
                  {kevRows.map((k) => (
                    <tr key={k.cve_id} className="border-b border-border/40 hover:bg-accent/20">
                      <td className="px-4 py-1.5 font-mono text-xs">{k.cve_id}</td>
                      <td className="px-4 py-1.5 text-xs">
                        {k.vendor_project} · <span className="text-muted-foreground">{k.product}</span>
                      </td>
                      <td className="px-4 py-1.5 text-xs truncate max-w-md">{k.vulnerability_name}</td>
                      <td className="px-4 py-1.5">
                        {k.known_ransomware_use === 1 && (
                          <Badge variant="destructive" className="text-[9px] font-mono">
                            <Bug className="h-3 w-3 mr-1" />RANSOMWARE
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono text-xs">{k.mention_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
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

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Target; label: string }) {
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
