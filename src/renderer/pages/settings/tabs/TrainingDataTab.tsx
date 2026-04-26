import { useEffect, useState } from 'react'
import { GraduationCap, RefreshCw, Loader2, FileText, Database, Sparkles, Download, ScrollText } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { toast } from 'sonner'

/**
 * Training Data tab — control surface for Phase 2-3 ingesters.
 *
 * Sections:
 *   1. Threat-feed status (MITRE ATT&CK + MISP) with sync controls
 *   2. Training corpus status (CREST + custom) with topic-based ingest form
 *   3. Exemplar library quick stats
 *   4. Live ad-hoc IOC scan (paste text → see threat-feed matches)
 */

interface MitreStatus {
  count: number
  byType: Record<string, number>
  lastSync: number | null
}

interface MispFeedStatus {
  feeds: Array<{ id: string; name: string; enabled: boolean; count: number; lastSync: number | null }>
  totalIndicators: number
}

interface CrestStatus {
  count: number
  byEra: Record<string, number>
  byDocType: Record<string, number>
  lastIngested: number | null
}

interface ExemplarStatus {
  totalExemplars: number
  byEra: Record<string, number>
  byFormat: Record<string, number>
}

interface OverallStats {
  total: number
  bySource: Record<string, number>
  byType: Record<string, number>
  bySeverity: Record<string, number>
}

interface FullStatus {
  mitre: MitreStatus
  misp: MispFeedStatus
  crest: CrestStatus
  exemplars: ExemplarStatus
  overall: OverallStats
  inFlight: string[]
}

interface ScanMatch {
  type: string
  value: string
  feedSource: string
  severity: string
  tags: string[]
}

interface TradecraftItem {
  id: string
  format: string
  score: number
  regenerated: boolean
  createdAt: number
  deficiencyCount: number
}

