import { useState, useEffect, useCallback } from 'react'
import {
  Sparkles, Search, RefreshCw, Tag, Shield, Link2,
  ChevronRight, Loader2, X
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import { formatRelativeTime, cn } from '@renderer/lib/utils'

interface EnrichedReport {
  id: string; title: string; discipline: string; severity: string
  sourceName: string; verificationScore: number; content: string
  createdAt: number; sourceUrl: string | null
  tags: Array<{ tag: string; confidence: number }>
  entities: Array<{ type: string; value: string; confidence: number }>
  links: Array<{ linkedReportId: string; linkType: string; strength: number; reason: string }>
}

export function EnrichedPage() {
  const [reports, setReports] = useState<EnrichedReport[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedReport, setSelectedReport] = useState<EnrichedReport | null>(null)
  const [filterTag, setFilterTag] = useState('')
  const [filterEntityType, setFilterEntityType] = useState('all')
  const [filterCorroboration, setFilterCorroboration] = useState('all')
  const [topTags, setTopTags] = useState<Array<{ tag: string; count: number }>>([])
  const [topEntities, setTopEntities] = useState<Array<{ type: string; value: string; count: number }>>([])
  const [enrichmentStats, setEnrichmentStats] = useState<{ enriched: number; queued: number } | null>(null)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    loadData()
    loadStats()
    const interval = setInterval(loadStats, 5000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => { loadData() }, [filterTag, filterEntityType, filterCorroboration])

  // Listen for enrichment progress (safe — catch if event not allowed)
  useEffect(() => {
    try {
      const unsub = window.heimdall.on('enrichment:progress', (data: unknown) => {
        setEnrichmentStats(data as any)
      })
      return unsub
    } catch {
      // Event not in allowlist — skip
      return () => {}
    }
  }, [])

  const loadStats = async () => {
    try {
      const [tags, entities] = await Promise.all([
        invoke('enrichment:getTopTags', { limit: 30 }) as Promise<Array<{ tag: string; count: number }>>,
        invoke('enrichment:getTopEntities', { limit: 30 }) as Promise<Array<{ type: string; value: string; count: number }>>
      ])
      setTopTags(tags || [])
      setTopEntities(entities || [])
    } catch {}
  }

  const loadData = async () => {
    setLoading(true)
    try {
      const result = await invoke('enrichment:getEnrichedReports', {
        tag: filterTag || undefined,
        entityType: filterEntityType !== 'all' ? filterEntityType : undefined,
        corroboration: filterCorroboration !== 'all' ? filterCorroboration : undefined,
        limit: 100
      }) as EnrichedReport[]
      console.log('Enriched reports received:', result?.length)
      setReports(result || [])
    } catch (err) {
      console.error('Enriched reports error:', err)
      setReports([])
    }
    setLoading(false)
  }

  const entityTypes = [...new Set(topEntities.map((e) => e.type))].sort()

  return (
    <div className="flex h-full">
      {/* Left: Filters */}
      <div className="w-64 border-r border-border bg-card/50 p-4 space-y-5 overflow-auto">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <span className="text-sm font-bold">Enriched Data</span>
        </div>

        {enrichmentStats && (
          <div className="text-xs text-muted-foreground space-y-1">
            <div>Enriched: {(enrichmentStats as any).enriched || 0}</div>
            <div>Queued: {(enrichmentStats as any).queued || 0}</div>
          </div>
        )}

        {/* Tag filter */}
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="h-3 w-3" />Filter by Tag</label>
          <Select value={filterTag || 'all'} onValueChange={(v) => setFilterTag(v === 'all' ? '' : v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="All tags" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {topTags.slice(0, 20).map((t) => (
                <SelectItem key={t.tag} value={t.tag}>{t.tag} ({t.count})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Entity type filter */}
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground flex items-center gap-1"><Shield className="h-3 w-3" />Entity Type</label>
          <Select value={filterEntityType} onValueChange={setFilterEntityType}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {entityTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Corroboration filter */}
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground flex items-center gap-1"><Link2 className="h-3 w-3" />Corroboration</label>
          <Select value={filterCorroboration} onValueChange={setFilterCorroboration}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="high">High (20+)</SelectItem>
              <SelectItem value="medium">Medium (10+)</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Top tags cloud */}
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Popular Tags</label>
          <div className="flex flex-wrap gap-1">
            {topTags.slice(0, 15).map((t) => (
              <button key={t.tag} onClick={() => setFilterTag(t.tag === filterTag ? '' : t.tag)}
                className={cn('text-[9px] px-1.5 py-0.5 rounded border transition-colors',
                  filterTag === t.tag ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:border-foreground'
                )}>
                {t.tag}
              </button>
            ))}
          </div>
        </div>

        <Button variant="outline" size="sm" className="w-full" onClick={loadData} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Refresh
        </Button>
      </div>

      {/* Center: Results */}
      <div className="flex-1 overflow-auto">
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border">
          {reports.length} enriched reports
        </div>
        {loading ? (
          <div className="flex items-center justify-center h-40"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : reports.length > 0 ? (
          <div className="divide-y divide-border">
            {reports.map((report) => (
              <div key={report.id} className={cn('px-3 py-2.5 cursor-pointer hover:bg-accent/50', selectedReport?.id === report.id && 'bg-accent')}
                onClick={() => setSelectedReport(report)}>
                <div className="text-sm font-medium truncate">{report.title}</div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <Badge variant={report.severity === 'critical' ? 'destructive' : report.severity === 'high' ? 'warning' : 'secondary'} className="text-[9px] py-0">{report.severity}</Badge>
                  <span className="text-[10px] text-muted-foreground">{report.sourceName}</span>
                  {report.tags.slice(0, 3).map((t) => (
                    <Badge key={t.tag} variant="outline" className="text-[9px] py-0 gap-0.5"><Tag className="h-2 w-2" />{t.tag}</Badge>
                  ))}
                  {report.entities.length > 0 && <Badge variant="secondary" className="text-[9px] py-0">{report.entities.length} entities</Badge>}
                  {report.links.length > 0 && <Badge variant="secondary" className="text-[9px] py-0"><Link2 className="h-2 w-2 mr-0.5" />{report.links.length} links</Badge>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <Sparkles className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">No enriched data matches filters</p>
          </div>
        )}
      </div>

      {/* Right: Detail */}
      {selectedReport && (
        <div className="w-[380px] border-l border-border overflow-auto bg-card/30 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <Badge variant={selectedReport.severity === 'critical' ? 'destructive' : 'secondary'}>{selectedReport.severity.toUpperCase()}</Badge>
            <button onClick={() => setSelectedReport(null)} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
          </div>
          <h3 className="text-sm font-semibold">{selectedReport.title}</h3>

          {/* Tags */}
          {selectedReport.tags.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Tags</label>
              <div className="flex flex-wrap gap-1">
                {selectedReport.tags.map((t) => (
                  <Badge key={t.tag} variant="default" className="text-[10px] gap-1"><Tag className="h-2.5 w-2.5" />{t.tag} <span className="opacity-60">{(t.confidence * 100).toFixed(0)}%</span></Badge>
                ))}
              </div>
            </div>
          )}

          {/* Entities */}
          {selectedReport.entities.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Entities</label>
              <div className="space-y-1">
                {Object.entries(selectedReport.entities.reduce<Record<string, string[]>>((acc, e) => {
                  (acc[e.type] = acc[e.type] || []).push(e.value)
                  return acc
                }, {})).map(([type, values]) => (
                  <div key={type} className="text-xs">
                    <span className="text-muted-foreground uppercase text-[9px]">{type}: </span>
                    {values.map((v) => <Badge key={v} variant="outline" className="text-[9px] py-0 mr-0.5 font-mono">{v}</Badge>)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Links */}
          {selectedReport.links.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Linked Reports ({selectedReport.links.length})</label>
              <div className="space-y-1">
                {selectedReport.links.slice(0, 10).map((link, i) => (
                  <div key={i} className="text-[10px] flex items-center gap-1 text-muted-foreground">
                    <Link2 className="h-2.5 w-2.5" />
                    <span className="font-mono">{link.linkedReportId.slice(0, 8)}...</span>
                    <Badge variant="outline" className="text-[8px] py-0">{link.linkType}</Badge>
                    <span>{link.reason?.slice(0, 40)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Verification */}
          <div className="text-xs">
            <span className="text-muted-foreground">Verification: </span>
            <span className={selectedReport.verificationScore >= 80 ? 'text-green-500' : selectedReport.verificationScore >= 50 ? 'text-yellow-500' : 'text-red-500'}>
              {selectedReport.verificationScore}/100
            </span>
          </div>

          {/* Content */}
          <MarkdownRenderer content={selectedReport.content} className="text-xs" />
        </div>
      )}
    </div>
  )
}
