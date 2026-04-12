import { useEffect, useState, useCallback } from 'react'
import { Activity, RefreshCw, Search, Tag, Link2, Shield } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { ipc } from '@renderer/lib/ipc'
import { formatRelativeTime } from '@renderer/lib/utils'

export function AuditPage() {
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [topTags, setTopTags] = useState<Array<{ tag: string; count: number }>>([])
  const [topEntities, setTopEntities] = useState<Array<{ type: string; value: string; count: number }>>([])
  const [activeTab, setActiveTab] = useState<'audit' | 'tags' | 'entities'>('audit')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    loadAudit()
    loadEnrichmentStats()
  }, [])

  const loadAudit = async () => {
    setLoading(true)
    try {
      const result = await ipc.intel.getDashboardStats()
      // Use audit bridge
      const auditResult = await invoke('audit:getEntries', { offset: 0, limit: 100 }) as {
        entries: Array<Record<string, unknown>>; total: number
      }
      setEntries(auditResult?.entries || [])
      setTotal(auditResult?.total || 0)
    } catch {}
    setLoading(false)
  }

  const loadEnrichmentStats = async () => {
    try {
      const tags = await invoke('enrichment:getTopTags', { limit: 30 }) as Array<{ tag: string; count: number }>
      setTopTags(tags || [])

      const entities = await invoke('enrichment:getTopEntities', { limit: 30 }) as Array<{ type: string; value: string; count: number }>
      setTopEntities(entities || [])
    } catch {}
  }

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-muted-foreground" />
            Intelligence Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tags, entities, connections, and audit trail
          </p>
        </div>
        <div className="flex gap-2">
          {(['tags', 'entities', 'audit'] as const).map((tab) => (
            <Button key={tab} variant={activeTab === tab ? 'default' : 'outline'} size="sm" onClick={() => setActiveTab(tab)}>
              {tab === 'tags' ? <><Tag className="h-3.5 w-3.5 mr-1.5" />Tags</> :
               tab === 'entities' ? <><Shield className="h-3.5 w-3.5 mr-1.5" />Entities</> :
               <><Activity className="h-3.5 w-3.5 mr-1.5" />Audit Log</>}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => { loadAudit(); loadEnrichmentStats() }}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {activeTab === 'tags' && (
        <div className="grid grid-cols-2 gap-4">
          <Card className="col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Auto-Generated Tags</CardTitle>
              <CardDescription>Tags automatically assigned to intelligence reports based on content analysis</CardDescription>
            </CardHeader>
            <CardContent>
              {topTags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {topTags.map((t) => (
                    <Badge key={t.tag} variant="secondary" className="text-xs gap-1 py-1 px-2.5">
                      <Tag className="h-3 w-3" />
                      {t.tag}
                      <span className="text-muted-foreground ml-1">({t.count})</span>
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No tags generated yet. Tags are created automatically when intel is collected.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'entities' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extracted Entities</CardTitle>
            <CardDescription>Named entities automatically extracted from intelligence reports (IPs, CVEs, organizations, countries, threat actors)</CardDescription>
          </CardHeader>
          <CardContent>
            {topEntities.length > 0 ? (
              <div className="space-y-1">
                {/* Group by type */}
                {Object.entries(
                  topEntities.reduce<Record<string, Array<{ value: string; count: number }>>>((acc, e) => {
                    (acc[e.type] = acc[e.type] || []).push({ value: e.value, count: e.count })
                    return acc
                  }, {})
                ).map(([type, entities]) => (
                  <div key={type} className="mb-4">
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{type.replace('_', ' ')}</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {entities.map((e) => (
                        <Badge key={e.value} variant="outline" className="text-xs font-mono gap-1">
                          {e.value}
                          <span className="text-muted-foreground">({e.count})</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No entities extracted yet. Entities are extracted when intel reports are enriched.</p>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'audit' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit Trail</CardTitle>
            <CardDescription>{total} audit entries — all data collection and access actions logged</CardDescription>
          </CardHeader>
          <CardContent>
            {entries.length > 0 ? (
              <div className="space-y-0.5 max-h-[60vh] overflow-auto">
                {entries.map((entry) => (
                  <div key={entry.id as string} className="flex items-center justify-between text-xs py-1.5 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-[9px] py-0 px-1.5 font-mono shrink-0">
                        {entry.action as string}
                      </Badge>
                      <span className="truncate max-w-md text-muted-foreground">
                        {entry.source_url ? (entry.source_url as string).slice(0, 80) : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {entry.http_status && (
                        <Badge variant={(entry.http_status as number) < 400 ? 'success' : 'error'} className="text-[9px]">
                          {entry.http_status as number}
                        </Badge>
                      )}
                      <span className="text-muted-foreground">
                        {formatRelativeTime(entry.created_at as number)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No audit entries yet</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
