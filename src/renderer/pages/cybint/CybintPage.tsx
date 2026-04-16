import { useEffect, useState } from 'react'
import { Shield, RefreshCw, Download, Loader2, Flame, Target, Bug, Crosshair, Search } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
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

type Tab = 'attack' | 'kev' | 'pivot'

interface AptResult {
  group: string; overlap: number; total_group_ttps: number; jaccard: number; evidence: string[]
}
interface PivotResult {
  seed: { entity_type: string; entity_value: string }
  reports: Array<{ report_id: string; title: string; discipline: string; source_name: string; created_at: number }>
  related_iocs: Array<{ entity_type: string; entity_value: string; mention_count: number }>
}

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
        <TabBtn active={tab === 'pivot'} onClick={() => setTab('pivot')} icon={Crosshair} label="APT + pivot" />
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

      {tab === 'pivot' && <PivotTab techniques={techniques} />}
    </div>
  )
}

function PivotTab({ techniques }: { techniques: TechniqueFrequency[] }) {
  const [aptResults, setAptResults] = useState<AptResult[]>([])
  const [aptBusy, setAptBusy] = useState(false)
  const [aptSelected, setAptSelected] = useState<Set<string>>(new Set())
  const [iocType, setIocType] = useState<string>('ip')
  const [iocValue, setIocValue] = useState('')
  const [pivot, setPivot] = useState<PivotResult | null>(null)
  const [pivotBusy, setPivotBusy] = useState(false)

  const runApt = async (ids: string[]) => {
    if (ids.length === 0) { setAptResults([]); return }
    setAptBusy(true)
    try {
      const rows = await window.heimdall.invoke('cybint:apt_attribute', { technique_ids: ids, limit: 10 }) as AptResult[]
      setAptResults(rows)
    } finally { setAptBusy(false) }
  }

  const toggleTechnique = (id: string) => {
    const next = new Set(aptSelected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setAptSelected(next)
    void runApt(Array.from(next))
  }

  const pickAllCorpusTop = () => {
    const top10 = techniques.slice(0, 15).map((t) => t.id)
    setAptSelected(new Set(top10))
    void runApt(top10)
  }

  const runPivot = async () => {
    if (!iocValue.trim()) return
    setPivotBusy(true)
    try {
      const r = await window.heimdall.invoke('cybint:ioc_pivot', { entity_type: iocType, entity_value: iocValue.trim(), limit: 50 }) as PivotResult
      setPivot(r)
    } finally { setPivotBusy(false) }
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      {/* APT attribution */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">APT attribution</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Pick techniques from the corpus and score overlap against a curated
            APT-to-TTP map (12 groups: APT28/29/40/41, Lazarus, Sandworm, Turla,
            MuddyWater, FIN7, Conti/Ryuk ops, Equation, DarkSeoul). Ranked by
            Jaccard similarity — high overlap + few-TTP group is a strong
            attribution signal. Not decisive.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={pickAllCorpusTop} disabled={techniques.length === 0}>
              Use corpus top-15 techniques
            </Button>
            {aptSelected.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => { setAptSelected(new Set()); setAptResults([]) }}>
                Clear
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1 max-h-24 overflow-auto">
            {techniques.slice(0, 40).map((t) => (
              <button key={t.id}
                onClick={() => toggleTechnique(t.id)}
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded border font-mono',
                  aptSelected.has(t.id)
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent/30'
                )}
                title={t.name}
              >{t.id}</button>
            ))}
          </div>
          {aptBusy && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Scoring…</p>}
          {aptResults.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left py-1 font-medium">Group</th>
                  <th className="text-right py-1 font-medium">Overlap</th>
                  <th className="text-right py-1 font-medium">Group TTPs</th>
                  <th className="text-right py-1 font-medium">Jaccard</th>
                  <th className="text-left py-1 font-medium">Matched</th>
                </tr>
              </thead>
              <tbody>
                {aptResults.map((r) => (
                  <tr key={r.group} className="border-b border-border/40">
                    <td className="py-1.5 text-xs font-medium">{r.group}</td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.overlap}</td>
                    <td className="py-1.5 text-right text-xs font-mono text-muted-foreground">{r.total_group_ttps}</td>
                    <td className="py-1.5 text-right text-xs font-mono text-primary">{r.jaccard.toFixed(3)}</td>
                    <td className="py-1.5 text-[10px] font-mono text-muted-foreground">{r.evidence.slice(0, 6).join(', ')}{r.evidence.length > 6 ? '…' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* IOC pivot */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">IOC pivot</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Seed with one IOC (IP / hash / URL / email / CVE), Heimdall
            finds every report containing it plus every other IOC those
            reports mention. Quarantined reports are excluded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 items-end">
            <div className="w-32">
              <Select value={iocType} onValueChange={setIocType}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['ip', 'hash', 'url', 'email', 'cve', 'domain', 'malware', 'threat_actor'].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Input
                value={iocValue}
                onChange={(e) => setIocValue(e.target.value)}
                placeholder="e.g. 10.0.0.1 or CVE-2024-1234"
                onKeyDown={(e) => e.key === 'Enter' && void runPivot()}
              />
            </div>
            <Button onClick={runPivot} disabled={pivotBusy || !iocValue.trim()}>
              {pivotBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
              Pivot
            </Button>
          </div>
          {pivot && (
            <>
              <div className="text-xs text-muted-foreground">
                Seed <span className="font-mono">{pivot.seed.entity_type}:{pivot.seed.entity_value}</span> —
                found in {pivot.reports.length} report{pivot.reports.length === 1 ? '' : 's'};
                {' '}{pivot.related_iocs.length} related IOC{pivot.related_iocs.length === 1 ? '' : 's'}.
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-xs font-semibold mb-1">Reports</div>
                  <div className="space-y-0.5 max-h-64 overflow-auto">
                    {pivot.reports.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No reports.</p>
                    ) : pivot.reports.map((r) => (
                      <div key={r.report_id} className="text-[11px] truncate py-0.5">
                        <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono mr-1.5">{r.discipline}</Badge>
                        {r.title}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1">Related IOCs</div>
                  <table className="w-full text-xs">
                    <tbody>
                      {pivot.related_iocs.slice(0, 30).map((r, i) => (
                        <tr key={`${r.entity_type}-${r.entity_value}-${i}`} className="border-b border-border/30">
                          <td className="py-0.5 font-mono text-[10px] text-muted-foreground w-16">{r.entity_type}</td>
                          <td className="py-0.5 font-mono truncate max-w-[240px]">{r.entity_value}</td>
                          <td className="py-0.5 text-right font-mono">{r.mention_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
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