interface TradecraftStats {
  averageScore: number
  passingPercent: number
  regeneratedCount: number
  totalScored: number
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-500',
  low: 'bg-slate-500'
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return 'never'
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

export function TrainingDataTab() {
  const [status, setStatus] = useState<FullStatus | null>(null)
  const [loading, setLoading] = useState(true)

  // CREST ingest form
  const [crestTopic, setCrestTopic] = useState('')
  const [crestMaxDocs, setCrestMaxDocs] = useState(15)

  // Ad-hoc IOC scan
  const [scanText, setScanText] = useState('')
  const [scanResults, setScanResults] = useState<ScanMatch[] | null>(null)

  // Tradecraft history
  const [tradecraftItems, setTradecraftItems] = useState<TradecraftItem[]>([])
  const [tradecraftStats, setTradecraftStats] = useState<TradecraftStats | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const r = await window.heimdall.invoke('training:status') as { ok: boolean; mitre: MitreStatus; misp: MispFeedStatus; crest: CrestStatus; exemplars: ExemplarStatus; overall: OverallStats; inFlight: string[]; error?: string }
      if (r.ok) {
        setStatus({
          mitre: r.mitre, misp: r.misp, crest: r.crest,
          exemplars: r.exemplars, overall: r.overall, inFlight: r.inFlight
        })
      } else {
        toast.error('Failed to load training status', { description: r.error })
      }
    } catch (err) {
      toast.error('Failed to load training status', { description: String(err) })
    } finally {
      setLoading(false)
    }
  }

  const refreshTradecraft = async (): Promise<void> => {
    try {
      const r = await window.heimdall.invoke('training:tradecraft_history', { limit: 25 }) as { ok: boolean; items?: TradecraftItem[]; stats?: TradecraftStats | null }
      if (r.ok) {
        setTradecraftItems(r.items || [])
        setTradecraftStats(r.stats || null)
      }
    } catch { /* */ }
  }

  useEffect(() => {
    refresh()
    refreshTradecraft()
    const t = setInterval(() => { refresh(); refreshTradecraft() }, 5000)
    return () => clearInterval(t)
  }, [])

  const inFlight = (key: string): boolean => status?.inFlight?.includes(key) ?? false

  const triggerMitreSync = async (): Promise<void> => {
    toast.info('MITRE ATT&CK sync started — this takes ~10s')
    const r = await window.heimdall.invoke('training:mitre_sync') as { ok: boolean; stats?: { inserted: number; durationMs: number }; error?: string }
    if (r.ok && r.stats) {
      toast.success(`MITRE: ${r.stats.inserted} indicators in ${r.stats.durationMs}ms`)
    } else {
      toast.error('MITRE sync failed', { description: r.error })
    }
    refresh()
  }

  const triggerMispSync = async (): Promise<void> => {
    toast.info('MISP feeds sync started — this takes 1-3 minutes')
    const r = await window.heimdall.invoke('training:misp_sync_all') as { ok: boolean; results?: Array<{ feedId: string; inserted: number; events: number }>; error?: string }
    if (r.ok && r.results) {
      const total = r.results.reduce((s, x) => s + x.inserted, 0)
      toast.success(`MISP: ${total} new indicators across ${r.results.length} feeds`)
    } else {
      toast.error('MISP sync failed', { description: r.error })
    }
    refresh()
  }

  const triggerCrestIngest = async (): Promise<void> => {
    if (!crestTopic.trim()) { toast.error('Enter a search topic'); return }
    toast.info(`CREST: searching for "${crestTopic}"…`)
    const r = await window.heimdall.invoke('training:crest_ingest', {
      topic: crestTopic.trim(), maxDocs: crestMaxDocs
    }) as { ok: boolean; stats?: { found: number; succeeded: number; failed: number; averageQuality: number }; error?: string }
    if (r.ok && r.stats) {
      toast.success(`CREST: ${r.stats.succeeded}/${r.stats.found} ingested (quality ${r.stats.averageQuality.toFixed(2)})`)
    } else {
      toast.error('CREST ingest failed', { description: r.error })
    }
    refresh()
  }

  const triggerScan = async (): Promise<void> => {
    if (!scanText.trim()) return
    const r = await window.heimdall.invoke('training:scan_text', { text: scanText }) as { ok: boolean; matches?: ScanMatch[]; error?: string }
    if (r.ok) {
      setScanResults(r.matches || [])
    } else {
      toast.error('Scan failed', { description: r.error })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!status) return <div>Failed to load training status</div>

  return (
    <div className="space-y-6 p-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <GraduationCap className="w-6 h-6 text-amber-400" />
        <div>
          <h2 className="text-xl font-semibold">Training Data &amp; Threat Feeds</h2>
          <p className="text-sm text-muted-foreground">
            Curated threat intelligence (MITRE ATT&amp;CK, MISP) cross-referenced against every report.
            Declassified IC documents (CREST) used as few-shot exemplars for analyst-quality output.
          </p>
        </div>
      </div>

      {/* OVERALL — top-line counters */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Indicators</CardDescription>
            <CardTitle className="text-2xl">{status.overall.total.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Object.keys(status.overall.bySource).length} feed source(s)
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>MITRE ATT&amp;CK</CardDescription>
            <CardTitle className="text-2xl">{status.mitre.count.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Last sync {formatRelativeTime(status.mitre.lastSync)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>MISP Feeds</CardDescription>
            <CardTitle className="text-2xl">{status.misp.totalIndicators.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {status.misp.feeds.filter((f) => f.enabled).length} enabled
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Exemplars (corpus)</CardDescription>
            <CardTitle className="text-2xl">{status.exemplars.totalExemplars.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            CREST: {status.crest.count}
          </CardContent>
        </Card>
      </div>

      {/* MITRE */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Database className="w-4 h-4" /> MITRE ATT&amp;CK
              </CardTitle>
              <CardDescription>
                Threat actors, malware families, tools, and techniques from the MITRE Enterprise STIX bundle. Auto-refreshes weekly.
              </CardDescription>
            </div>
            <Button onClick={triggerMitreSync} disabled={inFlight('mitre')} size="sm">
              {inFlight('mitre') ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {inFlight('mitre') ? 'Syncing…' : 'Sync now'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(status.mitre.byType).map(([type, n]) => (
              <Badge key={type} variant="outline" className="text-xs">
                <span className="font-mono mr-1">{type}</span> {n}
              </Badge>
            ))}
            {status.mitre.count === 0 && (
              <span className="text-xs text-muted-foreground">Empty — click "Sync now" to bootstrap.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* MISP */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Database className="w-4 h-4" /> MISP Public Feeds
              </CardTitle>
              <CardDescription>
                Free, no-auth threat-intel feeds. Auto-refreshes daily at 04:45.
              </CardDescription>
            </div>
            <Button onClick={triggerMispSync} disabled={inFlight('misp:all')} size="sm">
              {inFlight('misp:all') ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {inFlight('misp:all') ? 'Syncing…' : 'Sync all'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {status.misp.feeds.map((feed) => (
            <div key={feed.id} className="flex items-center justify-between text-sm border border-border rounded px-3 py-2">
              <div>
                <div className="font-medium">{feed.name}</div>
                <div className="text-xs text-muted-foreground">
                  {feed.count.toLocaleString()} indicators · last sync {formatRelativeTime(feed.lastSync)}
                </div>
              </div>
              <Badge variant={feed.enabled ? 'default' : 'outline'} className="text-xs">
                {feed.enabled ? 'enabled' : 'disabled'}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* CREST */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4" /> CIA CREST Archive (Training Corpus)
          </CardTitle>
          <CardDescription>
            Declassified IC documents from the CIA FOIA Reading Room. Used as few-shot exemplars
            so the LLM matches authentic IC tone &amp; structure. Rate-limited (3s/request) — start with small batches.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Label htmlFor="crest-topic">Search topic</Label>
              <Input
                id="crest-topic"
                value={crestTopic}
                onChange={(e) => setCrestTopic(e.target.value)}
                placeholder="e.g. soviet nuclear, terrorism, china intelligence"
              />
            </div>
            <div className="w-28">
              <Label htmlFor="crest-max">Max docs</Label>
              <Input
                id="crest-max"
                type="number"
                min={1}
                max={100}
                value={crestMaxDocs}
                onChange={(e) => setCrestMaxDocs(Math.max(1, Math.min(100, Number(e.target.value) || 15)))}
              />
            </div>
            <Button onClick={triggerCrestIngest} disabled={inFlight(`crest:${crestTopic.trim()}`) || !crestTopic.trim()}>
              {inFlight(`crest:${crestTopic.trim()}`) ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Ingesting…</>
              ) : (
                <><Download className="w-4 h-4 mr-2" /> Ingest</>
              )}
            </Button>
          </div>
          <div className="flex gap-2 flex-wrap text-xs">
            <Badge variant="outline">Total: {status.crest.count}</Badge>
            {Object.entries(status.crest.byEra).map(([era, n]) => (
              <Badge key={era} variant="outline" className="text-amber-300">
                era:{era} · {n}
              </Badge>
            ))}
            {Object.entries(status.crest.byDocType).map(([t, n]) => (
              <Badge key={t} variant="outline">
                {t} · {n}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Estimate: {Math.ceil(crestMaxDocs * 3 / 60)} min for {crestMaxDocs} docs (rate-limited).
            Searches CIA reading room and downloads PDFs into your local training corpus.
          </p>
        </CardContent>
      </Card>

      {/* TRADECRAFT HISTORY */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="w-4 h-4" /> Tradecraft Compliance History (ICD 203)
          </CardTitle>
          <CardDescription>
            Every report Heimdall generates is scored against the 9 ICD 203 analytic tradecraft standards.
            Reports below 70/100 trigger an automatic regeneration with deficiency notes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!tradecraftStats && (
            <p className="text-xs text-muted-foreground">
              No reports scored yet. Run a chat query to start populating this view.
            </p>
          )}
          {tradecraftStats && (
            <>
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="border border-border rounded p-3">
                  <div className="text-xs text-muted-foreground">Average Score</div>
                  <div className={`text-2xl font-semibold ${tradecraftStats.averageScore >= 70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {tradecraftStats.averageScore}/100
                  </div>
                </div>
                <div className="border border-border rounded p-3">
                  <div className="text-xs text-muted-foreground">Pass Rate</div>
                  <div className="text-2xl font-semibold">
                    {tradecraftStats.passingPercent}%
                  </div>
                </div>
                <div className="border border-border rounded p-3">
                  <div className="text-xs text-muted-foreground">Auto-regenerated</div>
                  <div className="text-2xl font-semibold text-cyan-400">
                    {tradecraftStats.regeneratedCount}
                  </div>
                </div>
                <div className="border border-border rounded p-3">
                  <div className="text-xs text-muted-foreground">Total Scored</div>
                  <div className="text-2xl font-semibold">
                    {tradecraftStats.totalScored}
                  </div>
                </div>
              </div>
              <div className="border border-border rounded divide-y divide-border max-h-64 overflow-y-auto">
                {tradecraftItems.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <span className={`font-mono font-semibold w-14 ${it.score >= 70 ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {it.score}/100
                    </span>
                    <Badge variant="outline" className="text-[10px] uppercase w-20 justify-center">{it.format}</Badge>
                    {it.regenerated && (
                      <Badge variant="outline" className="text-[10px] text-cyan-400 border-cyan-400/40">regenerated</Badge>
                    )}
                    {it.deficiencyCount > 0 && (
                      <span className="text-muted-foreground">{it.deficiencyCount} deficienc{it.deficiencyCount === 1 ? 'y' : 'ies'}</span>
                    )}
                    <span className="ml-auto text-muted-foreground">{formatRelativeTime(it.createdAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* AD-HOC SCAN */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" /> Live IOC Scanner
          </CardTitle>
          <CardDescription>
            Paste any text — IPs, domains, hashes, CVEs, threat-actor names — and see which match
            known-bad indicators in the threat-feed database. Same code path used by report synthesis.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={scanText}
            onChange={(e) => setScanText(e.target.value)}
            rows={5}
            className="w-full text-sm bg-card border border-border rounded p-2 font-mono"
            placeholder="LockBit affiliates exploited CVE-2024-3400. C2 IP 185.220.101.45 with hash 5d41402abc4b2a76b9719d911017c592 …"
          />
          <Button onClick={triggerScan} disabled={!scanText.trim()} size="sm">
            <Sparkles className="w-4 h-4 mr-2" /> Scan
          </Button>
          {scanResults !== null && (
            <div className="border border-border rounded p-3 space-y-1">
              <div className="text-xs font-semibold mb-2">
                {scanResults.length} match{scanResults.length === 1 ? '' : 'es'} found
              </div>
              {scanResults.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No known-bad indicators in this text. Try pasting a paragraph that mentions LockBit,
                  Lazarus Group, APT29, a CVE, or a known C2 IP.
                </div>
              )}
              {scanResults.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className={`w-2 h-2 rounded-full ${SEVERITY_COLOR[m.severity] || 'bg-slate-500'}`} />
                  <Badge variant="outline" className="text-[10px] uppercase">{m.type}</Badge>
                  <span className="font-mono">{m.value}</span>
                  <span className="text-muted-foreground">→ {m.feedSource}</span>
                  {m.tags.length > 0 && (
                    <span className="text-amber-300/70">[{m.tags.slice(0, 3).join(', ')}]</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
