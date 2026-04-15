import { useEffect, useState, useCallback } from 'react'
import { Activity, RefreshCw, Search, Tag, Link2, Shield, Lock, ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { ipc } from '@renderer/lib/ipc'
import { formatRelativeTime } from '@renderer/lib/utils'
import { ClassificationBadge } from '@renderer/components/ClassificationBanner'

interface ChainEntry {
  id: string
  sequence: number
  action: string
  actor?: string
  entity_type?: string
  entity_id?: string
  classification?: string
  payload?: Record<string, unknown>
  timestamp: number
  prev_hash: string
  this_hash: string
}

interface VerifyResult {
  ok: boolean
  totalRows: number
  firstMismatchSequence?: number
  message: string
}

export function AuditPage() {
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [topTags, setTopTags] = useState<Array<{ tag: string; count: number }>>([])
  const [topEntities, setTopEntities] = useState<Array<{ type: string; value: string; count: number }>>([])
  const [activeTab, setActiveTab] = useState<'audit' | 'tags' | 'entities' | 'chain'>('audit')

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
          {(['tags', 'entities', 'audit', 'chain'] as const).map((tab) => (
            <Button key={tab} variant={activeTab === tab ? 'default' : 'outline'} size="sm" onClick={() => setActiveTab(tab)}>
              {tab === 'tags' ? <><Tag className="h-3.5 w-3.5 mr-1.5" />Tags</> :
               tab === 'entities' ? <><Shield className="h-3.5 w-3.5 mr-1.5" />Entities</> :
               tab === 'chain' ? <><Lock className="h-3.5 w-3.5 mr-1.5" />Tamper-Evident Chain</> :
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

      {activeTab === 'chain' && <TamperEvidentChainPanel />}
    </div>
  )
}

/**
 * Tamper-evident audit chain (Theme 10.4).
 *
 * Lists every classification override, source-rating change, deletion, and
 * other security-relevant action with the running cryptographic chain hash.
 * Verify button walks the chain and reports the first mismatch.
 */
function TamperEvidentChainPanel() {
  const [entries, setEntries] = useState<ChainEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const result = await window.heimdall.invoke('audit:chain:list', { limit: 200, offset: 0 }) as { total: number; entries: ChainEntry[] }
      setEntries(result.entries || [])
      setTotal(result.total || 0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const verify = async () => {
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await window.heimdall.invoke('audit:chain:verify') as VerifyResult
      setVerifyResult(result)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4" /> Tamper-Evident Chain
            </CardTitle>
            <CardDescription>
              {total} security-relevant actions in a hash-chain. Every row's hash includes the previous row's hash —
              tampering with history breaks the chain and is detectable on verify.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            </Button>
            <Button size="sm" onClick={verify} disabled={verifying || total === 0}>
              {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />}
              Verify Chain
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {verifyResult && (
          <div className={`mb-3 p-3 rounded-md border text-xs ${verifyResult.ok
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            : 'border-red-500/40 bg-red-500/10 text-red-300'}`}>
            <div className="flex items-center gap-2 font-semibold mb-1">
              {verifyResult.ok ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
              {verifyResult.ok ? 'Chain Intact' : 'TAMPER DETECTED'}
            </div>
            <p>{verifyResult.message}</p>
            {verifyResult.firstMismatchSequence && (
              <p className="mt-1 font-mono">First mismatch at sequence #{verifyResult.firstMismatchSequence}</p>
            )}
          </div>
        )}

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            Chain is empty. Security-relevant actions (classification changes, deletions, source rating changes) will appear here.
          </p>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-auto pr-1">
            {entries.map((e) => (
              <div key={e.id} className="border border-border/50 rounded p-2 text-xs hover:bg-accent/30">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-muted-foreground/70">#{e.sequence}</span>
                  <Badge variant="outline" className="text-[9px] py-0 px-1.5 font-mono">{e.action}</Badge>
                  {e.classification && <ClassificationBadge level={e.classification as 'UNCLASSIFIED' | 'CONFIDENTIAL' | 'SECRET' | 'TOP SECRET'} />}
                  {e.entity_type && (
                    <span className="text-muted-foreground/80">
                      {e.entity_type}: <span className="font-mono">{(e.entity_id || '').slice(0, 12)}</span>
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto">{formatRelativeTime(e.timestamp)}</span>
                </div>
                {e.payload && Object.keys(e.payload).length > 0 && (
                  <pre className="mt-1.5 text-[10px] text-muted-foreground/80 font-mono overflow-x-auto">
                    {JSON.stringify(e.payload, null, 0).slice(0, 200)}
                  </pre>
                )}
                <div className="mt-1 text-[9px] text-muted-foreground/50 font-mono truncate" title={e.this_hash}>
                  hash {e.this_hash.slice(0, 16)}… ← prev {e.prev_hash.slice(0, 12)}…
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
