import { useState, useEffect, useCallback, useRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import {
  Network, RefreshCw, Loader2, Filter, X, ChevronRight
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Label } from '@renderer/components/ui/label'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import { cn } from '@renderer/lib/utils'

interface GraphNode {
  id: string
  title: string
  discipline: string
  severity: string
  source: string
  verification: number
}

interface GraphLink {
  source: string
  target: string
  type: string
  strength: number
  reason: string
}

const DISCIPLINE_COLORS: Record<string, string> = {
  osint: '#3b82f6', cybint: '#ef4444', finint: '#10b981', socmint: '#8b5cf6',
  geoint: '#f59e0b', sigint: '#06b6d4', rumint: '#f97316', ci: '#ec4899',
  agency: '#6366f1', imint: '#14b8a6',
  preliminary: '#a78bfa', gap: '#fb923c', humint: '#fbbf24'
}

const SEVERITY_SIZE: Record<string, number> = {
  critical: 8, high: 6, medium: 5, low: 4, info: 3
}

const LINK_COLORS: Record<string, string> = {
  shared_entity: '#3b82f6',
  temporal: '#6b7280',
  preliminary_reference: '#a78bfa',
  gap_identified: '#fb923c',
  humint_source: '#fbbf24',
  humint_preliminary: '#f59e0b',
  humint_cross_session: '#eab308'
}

export function RelationshipGraph() {
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] })
  const [loading, setLoading] = useState(true)
  const [filterDiscipline, setFilterDiscipline] = useState('all')
  const [filterLinkType, setFilterLinkType] = useState('all')
  const [nodeLimit, setNodeLimit] = useState('200')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [selectedNodeLinks, setSelectedNodeLinks] = useState<Array<{ node: GraphNode; link: GraphLink }>>([])
  const graphRef = useRef<any>(null)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadGraph = async () => {
    setLoading(true)
    try {
      const result = await invoke('enrichment:getGraph', {
        discipline: filterDiscipline !== 'all' ? filterDiscipline : undefined,
        linkType: filterLinkType !== 'all' ? filterLinkType : undefined,
        limit: parseInt(nodeLimit)
      }) as { nodes: GraphNode[]; links: GraphLink[] }

      setGraphData(result || { nodes: [], links: [] })
    } catch (err) {
      console.error('Graph load failed:', err)
    }
    setLoading(false)
  }

  useEffect(() => { loadGraph() }, [filterDiscipline, filterLinkType, nodeLimit])

  const handleNodeClick = (node: any) => {
    const n = node as GraphNode
    setSelectedNode(n)

    // Find all linked nodes
    const linked = graphData.links
      .filter((l) => l.source === n.id || (l.source as any)?.id === n.id || l.target === n.id || (l.target as any)?.id === n.id)
      .map((l) => {
        const otherId = ((l.source as any)?.id || l.source) === n.id
          ? ((l.target as any)?.id || l.target)
          : ((l.source as any)?.id || l.source)
        const otherNode = graphData.nodes.find((nn) => nn.id === otherId)
        return otherNode ? { node: otherNode, link: l } : null
      })
      .filter(Boolean) as Array<{ node: GraphNode; link: GraphLink }>

    setSelectedNodeLinks(linked)

    // Center on node
    if (graphRef.current) {
      graphRef.current.centerAt(node.x, node.y, 500)
      graphRef.current.zoom(3, 500)
    }
  }

  return (
    <div className="flex h-full">
      {/* Controls */}
      <div className="w-64 shrink-0 border-r border-border bg-card/50 p-4 space-y-4 overflow-auto">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-primary" />
          <span className="text-sm font-bold">Relationship Graph</span>
        </div>

        <div className="text-xs text-muted-foreground">
          {graphData.nodes.length} nodes, {graphData.links.length} links
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Discipline</Label>
          <Select value={filterDiscipline} onValueChange={setFilterDiscipline}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Disciplines</SelectItem>
              {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Link Type</Label>
          <Select value={filterLinkType} onValueChange={setFilterLinkType}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="shared_entity">Shared Entity</SelectItem>
              <SelectItem value="temporal">Temporal</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Max Links</Label>
          <Select value={nodeLimit} onValueChange={setNodeLimit}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="200">200</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" size="sm" className="w-full" onClick={loadGraph} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Refresh
        </Button>

        {/* Legend */}
        <div className="space-y-1 pt-2 border-t border-border">
          <Label className="text-xs text-muted-foreground">Node Colors</Label>
          {Object.entries(DISCIPLINE_COLORS).map(([disc, color]) => (
            <div key={disc} className="flex items-center gap-2 text-[10px]">
              <span className={`h-2.5 w-2.5 ${disc === 'preliminary' ? 'rotate-45' : disc === 'gap' ? '' : 'rounded-full'}`}
                style={{ background: color, clipPath: disc === 'gap' ? 'polygon(50% 0%, 100% 100%, 0% 100%)' : undefined }} />
              {disc === 'preliminary' ? '📋 Preliminary Report' : disc === 'gap' ? '⚠️ Information Gap' : (DISCIPLINE_LABELS[disc as keyof typeof DISCIPLINE_LABELS] || disc)}
            </div>
          ))}
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Link Colors</Label>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="h-0.5 w-4" style={{ background: LINK_COLORS.shared_entity }} />Shared Entity
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="h-0.5 w-4" style={{ background: LINK_COLORS.temporal }} />Temporal
          </div>
        </div>
      </div>

      {/* Graph */}
      <div className="flex-1 relative" style={{ background: '#0a0f1a' }}>
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : graphData.nodes.length > 0 ? (
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            nodeColor={(node: any) => DISCIPLINE_COLORS[node.discipline] || '#6b7280'}
            nodeVal={(node: any) => SEVERITY_SIZE[node.severity] || 3}
            nodeLabel={(node: any) => `${node.title}\n${(node.discipline || '').toUpperCase()} | ${(node.severity || '').toUpperCase()}`}
            linkColor={(link: any) => LINK_COLORS[link.type] || '#334155'}
            linkWidth={(link: any) => Math.max(0.5, (link.strength || 0.3) * 2)}
            linkDirectionalParticles={1}
            linkDirectionalParticleWidth={1.5}
            onNodeClick={handleNodeClick}
            backgroundColor="#0a0f1a"
            nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
              const size = (SEVERITY_SIZE[node.severity] || 3) * 1.5
              const color = DISCIPLINE_COLORS[node.discipline] || '#6b7280'
              const isSelected = selectedNode?.id === node.id

              // Glow effect
              ctx.shadowColor = color
              ctx.shadowBlur = isSelected ? 15 : 8

              // Draw shape based on type
              ctx.beginPath()
              if (node.type === 'preliminary') {
                // Diamond shape for preliminary reports
                ctx.moveTo(node.x, node.y - size * 1.3)
                ctx.lineTo(node.x + size, node.y)
                ctx.lineTo(node.x, node.y + size * 1.3)
                ctx.lineTo(node.x - size, node.y)
                ctx.closePath()
              } else if (node.type === 'humint') {
                // Hexagon shape for HUMINT
                for (let a = 0; a < 6; a++) {
                  const angle = (Math.PI / 3) * a - Math.PI / 6
                  const px = node.x + size * 1.2 * Math.cos(angle)
                  const py = node.y + size * 1.2 * Math.sin(angle)
                  if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
                }
                ctx.closePath()
              } else if (node.type === 'gap') {
                // Triangle shape for gaps
                ctx.moveTo(node.x, node.y - size * 1.2)
                ctx.lineTo(node.x + size, node.y + size * 0.8)
                ctx.lineTo(node.x - size, node.y + size * 0.8)
                ctx.closePath()
              } else {
                // Circle for regular intel
                ctx.arc(node.x, node.y, size, 0, 2 * Math.PI)
              }
              ctx.fillStyle = color
              ctx.fill()

              // Border
              ctx.shadowBlur = 0
              ctx.strokeStyle = isSelected ? '#ffffff' : color
              ctx.lineWidth = isSelected ? 2.5 : 1
              ctx.stroke()

              // Draw label if zoomed in
              if (globalScale > 1.5) {
                ctx.font = `${Math.max(3, 11 / globalScale)}px sans-serif`
                ctx.fillStyle = '#e2e8f0'
                ctx.textAlign = 'center'
                ctx.fillText(node.title?.slice(0, 30) || '', node.x, node.y + size + 6)
                // Discipline label
                ctx.font = `${Math.max(2, 8 / globalScale)}px sans-serif`
                ctx.fillStyle = '#64748b'
                ctx.fillText((node.discipline || '').toUpperCase(), node.x, node.y + size + 12)
              }
            }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Network className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">No relationship data</p>
          </div>
        )}
      </div>

      {/* Selected node detail */}
      {selectedNode && (
        <div className="w-72 border-l border-border bg-card/50 p-4 overflow-auto">
          <div className="flex items-center justify-between mb-3">
            <Badge variant="outline" className="text-xs">{selectedNode.discipline?.toUpperCase()}</Badge>
            <button onClick={() => { setSelectedNode(null); setSelectedNodeLinks([]) }} className="text-xs text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <h3 className="text-sm font-semibold mb-2">{selectedNode.title}</h3>

          <div className="text-xs space-y-1 text-muted-foreground mb-4">
            <div>Source: {selectedNode.source}</div>
            <div>Severity: <span className={
              selectedNode.severity === 'critical' ? 'text-red-500' :
              selectedNode.severity === 'high' ? 'text-orange-500' : 'text-foreground'
            }>{selectedNode.severity?.toUpperCase()}</span></div>
            <div>Verification: {selectedNode.verification}/100</div>
          </div>

          <div className="border-t border-border pt-3">
            <h4 className="text-xs font-semibold mb-2">Linked Items ({selectedNodeLinks.length})</h4>
            <div className="space-y-1.5 max-h-60 overflow-auto">
              {selectedNodeLinks.map(({ node, link }, i) => (
                <div key={i} className="text-[10px] p-1.5 rounded bg-accent/30 cursor-pointer hover:bg-accent"
                  onClick={() => handleNodeClick(node)}>
                  <div className="font-medium truncate">{node.title}</div>
                  <div className="flex items-center gap-1 mt-0.5 text-muted-foreground">
                    <Badge variant="outline" className="text-[8px] py-0 px-1">{link.type}</Badge>
                    <span>{link.reason?.slice(0, 40)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
