import { useEffect, useRef, useState, useCallback } from 'react'
import { Network, Loader2, RefreshCw, X, Maximize2 } from 'lucide-react'
import { Card } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'

/**
 * Memory Graph — visualizes the analytic memory graph (reports / sources /
 * indicators / claims / outcomes / cases / threat-feed entities) as a
 * force-directed layout. Click any node for a side-panel drilldown.
 *
 * Implementation note: rather than pulling in a heavy chart library we
 * use a simple HTML5 Canvas force-direction simulation. Sufficient for
 * the typical agency volume (<1000 nodes per snapshot).
 */

interface GraphNode {
  id: string
  type: 'report' | 'source' | 'indicator' | 'claim' | 'outcome' | 'case' | 'actor' | 'malware' | 'cve'
  label: string
  metadata: Record<string, unknown>
  // Simulation state
  x?: number; y?: number; vx?: number; vy?: number
}

interface GraphEdge { source: string; target: string; relation: string; weight: number }

interface Snapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: {
    nodeCount: number; edgeCount: number; nodesByType: Record<string, number>
    communities: number; builtAt: number; durationMs: number
  }
}

const NODE_COLORS: Record<string, string> = {
  report: '#06b6d4',     // cyan
  source: '#3b82f6',     // blue
  indicator: '#22c55e',  // emerald
  claim: '#f59e0b',      // amber
  outcome: '#a855f7',    // purple
  case: '#ec4899',       // pink
  actor: '#ef4444',      // red
  malware: '#fb923c',    // orange
  cve: '#eab308'         // yellow
}

