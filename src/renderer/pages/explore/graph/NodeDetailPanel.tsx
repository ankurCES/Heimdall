import { useEffect, useState } from 'react'
import { ExternalLink, Copy, X, FileText } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent } from '@renderer/components/ui/card'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

export interface GraphNodeLite {
  id: string
  title: string
  discipline: string
  severity: string
  source: string
  verification: number
  createdAt?: number
  snippet?: string
  type?: string            // 'preliminary' | 'humint' | 'gap' | undefined (regular intel)
  confidence?: string      // HUMINT
  sessionId?: string       // HUMINT
}

export interface GraphLinkLite {
  source: string
  target: string
  type: string
  strength: number
  reason: string
}

interface Props {
  node: GraphNodeLite
  linkedItems: Array<{ node: GraphNodeLite; link: GraphLinkLite }>
  linkColors: Record<string, string>
  onClose: () => void
  onSelectNode: (n: GraphNodeLite) => void
}

interface EnrichmentCache {
  tags: Array<{ tag: string; confidence: number; source: string }>
  entities: Array<{ entity_type: string; entity_value: string; confidence: number }>
  fullContent?: string
  sourceUrl?: string | null
  humintSourceIds?: string[]
  humintAnalystNotes?: string
  humintFindings?: string
}

const CACHE = new Map<string, { data: EnrichmentCache; ts: number }>()
const TTL = 60_000

async function fetchDetails(node: GraphNodeLite): Promise<EnrichmentCache> {
  const cached = CACHE.get(node.id)
  if (cached && Date.now() - cached.ts < TTL) return cached.data

  const invoke = <T,>(ch: string, p?: unknown): Promise<T> => window.heimdall.invoke(ch, p) as Promise<T>

  const [tags, entities, report] = await Promise.allSettled([
    invoke<EnrichmentCache['tags']>('enrichment:getTags', { reportId: node.id }),
    invoke<EnrichmentCache['entities']>('enrichment:getEntities', { reportId: node.id }),
    invoke<{ content: string; sourceUrl: string | null } | null>('intel:getReport', { id: node.id })
  ])

  const data: EnrichmentCache = {
    tags: tags.status === 'fulfilled' ? (tags.value || []) : [],
    entities: entities.status === 'fulfilled' ? (entities.value || []) : [],
    fullContent: report.status === 'fulfilled' && report.value ? report.value.content : undefined,
    sourceUrl: report.status === 'fulfilled' && report.value ? report.value.sourceUrl : null
  }

  // HUMINT extras — fetch via humint-specific row if this is a HUMINT node
  if (node.type === 'humint') {
    try {
      const humint = await invoke<{ sourceReportIds: string[]; analystNotes: string; findings: string } | null>('chat:getHumintReports')
      const all = Array.isArray(humint) ? humint : []
      const match = all.find((h: any) => h.id === node.id)
      if (match) {
        data.humintSourceIds = Array.isArray(match.sourceReportIds)
          ? match.sourceReportIds
          : (typeof match.sourceReportIds === 'string' ? JSON.parse(match.sourceReportIds || '[]') : [])
        data.humintAnalystNotes = match.analystNotes
        data.humintFindings = match.findings
      }
    } catch {}
  }

  CACHE.set(node.id, { data, ts: Date.now() })
  return data
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/40',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  info: 'bg-gray-500/20 text-gray-400 border-gray-500/40'
}

