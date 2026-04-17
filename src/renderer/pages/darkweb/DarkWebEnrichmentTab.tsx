import { useEffect, useState, useCallback } from 'react'
import { Sparkles, Loader2, RefreshCw, Tag, Bug, Bitcoin, Mail, Globe, Hash, Send, Users, Building, Cpu } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { toast } from 'sonner'

interface EnrichStatus { queued: number; inFlight: number; processedTotal: number }
interface Counts { enriched: number; unenriched: number; total: number }
interface IocSummary { type: string; reportCount: number }
interface TagCount { tag: string; count: number }
interface Summary {
  counts: Counts
  iocs: IocSummary[]
  topActors: TagCount[]
  topMarketplaces: TagCount[]
  topVictims: TagCount[]
  topActivities: TagCount[]
  topTech: TagCount[]
}

const IOC_ICONS: Record<string, typeof Bug> = {
  btc: Bitcoin, eth: Bitcoin, xmr: Bitcoin,
  ipv4: Globe, email: Mail, md5: Hash, sha1: Hash, sha256: Hash,
  cve: Bug, onion: Globe, telegram: Send, jabber: Send
}

export function DarkWebEnrichmentTab() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [status, setStatus] = useState<EnrichStatus>({ queued: 0, inFlight: 0, processedTotal: 0 })
  const [loading, setLoading] = useState(false)
  const [enrichingAll, setEnrichingAll] = useState(false)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await invoke('darkweb:enrichment_summary') as Summary
      setSummary(s)
      const st = await invoke('darkweb:enrich_status') as EnrichStatus
      setStatus(st)
    } finally { setLoading(false) }
  }, [invoke])

  useEffect(() => { void load() }, [load])

  // Live enrichment progress
  useEffect(() => {
    const unsub = window.heimdall.on('darkweb:enrich_progress', (s: unknown) => {
      const ss = s as EnrichStatus
      setStatus(ss)
      // When the queue empties + we were running a batch, refresh the
      // counts so the Enriched/Unenriched counters update.
      if (ss.queued === 0 && ss.inFlight === 0 && enrichingAll) {
        setEnrichingAll(false)
        toast.success(`Enrichment batch complete`, { description: `${ss.processedTotal} reports processed` })
        void load()
      }
    })
    return () => { unsub() }
  }, [enrichingAll, load])

  const onEnrichAll = async () => {
    setEnrichingAll(true)
    try {
      const r = await invoke('darkweb:enrich_all') as { queued: number }
      if (r.queued === 0) {
        setEnrichingAll(false)
        toast.message('All darkweb reports already enriched', { description: 'Re-enrichment runs after 7 days.' })
      } else {
        toast.message(`Queued ${r.queued} reports for enrichment`, { description: 'Processing in background…' })
      }
    } catch (err) {
      setEnrichingAll(false)
      toast.error('Enrichment failed to start', { description: String(err) })
    }
  }

  if (!summary) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading enrichment summary…
      </div>
    )
  }

  const { counts, iocs, topActors, topMarketplaces, topVictims, topActivities, topTech } = summary
  const enrichPercent = counts.total === 0 ? 0 : Math.round((counts.enriched / counts.total) * 100)

  return (
    <div className="flex flex-col h-full overflow-auto p-4 space-y-4">
      {/* Top status card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-300" /> Dark-web enrichment pipeline
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Two-phase enrichment: deterministic regex extraction (IOCs, threat actors, activity classification, language)
                + LLM tag generation via small/fast routed model. Auto-runs on every new <code className="font-mono">[DARKWEB]</code> report.
              </CardDescription>
            </div>
            <Button onClick={onEnrichAll} disabled={enrichingAll || counts.unenriched === 0}>
              {enrichingAll ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              Enrich all unenriched ({counts.unenriched})
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="rounded border border-border p-3 text-center">
              <div className="text-2xl font-semibold text-amber-300">{counts.enriched.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Enriched</div>
            </div>
            <div className="rounded border border-border p-3 text-center">
              <div className="text-2xl font-semibold text-fuchsia-300">{counts.unenriched.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Unenriched</div>
            </div>
            <div className="rounded border border-border p-3 text-center">
              <div className="text-2xl font-semibold">{counts.total.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Total dark-web</div>
            </div>
          </div>
          <div className="h-1.5 bg-muted rounded overflow-hidden mb-1">
            <div className="h-full bg-amber-400 transition-all" style={{ width: `${enrichPercent}%` }} />
          </div>
          <div className="text-[10px] text-muted-foreground text-right">{enrichPercent}% enriched</div>

          {(status.queued > 0 || status.inFlight > 0) && (
            <div className="mt-3 text-[11px] text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Queue: <span className="text-amber-300">{status.queued}</span> waiting · <span className="text-fuchsia-300">{status.inFlight}</span> in flight · {status.processedTotal} processed total</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* IOC summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2"><Bug className="h-4 w-4" /> IOC summary</CardTitle>
          <CardDescription className="text-xs">Indicator types found across all enriched dark-web reports</CardDescription>
        </CardHeader>
        <CardContent>
          {iocs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No IOCs extracted yet.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {iocs.map((i) => {
                const Icon = IOC_ICONS[i.type] || Tag
                return (
                  <div key={i.type} className="rounded border border-border p-2 flex items-center gap-2">
                    <Icon className="h-4 w-4 text-amber-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono uppercase">{i.type}</div>
                      <div className="text-[10px] text-muted-foreground">{i.reportCount} reports</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top tags grids */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TagPanel title="Top threat actors" icon={Users} tone="text-fuchsia-300" tags={topActors} prefix="actor:" />
        <TagPanel title="Top activity types" icon={Tag} tone="text-amber-300" tags={topActivities} prefix="darkweb:" />
        <TagPanel title="Top marketplaces" icon={Building} tone="text-orange-300" tags={topMarketplaces} prefix="marketplace:" />
        <TagPanel title="Top affected tech / CVEs" icon={Cpu} tone="text-cyan-300" tags={topTech} prefix="tech:" />
        {topVictims.length > 0 && (
          <div className="md:col-span-2">
            <TagPanel title="Named victims" icon={Building} tone="text-red-300" tags={topVictims} prefix="victim:" />
          </div>
        )}
      </div>
    </div>
  )
}

function TagPanel({ title, icon: Icon, tone, tags, prefix }: {
  title: string
  icon: typeof Tag
  tone: string
  tags: TagCount[]
  prefix: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2"><Icon className={cn('h-4 w-4', tone)} /> {title}</CardTitle>
      </CardHeader>
      <CardContent>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">None detected yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Badge key={t.tag} variant="outline" className="text-[10px] gap-1">
                <span className={tone}>{t.tag.replace(prefix, '')}</span>
                <span className="text-muted-foreground">×{t.count}</span>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
