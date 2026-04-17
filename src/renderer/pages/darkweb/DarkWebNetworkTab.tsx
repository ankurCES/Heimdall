import { useEffect, useState, useCallback, useRef } from 'react'
import { Network, RefreshCw, Loader2, AlertTriangle, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'

/**
 * Dark-web network graph — force-directed visualisation of onion_crossref
 * links between [DARKWEB] reports. Nodes are color-coded by threat score,
 * sized by link count, and labelled with truncated hostnames.
 *
 * Uses a pure-canvas renderer (no d3/vis.js dependency) with a simple
 * force simulation: repulsion between all nodes + spring attraction on
 * edges + gravity toward center. Interactive: drag nodes, hover for
 * detail tooltip, click for side-panel.
 */

interface GraphNode {
  id: string
  label: string
  title: string
  sourceUrl: string | null
  severity: string
  threatScore: number | null
  threatLabel: string | null
  actors: string[]
  activities: string[]
  crawlDepth: number | null
  createdAt: number
  // Simulation state (mutable)
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null // pinned position
  fy: number | null
}

interface GraphEdge {
  id: string
  source: string
  target: string
  strength: number
  reason: string | null
  createdAt: number
}

function threatColor(score: number | null): string {
  if (score === null) return '#64748b' // slate
  if (score >= 9) return '#ef4444'     // red (critical)
  if (score >= 7) return '#f97316'     // orange (high)
  if (score >= 4) return '#eab308'     // yellow (medium)
  return '#22c55e'                      // green (low)
}

function threatBgClass(score: number | null): string {
  if (score === null) return 'bg-slate-500/20 text-slate-300 border-slate-500/40'
  if (score >= 9) return 'bg-red-500/20 text-red-300 border-red-500/40'
  if (score >= 7) return 'bg-orange-500/20 text-orange-300 border-orange-500/40'
  if (score >= 4) return 'bg-amber-500/20 text-amber-300 border-amber-500/40'
  return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
}

function nodeRadius(edgeCount: number): number {
  return Math.max(6, Math.min(20, 6 + edgeCount * 2))
}

export function DarkWebNetworkTab() {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [hovered, setHovered] = useState<GraphNode | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<number>(0)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ nodeId: string | null; startX: number; startY: number; panning: boolean }>({ nodeId: null, startX: 0, startY: 0, panning: false })

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await invoke('darkweb:graph_data') as { nodes: Omit<GraphNode, 'x' | 'y' | 'vx' | 'vy' | 'fx' | 'fy'>[]; edges: GraphEdge[] }
      // Initialize simulation positions randomly in center area.
      const w = containerRef.current?.clientWidth || 800
      const h = containerRef.current?.clientHeight || 600
      const cx = w / 2, cy = h / 2
      const simNodes: GraphNode[] = data.nodes.map((n, i) => ({
        ...n,
        x: cx + (Math.random() - 0.5) * Math.min(w, 600),
        y: cy + (Math.random() - 0.5) * Math.min(h, 400),
        vx: 0, vy: 0, fx: null, fy: null
      }))
      setNodes(simNodes)
      setEdges(data.edges)
    } finally { setLoading(false) }
  }, [invoke])

  useEffect(() => { void load() }, [load])

  // Edge count per node for sizing.
  const edgeCounts = new Map<string, number>()
  for (const e of edges) {
    edgeCounts.set(e.source, (edgeCounts.get(e.source) || 0) + 1)
    edgeCounts.set(e.target, (edgeCounts.get(e.target) || 0) + 1)
  }

  // Node lookup for edge rendering.
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // ── Force simulation ─────────────────────────────────────────────────
  useEffect(() => {
    if (nodes.length === 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let running = true
    const REPULSION = 3000
    const SPRING_K = 0.005
    const SPRING_REST = 120
    const GRAVITY = 0.01
    const DAMPING = 0.85
    const DT = 1

    const tick = () => {
      if (!running) return
      const w = canvas.width
      const h = canvas.height
      const cx = w / 2, cy = h / 2

      // Forces
      for (const n of nodes) {
        if (n.fx !== null) { n.x = n.fx; n.y = n.fy!; n.vx = 0; n.vy = 0; continue }
        let fx = 0, fy = 0

        // Repulsion from all other nodes
        for (const m of nodes) {
          if (m.id === n.id) continue
          const dx = n.x - m.x
          const dy = n.y - m.y
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
          const force = REPULSION / (dist * dist)
          fx += (dx / dist) * force
          fy += (dy / dist) * force
        }

        // Gravity toward center
        fx += (cx - n.x) * GRAVITY
        fy += (cy - n.y) * GRAVITY

        n.vx = (n.vx + fx * DT) * DAMPING
        n.vy = (n.vy + fy * DT) * DAMPING
        n.x += n.vx * DT
        n.y += n.vy * DT
      }

      // Spring (edge) forces
      for (const e of edges) {
        const source = nodeMap.get(e.source)
        const target = nodeMap.get(e.target)
        if (!source || !target) continue
        const dx = target.x - source.x
        const dy = target.y - source.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
        const displacement = dist - SPRING_REST
        const force = SPRING_K * displacement
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        if (source.fx === null) { source.vx += fx; source.vy += fy }
        if (target.fx === null) { target.vx -= fx; target.vy -= fy }
      }

      // Draw
      ctx.clearRect(0, 0, w, h)
      ctx.save()
      ctx.translate(pan.x, pan.y)
      ctx.scale(zoom, zoom)

      // Edges
      ctx.lineWidth = 1
      for (const e of edges) {
        const s = nodeMap.get(e.source)
        const t = nodeMap.get(e.target)
        if (!s || !t) continue
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)'
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(t.x, t.y)
        ctx.stroke()
      }

      // Nodes
      for (const n of nodes) {
        const r = nodeRadius(edgeCounts.get(n.id) || 0)
        const color = threatColor(n.threatScore)
        const isSelected = selected?.id === n.id
        const isHovered = hovered?.id === n.id

        // Glow for high threat
        if (n.threatScore && n.threatScore >= 7) {
          ctx.shadowColor = color
          ctx.shadowBlur = 12
        }

        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0

        // Border for selected/hovered
        if (isSelected || isHovered) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.stroke()
        }

        // Label
        ctx.fillStyle = 'rgba(226, 232, 240, 0.9)'
        ctx.font = '9px monospace'
        ctx.textAlign = 'center'
        const label = n.label.length > 16 ? n.label.slice(0, 14) + '…' : n.label
        ctx.fillText(label, n.x, n.y + r + 12)

        // Threat score badge
        if (n.threatScore !== null && n.threatScore >= 7) {
          ctx.fillStyle = color
          ctx.font = 'bold 8px sans-serif'
          ctx.fillText(`${n.threatScore}/10`, n.x, n.y - r - 4)
        }
      }

      ctx.restore()
      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)
    return () => { running = false; cancelAnimationFrame(animRef.current) }
  }, [nodes, edges, zoom, pan, selected, hovered])

  // Resize canvas to container
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // Mouse interaction
  const getNodeAt = (mx: number, my: number): GraphNode | null => {
    const x = (mx - pan.x) / zoom
    const y = (my - pan.y) / zoom
    for (const n of nodes) {
      const r = nodeRadius(edgeCounts.get(n.id) || 0)
      const dx = x - n.x, dy = y - n.y
      if (dx * dx + dy * dy < (r + 4) * (r + 4)) return n
    }
    return null
  }

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const node = getNodeAt(mx, my)
    if (node) {
      dragRef.current = { nodeId: node.id, startX: mx, startY: my, panning: false }
      node.fx = node.x; node.fy = node.y
    } else {
      dragRef.current = { nodeId: null, startX: mx, startY: my, panning: true }
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left, my = e.clientY - rect.top

    if (dragRef.current.nodeId) {
      const node = nodeMap.get(dragRef.current.nodeId)
      if (node) {
        node.fx = (mx - pan.x) / zoom
        node.fy = (my - pan.y) / zoom
        node.x = node.fx
        node.y = node.fy
      }
    } else if (dragRef.current.panning) {
      const dx = mx - dragRef.current.startX
      const dy = my - dragRef.current.startY
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }))
      dragRef.current.startX = mx
      dragRef.current.startY = my
    } else {
      setHovered(getNodeAt(mx, my))
    }
  }

  const onMouseUp = () => {
    if (dragRef.current.nodeId) {
      const node = nodeMap.get(dragRef.current.nodeId)
      if (node) { node.fx = null; node.fy = null }
      setSelected(node || null)
    }
    dragRef.current = { nodeId: null, startX: 0, startY: 0, panning: false }
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom((z) => Math.max(0.2, Math.min(5, z * delta)))
  }

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  const highThreatCount = nodes.filter((n) => n.threatScore !== null && n.threatScore >= 7).length

  return (
    <div className="flex h-full overflow-hidden">
      {/* Graph canvas */}
      <div ref={containerRef} className="flex-1 relative bg-background/50">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <Loader2 className="h-6 w-6 animate-spin text-fuchsia-400 mr-2" /> Loading graph…
          </div>
        )}
        {!loading && nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
            <Network className="h-10 w-10 opacity-30 mb-2" />
            <p className="text-sm">No onion crossref links yet</p>
            <p className="text-[10px] mt-1">Run a seed sweep or Refresh All to discover linked onion pages.</p>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-crosshair"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
        />
        {/* Controls overlay */}
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] gap-1">
            <Network className="h-3 w-3" /> {nodes.length} nodes · {edges.length} edges
          </Badge>
          {highThreatCount > 0 && (
            <Badge className="text-[10px] bg-orange-500/20 text-orange-300 border border-orange-500/40 gap-1">
              <AlertTriangle className="h-3 w-3" /> {highThreatCount} high-threat
            </Badge>
          )}
        </div>
        <div className="absolute top-3 right-3 flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(5, z * 1.2))} title="Zoom in">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.2, z * 0.8))} title="Zoom out">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={resetView} title="Reset view">
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} title="Reload data">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {/* Legend */}
        <div className="absolute bottom-3 left-3 flex items-center gap-3 text-[9px] text-muted-foreground bg-card/80 backdrop-blur px-2 py-1 rounded border border-border">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Low (1-3)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> Medium (4-6)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500 inline-block" /> High (7-8)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Critical (9-10)</span>
          <span>· Node size = link count</span>
        </div>
        {/* Hover tooltip */}
        {hovered && !selected && (
          <div className="absolute bottom-12 left-3 bg-card border border-border rounded-lg p-2 shadow-lg max-w-xs text-xs z-20">
            <div className="font-mono text-[10px] truncate">{hovered.label}</div>
            {hovered.threatScore !== null && (
              <Badge className={cn('text-[9px] mt-1 border', threatBgClass(hovered.threatScore))}>
                Threat: {hovered.threatScore}/10 ({hovered.threatLabel})
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Detail panel (shown when a node is selected) */}
      {selected && (
        <div className="w-72 border-l border-border bg-card/50 overflow-auto p-3 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold truncate">{selected.label}</h3>
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground text-xs">✕</button>
          </div>

          {selected.threatScore !== null && (
            <div className={cn('rounded border p-2 text-center', threatBgClass(selected.threatScore))}>
              <div className="text-2xl font-bold">{selected.threatScore}/10</div>
              <div className="text-[10px] uppercase tracking-wider">{selected.threatLabel} threat</div>
            </div>
          )}

          <div className="space-y-1.5 text-[11px]">
            <div><span className="text-muted-foreground">Severity:</span> <Badge variant="outline" className="text-[10px]">{selected.severity}</Badge></div>
            <div><span className="text-muted-foreground">Crawl depth:</span> {selected.crawlDepth ?? 'root'}</div>
            <div><span className="text-muted-foreground">Links:</span> {edgeCounts.get(selected.id) || 0} connections</div>
            <div><span className="text-muted-foreground">Fetched:</span> {formatRelativeTime(selected.createdAt)}</div>

            {selected.sourceUrl && (
              <div className="font-mono text-[10px] text-muted-foreground break-all mt-2">
                {selected.sourceUrl}
              </div>
            )}

            {selected.actors.length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Threat actors</div>
                <div className="flex flex-wrap gap-1">
                  {selected.actors.map((a) => (
                    <Badge key={a} className="text-[9px] bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40">{a}</Badge>
                  ))}
                </div>
              </div>
            )}

            {selected.activities.length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Activities</div>
                <div className="flex flex-wrap gap-1">
                  {selected.activities.map((a) => (
                    <Badge key={a} variant="outline" className="text-[9px]">{a}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Connected nodes */}
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Connected nodes</div>
              <div className="space-y-1">
                {edges
                  .filter((e) => e.source === selected.id || e.target === selected.id)
                  .slice(0, 10)
                  .map((e) => {
                    const otherId = e.source === selected.id ? e.target : e.source
                    const other = nodeMap.get(otherId)
                    if (!other) return null
                    return (
                      <button
                        key={e.id}
                        onClick={() => setSelected(other)}
                        className="w-full text-left px-2 py-1 rounded hover:bg-accent/50 transition-colors flex items-center gap-2"
                      >
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: threatColor(other.threatScore) }} />
                        <span className="text-[10px] font-mono truncate flex-1">{other.label}</span>
                        {other.threatScore !== null && (
                          <span className="text-[9px] text-muted-foreground">{other.threatScore}/10</span>
                        )}
                      </button>
                    )
                  })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
