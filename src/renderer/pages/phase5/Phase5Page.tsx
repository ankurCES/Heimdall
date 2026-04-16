import { useEffect, useState } from 'react'
import {
  Settings2, Flame, Radio, Share2, Moon, Play, Loader2, RefreshCw, Check, X, Download, Upload,
  Shield, FileText, AlertOctagon, Search, Crosshair, Layers, Brain, MapPin, Copy, Scroll,
  Swords, ChevronRight
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

type Tab = 'disinfo' | 'canary' | 'insider' | 'forecast' | 'conflict' | 'detection' | 'misp' | 'taxii' | 'document' | 'briefing' | 'wargame'

export function Phase5Page() {
  const [tab, setTab] = useState<Tab>('disinfo')
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-start gap-3 p-6 pb-3 border-b border-border">
        <Settings2 className="h-5 w-5 text-primary mt-1" />
        <div>
          <h1 className="text-xl font-semibold">Advanced operations</h1>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Deferred-item sweep from the tier-1 roadmap: disinformation detection, canary tokens, insider-threat scanning,
            scenario forecasting, conflict probability, Sigma/YARA generation, MISP sync, TAXII server, and document OCR.
            Each operates against existing corpus data — no new collectors.
          </p>
        </div>
      </div>
      <div className="px-6 pt-3 border-b border-border flex items-center gap-1 flex-wrap">
        <TB active={tab === 'disinfo'} set={() => setTab('disinfo')} icon={Layers} label="Disinfo" />
        <TB active={tab === 'canary'} set={() => setTab('canary')} icon={Flame} label="Canary" />
        <TB active={tab === 'insider'} set={() => setTab('insider')} icon={AlertOctagon} label="Insider" />
        <TB active={tab === 'forecast'} set={() => setTab('forecast')} icon={Brain} label="Forecast" />
        <TB active={tab === 'conflict'} set={() => setTab('conflict')} icon={MapPin} label="Conflict" />
        <TB active={tab === 'detection'} set={() => setTab('detection')} icon={Shield} label="Sigma / YARA" />
        <TB active={tab === 'misp'} set={() => setTab('misp')} icon={Radio} label="MISP" />
        <TB active={tab === 'taxii'} set={() => setTab('taxii')} icon={Share2} label="TAXII" />
        <TB active={tab === 'document'} set={() => setTab('document')} icon={FileText} label="Documents" />
        <TB active={tab === 'briefing'} set={() => setTab('briefing')} icon={Moon} label="Briefing" />
        <TB active={tab === 'wargame'} set={() => setTab('wargame')} icon={Swords} label="Wargaming" />
      </div>
      <div className="flex-1 overflow-auto">
        {tab === 'disinfo' && <DisinfoTab />}
        {tab === 'canary' && <CanaryTab />}
        {tab === 'insider' && <InsiderTab />}
        {tab === 'forecast' && <ForecastTab />}
        {tab === 'conflict' && <ConflictTab />}
        {tab === 'detection' && <DetectionTab />}
        {tab === 'misp' && <MispTab />}
        {tab === 'taxii' && <TaxiiTab />}
        {tab === 'document' && <DocumentTab />}
        {tab === 'briefing' && <BriefingTab />}
        {tab === 'wargame' && <WargameTab />}
      </div>
    </div>
  )
}