export function MemoryGraphPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number>(0)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null)
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())

  const load = useCallback(async (rebuild: boolean = false) => {
    setLoading(true)
    try {
      const r = await window.heimdall.invoke('memgraph:snapshot', { rebuild }) as
        { ok: boolean; snapshot?: Snapshot }
      if (r.ok && r.snapshot) {
        // Initialize positions
        const positioned = {
          ...r.snapshot,
          nodes: r.snapshot.nodes.map((n) => ({
            ...n, x: Math.random() * 800, y: Math.random() * 600,
            vx: 0, vy: 0
          }))
        }
        setSnapshot(positioned)
      } else {
        toast.error('Failed to load memory graph')
      }
    } catch (err) { toast.error(String(err)) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Force-direction simulation + render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !snapshot) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const visibleNodes = snapshot.nodes.filter((n) => !hiddenTypes.has(n.type))
    const visibleNodeIds = new Set(visibleNodes.map((n) => n.id))
    const visibleEdges = snapshot.edges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target))
    const nodeMap = new Map<string, GraphNode>(visibleNodes.map((n) => [n.id, n]))

    // Simulation parameters
    const REPULSION = 800
    const ATTRACTION = 0.02
    const DAMPING = 0.85
    const CENTER_PULL = 0.001

    let frame = 0
    const tick = (): void => {
      frame++
      const W = canvas.width
      const H = canvas.height

      // Apply forces
      for (const n of visibleNodes) {
        n.vx = n.vx ?? 0; n.vy = n.vy ?? 0
        // Repulsion between nodes
        for (const m of visibleNodes) {
          if (n === m) continue
          const dx = (n.x ?? 0) - (m.x ?? 0)
          const dy = (n.y ?? 0) - (m.y ?? 0)
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const force = REPULSION / (dist * dist)
          n.vx += (dx / dist) * force * 0.01
          n.vy += (dy / dist) * force * 0.01
        }
        // Center gravity
        n.vx += (W / 2 - (n.x ?? 0)) * CENTER_PULL
        n.vy += (H / 2 - (n.y ?? 0)) * CENTER_PULL
      }
      // Attraction along edges
      for (const e of visibleEdges) {
        const s = nodeMap.get(e.source)
        const t = nodeMap.get(e.target)
        if (!s || !t) continue
        const dx = (t.x ?? 0) - (s.x ?? 0)
        const dy = (t.y ?? 0) - (s.y ?? 0)
        s.vx = (s.vx ?? 0) + dx * ATTRACTION * Math.min(1, e.weight / 3)
        s.vy = (s.vy ?? 0) + dy * ATTRACTION * Math.min(1, e.weight / 3)
        t.vx = (t.vx ?? 0) - dx * ATTRACTION * Math.min(1, e.weight / 3)
        t.vy = (t.vy ?? 0) - dy * ATTRACTION * Math.min(1, e.weight / 3)
      }
      // Update positions with damping + clamp to canvas
      for (const n of visibleNodes) {
        n.vx = (n.vx ?? 0) * DAMPING
        n.vy = (n.vy ?? 0) * DAMPING
        n.x = Math.max(20, Math.min(W - 20, (n.x ?? 0) + (n.vx ?? 0)))
        n.y = Math.max(20, Math.min(H - 20, (n.y ?? 0) + (n.vy ?? 0)))
      }

      // Render
      ctx.fillStyle = '#06080d'
      ctx.fillRect(0, 0, W, H)

      // Edges
      ctx.lineWidth = 0.6
      for (const e of visibleEdges) {
        const s = nodeMap.get(e.source); const t = nodeMap.get(e.target)
        if (!s || !t) continue
        ctx.strokeStyle = `rgba(255,255,255,${0.08 + e.weight * 0.05})`
        ctx.beginPath()
        ctx.moveTo(s.x ?? 0, s.y ?? 0)
        ctx.lineTo(t.x ?? 0, t.y ?? 0)
        ctx.stroke()
      }

      // Nodes
      for (const n of visibleNodes) {
        const isSelected = selectedNode?.id === n.id
        const isHovered = hoveredNode?.id === n.id
        const baseRadius = 4 + Math.log10(((n.metadata.centrality as number) || 0) * 100 + 1) * 2
        const radius = isSelected ? baseRadius + 4 : isHovered ? baseRadius + 2 : baseRadius
        ctx.fillStyle = NODE_COLORS[n.type] || '#888'
        ctx.beginPath()
        ctx.arc(n.x ?? 0, n.y ?? 0, radius, 0, Math.PI * 2)
        ctx.fill()
        if (isSelected || isHovered) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.stroke()
        }
        // Label only for hovered/selected/large
        if (isHovered || isSelected || baseRadius > 6) {
          ctx.fillStyle = '#cbd5e1'
          ctx.font = '10px sans-serif'
          ctx.fillText(n.label.slice(0, 30), (n.x ?? 0) + radius + 4, (n.y ?? 0) + 4)
        }
      }

      // Continue animating for 600 frames (~10s @ 60fps)
      if (frame < 600) {
        animationRef.current = requestAnimationFrame(tick)
      }
    }

    animationRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationRef.current)
  }, [snapshot, hiddenTypes, selectedNode, hoveredNode])

  // Mouse interaction
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!snapshot) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const visibleNodes = snapshot.nodes.filter((n) => !hiddenTypes.has(n.type))
    let closest: GraphNode | null = null
    let closestDist = 15
    for (const n of visibleNodes) {
      const dx = (n.x ?? 0) - x; const dy = (n.y ?? 0) - y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < closestDist) { closestDist = d; closest = n }
    }
    setSelectedNode(closest)
  }

  const handleMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!snapshot) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const visibleNodes = snapshot.nodes.filter((n) => !hiddenTypes.has(n.type))
    let closest: GraphNode | null = null
    let closestDist = 15
    for (const n of visibleNodes) {
      const dx = (n.x ?? 0) - x; const dy = (n.y ?? 0) - y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < closestDist) { closestDist = d; closest = n }
    }
    setHoveredNode(closest)
  }

  const toggleType = (type: string): void => {
    const next = new Set(hiddenTypes)
    if (next.has(type)) next.delete(type)
    else next.add(type)
    setHiddenTypes(next)
  }

  return (
    <div className="flex h-full">
      <div className={`${selectedNode ? 'flex-1' : 'w-full'} flex flex-col`}>
        <div className="border-b border-border px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Network className="w-6 h-6 text-cyan-400" />
            <div>
              <h1 className="text-lg font-semibold">Analytic Memory Graph</h1>
              <p className="text-[10px] text-muted-foreground">
                Reports · sources · indicators · claims · outcomes · cases · threat-feed entities — as a single queryable graph.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {snapshot && (
              <span className="text-[10px] text-muted-foreground font-mono">
                {snapshot.stats.nodeCount} nodes · {snapshot.stats.edgeCount} edges · {snapshot.stats.communities} communities
              </span>
            )}
            <Button onClick={() => load(true)} disabled={loading} size="sm" variant="outline">
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Rebuild
            </Button>
          </div>
        </div>

        {/* Type legend / filters */}
        {snapshot && (
          <div className="border-b border-border px-6 py-2 flex items-center gap-2 flex-wrap text-xs">
            <span className="text-muted-foreground">Types:</span>
            {Object.entries(snapshot.stats.nodesByType).map(([type, count]) => (
              <button key={type} onClick={() => toggleType(type)}
                className={`text-[10px] px-2 py-0.5 rounded border flex items-center gap-1.5 transition-opacity ${
                  hiddenTypes.has(type) ? 'opacity-30 line-through' : ''
                }`}
                style={{ borderColor: NODE_COLORS[type] || '#888' }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: NODE_COLORS[type] || '#888' }} />
                {type} ({count})
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 relative bg-[#06080d]">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && (!snapshot || snapshot.nodes.length === 0) && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Network className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">Memory graph is empty.</p>
                <p className="text-xs mt-2 opacity-70">Publish reports + record outcomes to populate the graph.</p>
              </div>
            </div>
          )}
          <canvas
            ref={canvasRef}
            width={1200}
            height={800}
            onClick={handleClick}
            onMouseMove={handleMove}
            className="w-full h-full cursor-pointer"
          />
        </div>
      </div>

      {selectedNode && (
        <div className="w-80 border-l border-border flex flex-col">
          <div className="border-b border-border px-4 py-3 flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <Badge variant="outline" className="text-[9px] capitalize mb-1" style={{ borderColor: NODE_COLORS[selectedNode.type], color: NODE_COLORS[selectedNode.type] }}>
                {selectedNode.type}
              </Badge>
              <h3 className="font-semibold text-sm break-words">{selectedNode.label}</h3>
              <p className="text-[10px] text-muted-foreground font-mono break-all mt-1">{selectedNode.id}</p>
            </div>
            <button onClick={() => setSelectedNode(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase mb-1">Metadata</div>
              <div className="space-y-1">
                {Object.entries(selectedNode.metadata).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <span className="text-muted-foreground">{k}:</span> <span className="font-mono">{String(v).slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            </div>
            {snapshot && (
              <Card className="p-3">
                <div className="text-[10px] text-muted-foreground uppercase mb-2">Connected nodes</div>
                <div className="space-y-1">
                  {snapshot.edges
                    .filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
                    .slice(0, 20)
                    .map((e, i) => {
                      const otherId = e.source === selectedNode.id ? e.target : e.source
                      const other = snapshot.nodes.find((n) => n.id === otherId)
                      if (!other) return null
                      return (
                        <button key={i} onClick={() => setSelectedNode(other)}
                          className="w-full text-left text-xs flex items-center gap-2 px-2 py-1 rounded hover:bg-accent">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: NODE_COLORS[other.type] }} />
                          <span className="truncate flex-1">{other.label}</span>
                          <span className="text-[9px] text-muted-foreground italic">{e.relation}</span>
                        </button>
                      )
                    })}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
