// GraphCanvasPage — v1.8.0 Phase 9 cross-entity link analysis.
//
// Maltego-style canvas: seed N entities, expand neighbours via
// co-mentions, prune what doesn't matter, save canvases for later
// resumption. Built on react-force-graph-2d (already a dep).
//
// Layout:
//   - Left rail: list of saved canvases + "New from entity…"
//     creator. Selecting a canvas loads it; clicking new prompts
//     for a name and a canonical id.
//   - Center: ForceGraph2D canvas. Nodes coloured by entity_type,
//     sized by mention_count. Click a node to expand it (pulls
//     top co-mentions and merges them in). Right-click pins the
//     node so subsequent expansions don't overwrite its position.
//   - Right rail: selected node detail (title, type, count) +
//     buttons (expand, pin, navigate to /entity/:id, remove from
//     canvas).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ForceGraph2D from 'react-force-graph-2d'
import {
  GitMerge, Plus, Loader2, RefreshCw, Trash2, Save, AlertCircle,
  Network, Sparkles, ArrowRight, X as XIcon, Pin, PinOff
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { promptDialog } from '@renderer/components/PromptDialog'

interface GraphNode {
  id: string
  label: string
  entity_type: string
  mention_count: number
  pinned?: boolean
  added_at: number
  // ForceGraph runtime fields injected by the simulation
  x?: number; y?: number; fx?: number | null; fy?: number | null
}
interface GraphEdge {
  source: string | GraphNode
  target: string | GraphNode
  shared_reports: number
  co_mention_count: number
  last_co_mentioned_at: number
}
interface CanvasMeta {
  id: string
  name: string
  description: string | null
  created_at: number
  updated_at: number
  node_count: number
  edge_count: number
}
interface Canvas {
  id: string
  name: string
  description: string | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  layout_json: string | null
  created_at: number
  updated_at: number
}

// Per-entity-type colours. Leaves any unknown type at the muted grey.
const TYPE_COLORS: Record<string, string> = {
  person:        '#a78bfa',
  organization:  '#22d3ee',
  org:           '#22d3ee',
  location:      '#34d399',
  geo:           '#34d399',
  threat_actor:  '#ef4444',
  apt:           '#ef4444',
  domain:        '#fbbf24',
  ipv4:          '#fbbf24',
  ip:            '#fbbf24',
  hash:          '#f97316',
  cve:           '#fb7185',
  malware:       '#f43f5e'
}
const DEFAULT_COLOR = '#94a3b8'
const colorForType = (t: string): string => TYPE_COLORS[t.toLowerCase()] ?? DEFAULT_COLOR

export function GraphCanvasPage() {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const fgRef = useRef<{ d3ReheatSimulation: () => void; zoomToFit: (ms?: number, padding?: number) => void } | null>(null)
  const navigate = useNavigate()

  const loadList = useCallback(async () => {
    try {
      const list = await window.heimdall.invoke('graph:list') as CanvasMeta[]
      setCanvases(list)
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }, [])

  const loadCanvas = useCallback(async (id: string) => {
    setLoading(true); setError(null); setSelectedNodeId(null)
    try {
      const c = await window.heimdall.invoke('graph:get', id) as Canvas | null
      if (!c) { setError('Canvas not found'); setCanvas(null); return }
      setCanvas(c)
      setActiveId(c.id)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadList() }, [loadList])

  // Auto-fit the camera when a canvas first loads or grows substantially.
  useEffect(() => {
    if (!canvas || !fgRef.current) return
    const t = setTimeout(() => { try { fgRef.current?.zoomToFit(400, 60) } catch { /* */ } }, 200)
    return () => clearTimeout(t)
  }, [canvas?.id, canvas?.nodes.length])

  const createNew = async () => {
    const name = await promptDialog({
      label: 'Name this canvas',
      placeholder: 'e.g. FIN7 ecosystem',
      confirmLabel: 'Continue'
    })
    if (!name) return
    const canonicalId = await promptDialog({
      label: 'Seed canonical entity id',
      description: 'Paste from /entities or /entity/:id (the "copy id" chip on each timeline page).',
      placeholder: 'a1b2c3d4-…',
      confirmLabel: 'Create canvas',
      validate: (v) => v.trim().length < 8 ? 'Canonical id looks too short' : null
    })
    if (!canonicalId) return
    setBusy(true); setError(null)
    try {
      const c = await window.heimdall.invoke('graph:create_from_entity', {
        name: name.trim(),
        canonicalId: canonicalId.trim()
      }) as Canvas
      setCanvas(c)
      setActiveId(c.id)
      await loadList()
      toast.success('Canvas created', { description: `${c.nodes.length} node(s) seeded` })
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      toast.error('Create failed', { description: msg })
      setError(msg)
    } finally { setBusy(false) }
  }

  const expandNode = async (nodeId: string) => {
    if (!canvas) return
    setBusy(true)
    try {
      const r = await window.heimdall.invoke('graph:expand', {
        canvasId: canvas.id,
        canonicalId: nodeId
      }) as { added_nodes: GraphNode[]; added_edges: GraphEdge[]; closed_edges: GraphEdge[] }
      // Merge into local canvas state without a round-trip GET.
      const existingIds = new Set(canvas.nodes.map((n) => n.id))
      const mergedNodes = canvas.nodes.concat(r.added_nodes.filter((n) => !existingIds.has(n.id)))
      const mergedEdges = canvas.edges.concat(r.added_edges)
      setCanvas({ ...canvas, nodes: mergedNodes, edges: mergedEdges, updated_at: Date.now() })
      await loadList()
      if (r.added_nodes.length === 0 && r.added_edges.length === 0) {
        toast.message('Nothing new to add', { description: 'All co-mentions are already on the canvas.' })
      } else {
        toast.success(`Expanded`, {
          description: `+${r.added_nodes.length} node(s), +${r.added_edges.length} edge(s)${r.closed_edges.length ? `, ${r.closed_edges.length} closed triangles` : ''}`
        })
      }
      try { fgRef.current?.d3ReheatSimulation() } catch { /* */ }
    } catch (err) {
      toast.error('Expand failed', { description: String(err).replace(/^Error:\s*/, '') })
    } finally { setBusy(false) }
  }

  const removeNode = async (nodeId: string) => {
    if (!canvas) return
    if (canvas.nodes.length <= 1) {
      toast.message('Cannot remove the last node', { description: 'Delete the canvas instead.' })
      return
    }
    const nextNodes = canvas.nodes.filter((n) => n.id !== nodeId)
    const nextEdges = canvas.edges.filter((e) => {
      const s = typeof e.source === 'string' ? e.source : e.source.id
      const t = typeof e.target === 'string' ? e.target : e.target.id
      return s !== nodeId && t !== nodeId
    })
    try {
      const saved = await window.heimdall.invoke('graph:save', {
        id: canvas.id, nodes: nextNodes, edges: nextEdges
      }) as Canvas
      setCanvas(saved)
      setSelectedNodeId(null)
      await loadList()
    } catch (err) {
      toast.error('Remove failed', { description: String(err).replace(/^Error:\s*/, '') })
    }
  }

  const togglePin = (nodeId: string) => {
    if (!canvas) return
    const next = canvas.nodes.map((n) => n.id === nodeId ? { ...n, pinned: !n.pinned } : n)
    setCanvas({ ...canvas, nodes: next })
    // Force-reset fixed positions when unpinning so the simulation
    // takes over again.
    const target = next.find((n) => n.id === nodeId)
    if (target && !target.pinned) {
      target.fx = null
      target.fy = null
    }
    void window.heimdall.invoke('graph:save', { id: canvas.id, nodes: next })
  }

  const removeCanvas = async (id: string, name: string) => {
    if (!confirm(`Delete canvas "${name}"? This is irreversible.`)) return
    try {
      await window.heimdall.invoke('graph:delete', id)
      if (activeId === id) { setCanvas(null); setActiveId(null) }
      await loadList()
    } catch (err) { toast.error('Delete failed', { description: String(err) }) }
  }

  const selectedNode = useMemo(() => {
    if (!canvas || !selectedNodeId) return null
    return canvas.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [canvas, selectedNodeId])

  // ForceGraph wants plain string ids on edges (or matching node refs);
  // when we mutate nodes we need to make sure the simulation doesn't
  // hold stale references.
  const graphData = useMemo(() => {
    if (!canvas) return { nodes: [], links: [] }
    return {
      nodes: canvas.nodes.map((n) => ({ ...n })),
      links: canvas.edges.map((e) => ({
        source: typeof e.source === 'string' ? e.source : e.source.id,
        target: typeof e.target === 'string' ? e.target : e.target.id,
        shared_reports: e.shared_reports,
        co_mention_count: e.co_mention_count,
        last_co_mentioned_at: e.last_co_mentioned_at
      }))
    }
  }, [canvas])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left rail: canvases list */}
      <aside className="w-64 border-r border-border flex flex-col overflow-hidden bg-muted/10">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Graph Canvases</h2>
            <Badge variant="outline" className="text-[10px] ml-auto">v1.8.0</Badge>
          </div>
          <Button size="sm" variant="default" onClick={createNew} disabled={busy} className="w-full h-8">
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
            New canvas…
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {canvases.length === 0 ? (
            <div className="text-xs text-muted-foreground p-3 text-center">
              No canvases yet. Click <strong>New canvas…</strong> and paste a canonical entity id to seed one.
            </div>
          ) : canvases.map((c) => (
            <div key={c.id} className={cn(
              'border rounded-md p-2 cursor-pointer transition-colors group',
              activeId === c.id ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent/50'
            )} onClick={() => loadCanvas(c.id)}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium truncate">{c.name}</div>
                <button
                  onClick={(e) => { e.stopPropagation(); void removeCanvas(c.id, c.name) }}
                  className="text-muted-foreground hover:text-red-500 p-0.5 opacity-0 group-hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {c.node_count} nodes · {c.edge_count} edges · {formatRelativeTime(c.updated_at)}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Center: graph canvas */}
      <div className="flex-1 relative bg-[#0a0a0a]">
        {error && (
          <div className="absolute top-3 left-3 right-3 border border-red-500/30 bg-red-500/10 rounded-md p-2 text-xs text-red-400 flex items-center gap-2 z-10">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}
        {!canvas && !loading && (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <Network className="h-12 w-12 opacity-30" />
            <div className="text-sm">Pick a canvas from the left, or create a new one to start exploring.</div>
            <Button size="sm" variant="outline" onClick={createNew} disabled={busy}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New canvas…
            </Button>
          </div>
        )}
        {loading && (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {canvas && !loading && (
          <>
            <div className="absolute top-3 left-3 flex items-center gap-2 z-10 pointer-events-none">
              <div className="bg-card/90 backdrop-blur border border-border rounded-md px-3 py-1.5 text-xs pointer-events-auto">
                <span className="font-medium">{canvas.name}</span>
                <span className="text-muted-foreground ml-2">{canvas.nodes.length} nodes · {canvas.edges.length} edges</span>
              </div>
              <Button
                size="sm" variant="ghost"
                onClick={() => fgRef.current?.zoomToFit(400, 60)}
                className="h-7 bg-card/90 backdrop-blur border border-border pointer-events-auto"
                title="Fit to view"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <ForceGraph2D
              ref={fgRef as never}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              graphData={graphData as any}
              backgroundColor="#0a0a0a"
              nodeId="id"
              nodeLabel={(n: GraphNode) => `${n.label} (${n.entity_type})`}
              nodeRelSize={5}
              nodeVal={(n: GraphNode) => 1 + Math.log10((n.mention_count || 0) + 1)}
              nodeColor={(n: GraphNode) => colorForType(n.entity_type)}
              nodeCanvasObjectMode={() => 'after'}
              nodeCanvasObject={(node: GraphNode, ctx: CanvasRenderingContext2D, scale: number) => {
                if (scale < 1.2) return  // hide labels when zoomed out
                ctx.fillStyle = '#e5e7eb'
                ctx.font = `${10 / scale}px sans-serif`
                ctx.textAlign = 'center'
                ctx.textBaseline = 'top'
                const r = 6 + Math.log10((node.mention_count || 0) + 1) * 2
                ctx.fillText(node.label.slice(0, 24), node.x ?? 0, (node.y ?? 0) + r + 1)
                if (node.pinned) {
                  ctx.fillStyle = '#fbbf24'
                  ctx.beginPath()
                  ctx.arc((node.x ?? 0) + r * 0.7, (node.y ?? 0) - r * 0.7, 2 / scale, 0, Math.PI * 2)
                  ctx.fill()
                }
              }}
              linkColor={() => 'rgba(148, 163, 184, 0.4)'}
              linkWidth={(l: { shared_reports: number }) => Math.min(4, 0.5 + Math.log2(l.shared_reports || 1))}
              linkDirectionalParticles={0}
              cooldownTicks={120}
              onNodeClick={(n: GraphNode) => setSelectedNodeId(n.id)}
              onNodeRightClick={(n: GraphNode) => togglePin(n.id)}
              onNodeDragEnd={(n: GraphNode) => {
                // Auto-pin a node when the analyst manually positions
                // it — keeps it where they put it on next expansion.
                if (n.x != null && n.y != null) {
                  n.fx = n.x; n.fy = n.y
                  if (canvas) {
                    const next = canvas.nodes.map((node) => node.id === n.id ? { ...node, pinned: true } : node)
                    setCanvas({ ...canvas, nodes: next })
                    void window.heimdall.invoke('graph:save', { id: canvas.id, nodes: next })
                  }
                }
              }}
            />
          </>
        )}
      </div>

      {/* Right rail: node detail */}
      <aside className="w-72 border-l border-border overflow-auto p-3 space-y-3 bg-muted/10">
        {!selectedNode ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" /> How this works
              </CardTitle>
            </CardHeader>
            <CardContent className="text-[11px] text-muted-foreground space-y-2">
              <p><strong>Click</strong> a node to inspect / expand it.</p>
              <p><strong>Right-click</strong> or drag to pin a node — the simulation won't move it on subsequent expansions.</p>
              <p><strong>Expand</strong> pulls the top 10 co-mentioned entities (intel-grounded; same edges as the timeline's Co-mentions sidebar).</p>
              <p>Each canvas auto-saves after every expand / drag / remove.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-[10px] uppercase font-mono">{selectedNode.entity_type}</Badge>
                  {selectedNode.pinned && <Badge className="text-[10px] bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40">pinned</Badge>}
                </div>
                <CardTitle className="text-sm mt-1">{selectedNode.label}</CardTitle>
                <CardDescription className="text-[10px] font-mono">{selectedNode.id}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button size="sm" variant="default" onClick={() => expandNode(selectedNode.id)} disabled={busy} className="w-full h-8">
                  {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
                  Expand neighbours
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button size="sm" variant="outline" onClick={() => togglePin(selectedNode.id)} className="h-8">
                    {selectedNode.pinned ? <PinOff className="h-3.5 w-3.5 mr-1" /> : <Pin className="h-3.5 w-3.5 mr-1" />}
                    {selectedNode.pinned ? 'Unpin' : 'Pin'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => navigate(`/entity/${encodeURIComponent(selectedNode.id)}`)} className="h-8">
                    <ArrowRight className="h-3.5 w-3.5 mr-1" /> Timeline
                  </Button>
                </div>
                <Button
                  size="sm" variant="ghost"
                  onClick={() => removeNode(selectedNode.id)}
                  className="w-full h-8 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                >
                  <XIcon className="h-3.5 w-3.5 mr-1" /> Remove from canvas
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </aside>
    </div>
  )
}