function TB({ active, set, icon: Icon, label }: { active: boolean; set: () => void; icon: typeof Flame; label: string }) {
  return (
    <button onClick={set} className={cn('px-3 py-2 text-xs border-b-2 -mb-px flex items-center gap-1.5',
      active ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  )
}

// ───────────── Disinfo ─────────────
function DisinfoTab() {
  const [clusters, setClusters] = useState<Array<{ id: string; signature_kind: string; signature_value: string; member_count: number; first_seen_at: number; last_seen_at: number; sample_titles: string[]; sample_sources: string[] }>>([])
  const [run, setRun] = useState<{ reports_scanned: number; clusters_found: number; finished_at: number; duration_ms: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => {
    const [c, r] = await Promise.all([
      window.heimdall.invoke('disinfo:clusters', { limit: 100 }),
      window.heimdall.invoke('disinfo:latest')
    ]) as [typeof clusters, typeof run]
    setClusters(c); setRun(r)
  }
  useEffect(() => { void load() }, [])
  const sweep = async () => { setBusy(true); try { await window.heimdall.invoke('disinfo:sweep', { window_hours: 48 }); await load() } finally { setBusy(false) } }
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Daily disinfo sweep</h2>
          <p className="text-xs text-muted-foreground mt-1">Clusters reports by normalised title (template attacks) + repeated source URL (amplification). Cron @ 03:30 local.</p>
        </div>
        <Button onClick={sweep} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}Sweep now</Button>
      </div>
      {run && (
        <div className="text-xs text-muted-foreground">
          Last run: {formatRelativeTime(run.finished_at)} — {run.reports_scanned} reports scanned, {run.clusters_found} clusters found ({run.duration_ms} ms)
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {clusters.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">No clusters. Run a sweep.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-muted-foreground border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Kind</th>
                <th className="text-left px-3 py-2 font-medium">Signature</th>
                <th className="text-right px-3 py-2 font-medium">Members</th>
                <th className="text-left px-3 py-2 font-medium">Sources</th>
                <th className="text-left px-3 py-2 font-medium">First seen</th>
              </tr></thead>
              <tbody>
                {clusters.map((c) => (
                  <tr key={c.id} className="border-b border-border/30">
                    <td className="px-3 py-1.5"><Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{c.signature_kind}</Badge></td>
                    <td className="px-3 py-1.5 text-xs truncate max-w-[320px]">{c.signature_value}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">{c.member_count}</td>
                    <td className="px-3 py-1.5 text-[10px] text-muted-foreground truncate max-w-[200px]">{c.sample_sources.slice(0, 3).join(' · ')}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatRelativeTime(c.first_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ───────────── Canary ─────────────
function CanaryTab() {
  const [list, setList] = useState<Array<{ id: string; token: string; label: string; observed_at: number | null; observed_source: string | null; created_at: number }>>([])
  const [label, setLabel] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [seeding, setSeeding] = useState<string | null>(null)
  const [seedResult, setSeedResult] = useState<string | null>(null)
  const load = async () => setList(await window.heimdall.invoke('canary:list') as typeof list)
  useEffect(() => { void load() }, [])
  const create = async () => {
    if (!label.trim()) return
    await window.heimdall.invoke('canary:create', { label })
    setLabel(''); await load()
  }
  const scan = async () => { await window.heimdall.invoke('canary:scan_corpus'); await load() }
  const copyToken = (token: string) => {
    void navigator.clipboard.writeText(token)
    setCopied(token); setTimeout(() => setCopied(null), 2000)
  }
  const seedDpb = async (token: string, tokenLabel: string) => {
    setSeeding(token); setSeedResult(null)
    try {
      const dpb = await window.heimdall.invoke('dpb:generate', { periodHours: 24 }) as { id: string; body_md: string }
      // Append canary watermark. The token is placed in a comment-style
      // footer that looks innocuous in the rendered brief but is unique
      // enough for corpus-scan to detect. It's also appended in plaintext
      // so a plain-text copy/paste still carries it.
      const seeded = `${dpb.body_md}\n\n---\n<!-- canary: ${token} | ${tokenLabel} -->\n_Document ref: ${token}_\n`
      // Write the seeded brief as a new export. We re-use the export:write
      // channel which saves to a file via the save-dialog.
      await window.heimdall.invoke('export:write', {
        source_type: 'dpb', source_id: dpb.id,
        format: 'markdown',
        content_override: seeded
      })
      setSeedResult(`DPB ${dpb.id} generated and exported with canary ${token}`)
    } catch (err) {
      setSeedResult(`Error: ${String(err).replace(/^Error:\s*/, '')}`)
    } finally { setSeeding(null) }
  }
  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">Canary tokens</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Create a token → <strong>Copy</strong> to paste into any external document, OR click
          <strong> Seed DPB</strong> to generate a Daily Brief with the token embedded as a
          watermark. Share the seeded brief with a limited audience. If the token later appears
          in the intel corpus, Heimdall flags the leak source.
        </p>
      </div>
      <div className="flex gap-2">
        <Input placeholder="Label (e.g. 'Iran desk brief — shared with Amy + Bob')" value={label} onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <Button onClick={create} disabled={!label.trim()}>Create</Button>
        <Button variant="outline" onClick={scan}>Scan corpus</Button>
      </div>
      {seedResult && (
        <div className={cn('text-xs p-2 rounded border', seedResult.startsWith('Error') ? 'bg-red-500/10 border-red-500/30 text-red-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300')}>
          {seedResult}
        </div>
      )}
      <Card><CardContent className="p-0">
        {list.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No tokens. Create one, then copy it into a document or seed a DPB.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left px-3 py-2 font-medium">Label</th>
              <th className="text-left px-3 py-2 font-medium">Token</th>
              <th className="text-left px-3 py-2 font-medium">Observed?</th>
              <th className="text-left px-3 py-2 font-medium">Actions</th>
            </tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-border/30">
                  <td className="px-3 py-1.5 text-xs">{c.label}</td>
                  <td className="px-3 py-1.5 text-[10px] font-mono">{c.token}</td>
                  <td className="px-3 py-1.5 text-xs">{c.observed_at ? <span className="text-red-300">{formatRelativeTime(c.observed_at)} via {c.observed_source}</span> : <span className="text-muted-foreground">not yet</span>}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => copyToken(c.token)} title="Copy token to clipboard">
                        {copied === c.token ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => void seedDpb(c.token, c.label)} disabled={seeding === c.token} title="Generate a DPB with this canary embedded">
                        {seeding === c.token ? <Loader2 className="h-3 w-3 animate-spin" /> : <Scroll className="h-3 w-3" />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  )
}

// ───────────── Insider ─────────────
function InsiderTab() {
  const [events, setEvents] = useState<Array<{ id: number; analyst_id: string; kind: string; severity: string; detail: string | null; created_at: number }>>([])
  const load = async () => setEvents(await window.heimdall.invoke('insider:recent', { limit: 100 }) as typeof events)
  useEffect(() => { void load() }, [])
  const scan = async () => { await window.heimdall.invoke('insider:scan'); await load() }
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div><h2 className="text-base font-semibold">Insider threat scanner</h2>
          <p className="text-xs text-muted-foreground mt-1">Mass-export bursts + off-hours access clusters (read from the audit chain).</p></div>
        <Button onClick={scan}>Scan now</Button>
      </div>
      <Card><CardContent className="p-0">
        {events.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No events.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left px-3 py-2 font-medium">Severity</th>
              <th className="text-left px-3 py-2 font-medium">Kind</th>
              <th className="text-left px-3 py-2 font-medium">Detail</th>
              <th className="text-left px-3 py-2 font-medium">When</th>
            </tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-border/30">
                  <td className="px-3 py-1.5"><Badge variant={e.severity === 'high' ? 'destructive' : 'default'} className="text-[9px] py-0 px-1 font-mono uppercase">{e.severity}</Badge></td>
                  <td className="px-3 py-1.5 text-xs font-mono">{e.kind}</td>
                  <td className="px-3 py-1.5 text-xs">{e.detail}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatRelativeTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  )
}

// ───────────── Forecast ─────────────
function ForecastTab() {
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [scenarios, setScenarios] = useState<Array<{ id: string; topic: string; scenario_class: string; body_md: string; confidence_lo: number | null; confidence_hi: number | null; created_at: number }>>([])
  const load = async () => setScenarios(await window.heimdall.invoke('forecast:recent_scenarios', { limit: 30 }) as typeof scenarios)
  useEffect(() => { void load() }, [])
  const gen = async () => {
    if (!topic.trim()) return
    setBusy(true)
    try { await window.heimdall.invoke('forecast:scenarios', { topic: topic.trim() }); await load() }
    finally { setBusy(false) }
  }
  return (
    <div className="p-6 space-y-4">
      <div><h2 className="text-base font-semibold">Scenario forecasting</h2>
        <p className="text-xs text-muted-foreground mt-1">Best-case / most-likely / worst-case narratives with ICD 203 probability bands.</p></div>
      <div className="flex gap-2">
        <Input placeholder='Topic (e.g. "Iran nuclear escalation 2026")' value={topic} onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void gen()} />
        <Button onClick={gen} disabled={busy || !topic.trim()}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Brain className="h-4 w-4 mr-2" />}Forecast</Button>
      </div>
      <div className="space-y-2">
        {scenarios.map((s) => (
          <Card key={s.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={cn('text-[10px] font-mono uppercase', s.scenario_class === 'worst_case' ? 'border-red-500/40 text-red-300' : s.scenario_class === 'best_case' ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300')}>{s.scenario_class.replace('_', '-')}</Badge>
                  <CardTitle className="text-sm">{s.topic}</CardTitle>
                </div>
                <div className="text-xs text-muted-foreground">{s.confidence_lo != null && s.confidence_hi != null ? `${s.confidence_lo}%–${s.confidence_hi}%` : '—'} · {formatRelativeTime(s.created_at)}</div>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="text-[11px] whitespace-pre-wrap text-foreground/90 font-sans">{s.body_md}</pre>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ───────────── Conflict ─────────────
function ConflictTab() {
  const [top, setTop] = useState<Array<{ region: string; latest_probability: number; last_bucket: number; max_probability: number }>>([])
  const load = async () => setTop(await window.heimdall.invoke('conflict:top_regions', { limit: 25 }) as typeof top)
  useEffect(() => { void load() }, [])
  const compute = async () => { await window.heimdall.invoke('conflict:compute', { window_days: 14 }); await load() }
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div><h2 className="text-base font-semibold">Conflict probability</h2>
          <p className="text-xs text-muted-foreground mt-1">Daily per-region score combining event volume, severity-weighted sentiment, and I&amp;W red-indicator count. Cron @ 04:00.</p></div>
        <Button onClick={compute}>Recompute</Button>
      </div>
      <Card><CardContent className="p-0">
        {top.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No scores yet. Needs intel_reports.country populated.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left px-3 py-2 font-medium">Region</th>
              <th className="text-right px-3 py-2 font-medium">Latest</th>
              <th className="text-right px-3 py-2 font-medium">14-day max</th>
              <th className="text-left px-3 py-2 font-medium">Updated</th>
            </tr></thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.region} className="border-b border-border/30">
                  <td className="px-3 py-1.5 text-xs font-mono">{r.region}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-sm text-primary">{r.latest_probability}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">{r.max_probability}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatRelativeTime(r.last_bucket)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  )
}

// ───────────── Detection rules ─────────────
function DetectionTab() {
  const [rules, setRules] = useState<Array<{ id: string; rule_type: string; name: string; body: string; source_report_id: string | null; created_at: number }>>([])
  const [reportId, setReportId] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => setRules(await window.heimdall.invoke('detection:list', { limit: 50 }) as typeof rules)
  useEffect(() => { void load() }, [])
  const gen = async (kind: 'sigma' | 'yara') => {
    if (!reportId.trim()) return
    setBusy(true)
    try { await window.heimdall.invoke(`detection:generate_${kind}`, reportId.trim()); setReportId(''); await load() }
    finally { setBusy(false) }
  }
  return (
    <div className="p-6 space-y-4">
      <div><h2 className="text-base font-semibold">Sigma / YARA rule generation</h2>
        <p className="text-xs text-muted-foreground mt-1">LLM-drafted detection rules anchored in a specific intel_report's content + extracted IOCs.</p></div>
      <div className="flex gap-2">
        <Input placeholder="intel_reports.id (UUID)" value={reportId} onChange={(e) => setReportId(e.target.value)} />
        <Button onClick={() => gen('sigma')} disabled={busy || !reportId.trim()}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Generate Sigma</Button>
        <Button variant="outline" onClick={() => gen('yara')} disabled={busy || !reportId.trim()}>Generate YARA</Button>
      </div>
      <div className="space-y-2">
        {rules.map((r) => (
          <Card key={r.id}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] font-mono uppercase">{r.rule_type}</Badge>
                <CardTitle className="text-sm">{r.name}</CardTitle>
                <span className="ml-auto text-[10px] text-muted-foreground">{formatRelativeTime(r.created_at)}</span>
              </div>
            </CardHeader>
            <CardContent><pre className="text-[11px] font-mono whitespace-pre-wrap bg-muted/50 p-2 rounded max-h-80 overflow-auto">{r.body}</pre></CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ───────────── MISP ─────────────
function MispTab() {
  const [configured, setConfigured] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; version?: string; error?: string } | null>(null)
  const [runs, setRuns] = useState<Array<{ id: number; direction: string; started_at: number; finished_at: number; events_in: number | null; events_out: number | null; summary: string | null; duration_ms: number }>>([])
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setConfigured(await window.heimdall.invoke('misp:configured') as boolean)
    setRuns(await window.heimdall.invoke('misp:runs', { limit: 20 }) as typeof runs)
  }
  useEffect(() => { void load() }, [])
  const doTest = async () => setTest(await window.heimdall.invoke('misp:test') as typeof test)
  const doPush = async () => { setBusy(true); try { await window.heimdall.invoke('misp:push'); await load() } finally { setBusy(false) } }
  const doPull = async () => { setBusy(true); try { await window.heimdall.invoke('misp:pull'); await load() } finally { setBusy(false) } }
  return (
    <div className="p-6 space-y-4">
      <div><h2 className="text-base font-semibold">MISP bidirectional sync</h2>
        <p className="text-xs text-muted-foreground mt-1">Configure URL + api_key under Settings → (misp json blob). Push exports intel_reports as MISP events; pull imports back with misp:&lt;uuid&gt; dedup.</p></div>
      {!configured && <div className="text-xs p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">MISP not configured. Set <code className="font-mono">misp</code> key in settings.</div>}
      <div className="flex gap-2">
        <Button variant="outline" onClick={doTest} disabled={!configured}>Test connection</Button>
        <Button onClick={doPush} disabled={busy || !configured}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}Push</Button>
        <Button onClick={doPull} disabled={busy || !configured}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}Pull</Button>
      </div>
      {test && <div className={cn('text-xs p-2 rounded border', test.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300')}>
        {test.ok ? <><Check className="inline h-3 w-3 mr-1" />Connected (MISP v{test.version})</> : <>Error: {test.error}</>}
      </div>}
      <Card><CardContent className="p-0">
        {runs.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No syncs yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left px-3 py-2 font-medium">#</th>
              <th className="text-left px-3 py-2 font-medium">Direction</th>
              <th className="text-left px-3 py-2 font-medium">Summary</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border/30">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.id}</td>
                  <td className="px-3 py-1.5"><Badge variant="outline" className={cn('text-[9px] py-0 px-1 font-mono uppercase', r.direction === 'pull' ? 'border-blue-500/40 text-blue-300' : 'border-emerald-500/40 text-emerald-300')}>{r.direction}</Badge></td>
                  <td className="px-3 py-1.5 text-xs">{r.summary ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-xs">{r.duration_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  )
}

// ───────────── TAXII ─────────────
function TaxiiTab() {
  const [status, setStatus] = useState<{ running: boolean }>({ running: false })
  const [token, setToken] = useState<string | null>(null)
  const [runs, setRuns] = useState<Array<{ id: number; event: string; bind: string | null; created_at: number }>>([])
  const load = async () => {
    setStatus(await window.heimdall.invoke('taxii:status') as { running: boolean })
    setRuns(await window.heimdall.invoke('taxii:runs', { limit: 20 }) as typeof runs)
  }
  useEffect(() => { void load() }, [])
  return (
    <div className="p-6 space-y-4">
      <div><h2 className="text-base font-semibold">TAXII 2.1 server</h2>
        <p className="text-xs text-muted-foreground mt-1">Local-host HTTP endpoint serving STIX 2.1 bundles via standard TAXII endpoints. Front with reverse-proxy TLS for external exposure.</p></div>
      <div className="flex items-center gap-3 p-3 rounded border border-border bg-card/30">
        <div className={cn('h-2 w-2 rounded-full', status.running ? 'bg-emerald-500' : 'bg-muted-foreground')} />
        <div className="flex-1 text-sm">{status.running ? 'Running' : 'Stopped'}</div>
        {status.running
          ? <Button size="sm" variant="outline" onClick={async () => { await window.heimdall.invoke('taxii:stop'); await load() }}>Stop</Button>
          : <Button size="sm" onClick={async () => { try { await window.heimdall.invoke('taxii:start'); await load() } catch (err) { alert(String(err)) } }}>Start</Button>}
        <Button size="sm" variant="outline" onClick={async () => {
          const r = await window.heimdall.invoke('taxii:rotate_token') as { token: string }
          setToken(r.token)
        }}>Rotate token</Button>
      </div>
      {token && <div className="text-xs p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200">
        New API token (displayed once): <code className="font-mono text-[10px]">{token}</code>
      </div>}
      <Card><CardContent className="p-0">
        {runs.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No lifecycle events.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left px-3 py-2 font-medium">Event</th>
              <th className="text-left px-3 py-2 font-medium">Bind</th>
              <th className="text-left px-3 py-2 font-medium">When</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border/30">
                  <td className="px-3 py-1.5 text-xs font-mono">{r.event}</td>
                  <td className="px-3 py-1.5 text-xs font-mono text-muted-foreground">{r.bind ?? '—'}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{formatRelativeTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent></Card>
    </div>
  )
}

// ───────────── Document OCR ─────────────
function DocumentTab() {
  const [docs, setDocs] = useState<Array<{ id: string; file_name: string | null; file_size: number | null; mime_type: string | null; page_count: number | null; ocr_confidence: number | null; ocr_engine: string | null; redactions_found: number; report_id: string | null; ingested_at: number; ocr_text: string | null }>>([])
  const [selected, setSelected] = useState<typeof docs[number] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async () => setDocs(await window.heimdall.invoke('document:list', { limit: 100 }) as typeof docs)
  useEffect(() => { void load() }, [])
  const pick = async () => {
    setBusy(true)
    try { await window.heimdall.invoke('document:ingest_pick'); await load() }
    finally { setBusy(false) }
  }
  return (
    <div className="flex h-full">
      <div className="w-[380px] border-r border-border overflow-auto">
        <div className="p-3 border-b border-border flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Documents</div>
          <Button size="sm" onClick={pick} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}Ingest</Button>
        </div>
        {docs.map((d) => (
          <button key={d.id} onClick={() => setSelected(d)}
            className={cn('w-full text-left px-3 py-2 border-b border-border/40 hover:bg-accent/30', selected?.id === d.id && 'bg-accent/50')}>
            <div className="text-sm font-medium truncate">{d.file_name}</div>
            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground flex-wrap">
              {d.page_count && <span className="font-mono">{d.page_count}pp</span>}
              <span className="font-mono">{d.mime_type?.replace('application/', '').replace('image/', '')}</span>
              {d.ocr_confidence != null && <span className="font-mono">conf {d.ocr_confidence.toFixed(0)}</span>}
              {d.redactions_found > 0 && <Badge variant="destructive" className="text-[9px] py-0 px-1">{d.redactions_found} redactions</Badge>}
              {d.report_id && <Badge variant="outline" className="text-[9px] py-0 px-1">→ intel</Badge>}
            </div>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {selected ? (
          <>
            <h3 className="text-sm font-semibold mb-2">{selected.file_name}</h3>
            <div className="text-[10px] text-muted-foreground mb-3 font-mono">{selected.ocr_engine} · {selected.page_count ?? 1}pp · {selected.ocr_confidence?.toFixed(0)}% confidence</div>
            <pre className="text-xs whitespace-pre-wrap bg-muted/30 p-3 rounded max-h-[70vh] overflow-auto">{selected.ocr_text?.slice(0, 200_000)}</pre>
          </>
        ) : <p className="text-xs text-muted-foreground">Select a document.</p>}
      </div>
    </div>
  )
}

// ───────────── Briefing ─────────────
function BriefingTab() {
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; body_md: string; is_default: number }>>([])
  const [snapshots, setSnapshots] = useState<Array<{ id: string; taken_at: number; label: string | null; total_reports: number }>>([])
  const [diff, setDiff] = useState<{ from: { id: string; taken_at: number; total: number }; to: { id: string; taken_at: number; total: number }; delta_reports: number; discipline_delta: Record<string, number>; severity_delta: Record<string, number>; new_top_entities: Array<{ entity_type: string; canonical_value: string; mention_count: number }> } | null>(null)
  const [selectedFrom, setSelectedFrom] = useState<string>('')

  const load = async () => {
    setTemplates(await window.heimdall.invoke('briefing:templates_list') as typeof templates)
    setSnapshots(await window.heimdall.invoke('briefing:snapshots_list') as typeof snapshots)
  }
  useEffect(() => { void load() }, [])

  const snap = async () => {
    await window.heimdall.invoke('briefing:snapshot', { label: `snap-${new Date().toISOString().slice(0, 16)}` })
    await load()
  }
  const doDiff = async () => {
    if (!selectedFrom) return
    const r = await window.heimdall.invoke('briefing:diff', { from_id: selectedFrom }) as typeof diff
    setDiff(r)
  }
  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">Briefing polish</h2>
        <p className="text-xs text-muted-foreground mt-1">DPB templates, tear-line generator (via LLM), and what-changed snapshot diffs.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Templates ({templates.length})</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs py-1 border-b border-border/40">
              {t.is_default === 1 && <Badge variant="outline" className="text-[9px] py-0 px-1">default</Badge>}
              <span className="flex-1">{t.name}</span>
              <span className="text-[10px] text-muted-foreground font-mono">{t.body_md.length} chars</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Snapshots + what-changed</CardTitle>
            <Button size="sm" onClick={snap}>Take snapshot</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshots.length > 0 && (
            <div className="flex gap-2 items-center">
              <select className="bg-background border border-border rounded px-2 py-1 text-xs" value={selectedFrom} onChange={(e) => setSelectedFrom(e.target.value)}>
                <option value="">Pick a "from" snapshot…</option>
                {snapshots.map((s) => <option key={s.id} value={s.id}>{formatRelativeTime(s.taken_at)} — {s.label ?? s.id.slice(0, 8)} ({s.total_reports})</option>)}
              </select>
              <Button size="sm" variant="outline" onClick={doDiff} disabled={!selectedFrom}>Diff vs now</Button>
            </div>
          )}
          {diff && (
            <div className="text-xs space-y-2 p-3 rounded border border-border bg-card/30">
              <div>Reports: <span className="font-mono">{diff.from.total}</span> → <span className="font-mono">{diff.to.total}</span> (<span className={cn('font-mono', diff.delta_reports > 0 ? 'text-emerald-400' : 'text-muted-foreground')}>{diff.delta_reports >= 0 ? '+' : ''}{diff.delta_reports}</span>)</div>
              <div>Disciplines: {Object.entries(diff.discipline_delta).filter(([, v]) => v !== 0).map(([k, v]) => <span key={k} className="mr-2 font-mono">{k}:{v >= 0 ? '+' : ''}{v}</span>)}</div>
              <div>Severities: {Object.entries(diff.severity_delta).filter(([, v]) => v !== 0).map(([k, v]) => <span key={k} className="mr-2 font-mono">{k}:{v >= 0 ? '+' : ''}{v}</span>)}</div>
              {diff.new_top_entities.length > 0 && <div>New top entities: {diff.new_top_entities.slice(0, 10).map((e) => `${e.entity_type}:${e.canonical_value}`).join(' · ')}</div>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ───────────── Wargaming ─────────────
interface WargameRun {
  id: string; scenario: string; red_objective: string | null; blue_objective: string | null;
  total_rounds: number; status: string; classification: string; started_at: number; completed_at: number | null
}
interface WargameRound {
  id: string; run_id: string; round_number: number; role: string; content: string; duration_ms: number; created_at: number
}

const ROLE_COLOR: Record<string, string> = {
  red_team_player: 'border-red-500/40 bg-red-500/10 text-red-300',
  blue_team_player: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  moderator: 'border-amber-500/40 bg-amber-500/10 text-amber-300'
}
const ROLE_LABEL: Record<string, string> = {
  red_team_player: 'RED TEAM',
  blue_team_player: 'BLUE TEAM',
  moderator: 'MODERATOR'
}

function WargameTab() {
  const [runs, setRuns] = useState<WargameRun[]>([])
  const [selected, setSelected] = useState<WargameRun | null>(null)
  const [rounds, setRounds] = useState<WargameRound[]>([])
  const [scenario, setScenario] = useState('')
  const [redObj, setRedObj] = useState('')
  const [blueObj, setBlueObj] = useState('')
  const [numRounds, setNumRounds] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try { setRuns(await window.heimdall.invoke('wargame:list', { limit: 20 }) as WargameRun[]) }
    catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }
  useEffect(() => { void load() }, [])

  const selectRun = async (run: WargameRun) => {
    setSelected(run)
    try { setRounds(await window.heimdall.invoke('wargame:rounds', run.id) as WargameRound[]) }
    catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }

  const start = async () => {
    if (!scenario.trim()) return
    setBusy(true); setError(null)
    try {
      const run = await window.heimdall.invoke('wargame:start', {
        scenario: scenario.trim(),
        red_objective: redObj.trim() || undefined,
        blue_objective: blueObj.trim() || undefined,
        total_rounds: numRounds
      }) as WargameRun
      setScenario(''); setRedObj(''); setBlueObj('')
      await load()
      await selectRun(run)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left — create + list */}
      <div className="w-[400px] border-r border-border overflow-auto">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Swords className="h-3.5 w-3.5" />New wargame
          </div>
          <Input placeholder='Scenario (e.g. "Russian missile strike on UA power grid")' value={scenario}
            onChange={(e) => setScenario(e.target.value)} />
          <div className="grid grid-cols-2 gap-1.5">
            <Input placeholder="Red objective (optional)" value={redObj} onChange={(e) => setRedObj(e.target.value)} className="text-xs" />
            <Input placeholder="Blue objective (optional)" value={blueObj} onChange={(e) => setBlueObj(e.target.value)} className="text-xs" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-muted-foreground">Rounds:</label>
            <Input type="number" min={1} max={10} value={numRounds} onChange={(e) => setNumRounds(parseInt(e.target.value) || 3)}
              className="w-16 text-xs" />
            <Button onClick={start} disabled={busy || !scenario.trim()} className="ml-auto">
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
              {busy ? 'Running…' : 'Start'}
            </Button>
          </div>
          {error && <div className="text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>}
        </div>
        {runs.map((r) => (
          <button key={r.id} onClick={() => void selectRun(r)}
            className={cn('w-full text-left px-3 py-2 border-b border-border/40 hover:bg-accent/30',
              selected?.id === r.id && 'bg-accent/50')}>
            <div className="text-sm font-medium truncate">{r.scenario}</div>
            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
              <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{r.total_rounds} rds</Badge>
              <Badge variant={r.status === 'completed' ? 'default' : 'secondary'} className="text-[9px] py-0 px-1">{r.status}</Badge>
              <span className="ml-auto">{formatRelativeTime(r.started_at)}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Right — transcript */}
      <div className="flex-1 overflow-auto">
        {selected && rounds.length > 0 ? (
          <div className="p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">{selected.scenario}</h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                {selected.red_objective && <span>Red: {selected.red_objective}</span>}
                {selected.blue_objective && <span>Blue: {selected.blue_objective}</span>}
                <Badge variant="outline" className="font-mono text-[9px]">{selected.classification}</Badge>
              </div>
            </div>
            {Array.from(new Set(rounds.map((r) => r.round_number))).sort().map((rn) => (
              <Card key={rn}>
                <CardHeader>
                  <CardTitle className="text-sm">Round {rn}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {rounds.filter((r) => r.round_number === rn).map((r) => (
                    <div key={r.id} className={cn('p-3 rounded border', ROLE_COLOR[r.role] || 'border-border')}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider">{ROLE_LABEL[r.role] || r.role}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">{r.duration_ms}ms</span>
                      </div>
                      <div className="text-xs whitespace-pre-wrap">{r.content}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Swords className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">Create a wargame scenario or select one from the list</p>
            <p className="text-xs mt-1 opacity-70">Red Team proposes → Blue Team counters → Moderator adjudicates. Each round runs via the configured LLM.</p>
          </div>
        )}
      </div>
    </div>
  )
}