export function NodeDetailPanel({ node, linkedItems, linkColors, onClose, onSelectNode }: Props) {
  const [details, setDetails] = useState<EnrichmentCache | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    setLoadingDetails(true)
    setDetails(null)
    fetchDetails(node).then((d) => {
      if (!cancelled) {
        setDetails(d)
        setLoadingDetails(false)
      }
    }).catch(() => { if (!cancelled) setLoadingDetails(false) })
    return () => { cancelled = true }
  }, [node.id])

  const content =
    node.type === 'humint' ? (details?.humintFindings || node.snippet || 'No content')
    : node.type === 'gap' ? (node.snippet || node.title)
    : (details?.fullContent || node.snippet || 'Loading content...')

  const typeLabel =
    node.type === 'humint' ? 'HUMINT'
    : node.type === 'preliminary' ? 'PRELIMINARY'
    : node.type === 'gap' ? 'INFO GAP'
    : node.discipline?.toUpperCase() || 'INTEL'

  return (
    <div className="w-[380px] border-l border-border bg-card/80 backdrop-blur overflow-auto">
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px] font-mono', SEVERITY_STYLES[node.severity] || '')}>
          {(node.severity || '').toUpperCase()}
        </Badge>
        <Badge variant="outline" className="text-[10px] font-mono">{typeLabel}</Badge>
        {node.type === 'humint' && node.confidence && (
          <Badge variant="outline" className="text-[10px] font-mono">CONF: {(node.confidence).toUpperCase()}</Badge>
        )}
        <button
          onClick={onClose}
          className="ml-auto p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        <h2 className="text-sm font-semibold leading-tight">{node.title}</h2>

        {/* Metadata card */}
        <Card>
          <CardContent className="p-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground shrink-0">Source</span>
              <span className="truncate text-right">{node.source}</span>
            </div>
            {node.createdAt && (
              <>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground shrink-0">Collected</span>
                  <span className="text-right">{formatRelativeTime(node.createdAt)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground shrink-0">Timestamp</span>
                  <span className="text-[10px] text-right">{new Date(node.createdAt).toLocaleString()}</span>
                </div>
              </>
            )}
            <div className="flex justify-between gap-2 items-center">
              <span className="text-muted-foreground shrink-0">Verification</span>
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full',
                      node.verification >= 80 ? 'bg-green-500' :
                      node.verification >= 50 ? 'bg-yellow-500' : 'bg-red-500')}
                    style={{ width: `${node.verification}%` }}
                  />
                </div>
                <span className="font-mono text-[10px]">{node.verification}/100</span>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground shrink-0">ID</span>
              <button
                onClick={() => { navigator.clipboard.writeText(node.id); toast.success('ID copied') }}
                className="font-mono text-[9px] text-right hover:text-foreground text-muted-foreground"
                title="Click to copy"
              >
                {node.id.slice(0, 24)}{node.id.length > 24 ? '…' : ''}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Tags */}
        {details && details.tags.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">Tags</div>
            <div className="flex flex-wrap gap-1">
              {details.tags.slice(0, 20).map((t, i) => (
                <Badge key={i} variant="secondary" className="text-[9px] py-0 px-1.5">{t.tag}</Badge>
              ))}
            </div>
          </div>
        )}

        {/* Entities */}
        {details && details.entities.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">Entities</div>
            <div className="flex flex-wrap gap-1">
              {details.entities.slice(0, 15).map((e, i) => (
                <Badge key={i} variant="outline" className="text-[9px] py-0 px-1.5" title={`${e.entity_type} (conf ${Math.round(e.confidence * 100)}%)`}>
                  <span className="text-muted-foreground/70 mr-1">{e.entity_type}:</span>
                  {e.entity_value.slice(0, 30)}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
            {node.type === 'humint' ? 'Findings' : node.type === 'gap' ? 'Description' : 'Content'}
          </div>
          <div className="text-xs whitespace-pre-wrap text-foreground/90 leading-relaxed max-h-[320px] overflow-auto pr-2">
            {loadingDetails && !node.snippet ? (
              <span className="text-muted-foreground italic">Loading…</span>
            ) : content}
          </div>
        </div>

        {/* HUMINT analyst notes */}
        {node.type === 'humint' && details?.humintAnalystNotes && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">Analyst Notes</div>
            <div className="text-xs whitespace-pre-wrap text-foreground/70 leading-relaxed max-h-[200px] overflow-auto pr-2 border-l-2 border-yellow-500/40 pl-2">
              {details.humintAnalystNotes}
            </div>
          </div>
        )}

        {/* HUMINT source citations */}
        {node.type === 'humint' && details?.humintSourceIds && details.humintSourceIds.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
              Cited Intel Sources ({details.humintSourceIds.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {details.humintSourceIds.slice(0, 20).map((sid, i) => {
                const linked = linkedItems.find((li) => li.node.id === sid)
                return (
                  <button
                    key={i}
                    onClick={() => { if (linked) onSelectNode(linked.node) }}
                    disabled={!linked}
                    className={cn(
                      'text-[9px] py-0.5 px-1.5 rounded border font-mono truncate max-w-[200px]',
                      linked
                        ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 cursor-pointer'
                        : 'border-border text-muted-foreground/60 cursor-default'
                    )}
                    title={linked?.node.title || sid}
                  >
                    {linked ? linked.node.title.slice(0, 32) : sid.slice(0, 16)}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Linked items */}
        {linkedItems.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
              Linked Items ({linkedItems.length})
            </div>
            <div className="space-y-1 max-h-72 overflow-auto">
              {linkedItems.map(({ node: other, link }, i) => (
                <button
                  key={i}
                  onClick={() => onSelectNode(other)}
                  className="w-full text-left p-2 rounded bg-accent/20 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: linkColors[link.type] || '#6b7280' }} />
                    <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/70 truncate">{link.type}</span>
                    <span className="text-[9px] text-muted-foreground/70 ml-auto shrink-0">{Math.round((link.strength || 0) * 100)}%</span>
                  </div>
                  <div className="text-[11px] font-medium truncate">{other.title}</div>
                  {link.reason && (
                    <div className="text-[9px] text-muted-foreground/70 truncate mt-0.5">{link.reason}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border">
          {details?.sourceUrl && (
            <Button size="sm" variant="outline" className="justify-start text-xs h-8"
              onClick={() => window.open(details.sourceUrl!, '_blank')}>
              <ExternalLink className="h-3 w-3 mr-1.5" />Open Source
            </Button>
          )}
          <Button size="sm" variant="outline" className="justify-start text-xs h-8"
            onClick={() => navigate('/feed')}>
            <FileText className="h-3 w-3 mr-1.5" />Open in Feed
          </Button>
          <Button size="sm" variant="ghost" className="justify-start text-xs h-8"
            onClick={() => { navigator.clipboard.writeText(node.id); toast.success('ID copied') }}>
            <Copy className="h-3 w-3 mr-1.5" />Copy ID
          </Button>
        </div>
      </div>
    </div>
  )
}

export function clearNodeDetailCache(): void {
  CACHE.clear()
}
