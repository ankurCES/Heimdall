import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import {
  Network, RefreshCw, Loader2, Filter, Radio, Clock, Sparkles, Zap
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Label } from '@renderer/components/ui/label'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { NodeDetailPanel, type GraphNodeLite, type GraphLinkLite } from './graph/NodeDetailPanel'
import { clusterForce } from './graph/clusterForce'
import { computeTimelineLayout, getTimelineLaneInfo, getTimelineTimeRange } from './graph/layoutTimeline'
import { computeRadialLayout, getRadialRingInfo } from './graph/layoutRadial'

type LayoutMode = 'force' | 'timeline' | 'radial'

interface GraphNode extends GraphNodeLite {
  x?: number
  y?: number
  fx?: number | null
  fy?: number | null
}

interface GraphLink extends GraphLinkLite {}

const DISCIPLINE_COLORS: Record<string, string> = {
  osint: '#3b82f6', cybint: '#ef4444', finint: '#10b981', socmint: '#8b5cf6',
  geoint: '#f59e0b', sigint: '#06b6d4', rumint: '#f97316', ci: '#ec4899',
  agency: '#6366f1', imint: '#14b8a6',
  preliminary: '#a78bfa', gap: '#fb923c', humint: '#fbbf24', action: '#22d3ee'
}

const SEVERITY_SIZE: Record<string, number> = {
  critical: 10, high: 8, medium: 7, low: 6, info: 5
}

// Icons drawn inside each node. Preliminary / HUMINT / Gap / Action have
// explicit types; regular intel falls back to its discipline emoji.
const TYPE_ICONS: Record<string, string> = {
  preliminary: '📋',
  humint: '🔰',
  gap: '⚠️',
  action: '📌'
}
const DISCIPLINE_ICONS: Record<string, string> = {
  osint: '🌐',
  cybint: '🛡️',
  finint: '💰',
  socmint: '💬',
  geoint: '🌍',
  sigint: '📡',
  rumint: '👂',
  ci: '🔒',
  agency: '🏛️',
  imint: '📷'
}

function iconForNode(node: { type?: string; discipline?: string }): string {
  if (node.type && TYPE_ICONS[node.type]) return TYPE_ICONS[node.type]
  if (node.discipline && DISCIPLINE_ICONS[node.discipline]) return DISCIPLINE_ICONS[node.discipline]
  return '📄'
}

const LINK_COLORS: Record<string, string> = {
  shared_entity: '#3b82f6',
  temporal: '#6b7280',
  preliminary_reference: '#a78bfa',
  gap_identified: '#fb923c',
  action_identified: '#22d3ee',
  humint_source: '#fbbf24',
  humint_preliminary: '#f59e0b',
  humint_cross_session: '#eab308'
}

const LINK_LABELS: Record<string, string> = {
  shared_entity: 'Shared Entity',
  temporal: 'Temporal',
  preliminary_reference: 'Preliminary Ref',
  gap_identified: 'Info Gap',
  action_identified: 'Action Item',
  humint_source: 'HUMINT Source',
  humint_preliminary: 'HUMINT Prelim',
  humint_cross_session: 'HUMINT Cross-Session'
}

const STORAGE_LAYOUT = 'graph.layoutMode'
const STORAGE_AUTOREFRESH = 'graph.autoRefresh'

export function RelationshipGraph() {
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] })
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [filterDiscipline, setFilterDiscipline] = useState('all')
  const [filterLinkType, setFilterLinkType] = useState('all')
  const [nodeLimit, setNodeLimit] = useState('200')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [selectedNodeLinks, setSelectedNodeLinks] = useState<Array<{ node: GraphNode; link: GraphLink }>>([])
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    try { return (localStorage.getItem(STORAGE_LAYOUT) as LayoutMode) || 'force' } catch { return 'force' }
  })
  const [autoRefresh, setAutoRefresh] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_AUTOREFRESH) !== 'false' } catch { return true }
  })
  // Bumped only when we WANT ForceGraph2D to fully reinitialize (layout mode
  // change). NOT bumped on silent refreshes or membership changes, so pan/zoom
  // and node positions are preserved.
  const [layoutKey, setLayoutKey] = useState(0)

  const graphRef = useRef<any>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInteracting = useRef<boolean>(false)

  useEffect(() => { try { localStorage.setItem(STORAGE_LAYOUT, layoutMode) } catch {} }, [layoutMode])
  useEffect(() => { try { localStorage.setItem(STORAGE_AUTOREFRESH, String(autoRefresh)) } catch {} }, [autoRefresh])

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  // Link count per node (computed once per load)
  const linkCountByNode = useMemo(() => {
    const m = new Map<string, number>()
    for (const link of graphData.links) {
      const s = typeof link.source === 'string' ? link.source : (link.source as any)?.id
      const t = typeof link.target === 'string' ? link.target : (link.target as any)?.id
      if (s) m.set(s, (m.get(s) || 0) + 1)
      if (t) m.set(t, (m.get(t) || 0) + 1)
    }
    return m
  }, [graphData.links])

  const loadGraph = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setUpdating(true)

    try {
      const result = await invoke('enrichment:getGraph', {
        discipline: filterDiscipline !== 'all' ? filterDiscipline : undefined,
        linkType: filterLinkType !== 'all' ? filterLinkType : undefined,
        limit: parseInt(nodeLimit)
      }) as { nodes: GraphNode[]; links: GraphLink[] }

      const fresh = result || { nodes: [], links: [] }

      setGraphData((prev) => {
        // First load — just take the fresh data.
        if (prev.nodes.length === 0) return fresh

        const prevById = new Map(prev.nodes.map((n) => [n.id, n]))
        const freshIds = new Set(fresh.nodes.map((n) => n.id))

        const added = fresh.nodes.filter((n) => !prevById.has(n.id))
        const removed = prev.nodes.filter((n) => !freshIds.has(n.id))
        const membershipChanged = added.length > 0 || removed.length > 0

        // Cheap signal for link-set changes without sorting
        const prevLinkKey = prev.links.length
        const freshLinkKey = fresh.links.length
        const linksChanged = prevLinkKey !== freshLinkKey

        // Silent refresh + same nodes/links → mutate metadata in place and
        // RETURN THE SAME REFERENCE. That prevents ForceGraph2D from seeing a
        // new graphData prop and re-starting its simulation. The result: no
        // camera reset, no node reshuffle, auto-refresh becomes invisible.
        if (silent && !membershipChanged && !linksChanged) {
          for (const n of fresh.nodes) {
            const existing = prevById.get(n.id)
            if (!existing) continue
            // Refresh metadata without touching x/y/vx/vy/fx/fy
            existing.title = n.title
            existing.severity = n.severity
            existing.verification = n.verification
            existing.source = n.source
            existing.createdAt = n.createdAt
            existing.snippet = n.snippet
          }
          return prev
        }

        // Membership changed — preserve live positions for nodes that
        // persisted, and let new nodes take their fresh initial positions.
        const nextNodes: GraphNode[] = fresh.nodes.map((n) => {
          const existing = prevById.get(n.id)
          if (!existing) return n
          // Mutate the EXISTING node object (preserving reference identity)
          // with fresh metadata. d3-force tracks by reference so this means
          // it sees "the same node, new metadata" — no layout disruption.
          existing.title = n.title
          existing.severity = n.severity
          existing.verification = n.verification
          existing.source = n.source
          existing.createdAt = n.createdAt
          existing.snippet = n.snippet
          return existing
        })
        return { nodes: nextNodes, links: fresh.links }
      })
    } catch (err) {
      console.error('Graph load failed:', err)
    } finally {
      setLoading(false)
      setUpdating(false)
    }
  }, [filterDiscipline, filterLinkType, nodeLimit, invoke])

  useEffect(() => { void loadGraph() }, [loadGraph])

  // Auto-refresh: subscribe to intel:newReports + enrichment:progress, debounce 3s
  useEffect(() => {
    if (!autoRefresh) return
    const schedule = () => {
      if (isInteracting.current) return // skip while user is dragging nodes
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => { void loadGraph(true) }, 3000)
    }
    const off1 = window.heimdall.on('intel:newReports', schedule)
    const off2 = window.heimdall.on('enrichment:progress', schedule)
    return () => {
      off1(); off2()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [autoRefresh, loadGraph])

  // When layout mode changes, apply pinned positions (or clear them) directly
  // on the existing node objects and remount the ForceGraph via a key bump.
  // Mutating in place lets d3 adopt the new layout without a data-ref change.
  useEffect(() => {
    if (graphData.nodes.length === 0) return
    if (layoutMode === 'force') {
      for (const n of graphData.nodes) {
        ;(n as any).fx = null
        ;(n as any).fy = null
      }
    } else {
      const positions = layoutMode === 'timeline'
        ? computeTimelineLayout(graphData.nodes as any)
        : computeRadialLayout(graphData.nodes as any)
      for (const n of graphData.nodes) {
        const p = positions.get(n.id)
        if (p) {
          ;(n as any).fx = p.fx
          ;(n as any).fy = p.fy
          ;(n as any).x = p.x
          ;(n as any).y = p.y
        } else {
          ;(n as any).fx = null
          ;(n as any).fy = null
        }
      }
    }
    // Bump the remount key so ForceGraph2D re-initializes with the pins
    setLayoutKey((k) => k + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode])

  // Also recompute pins when graphData reference actually changes (membership
  // changed) — but DON'T bump the remount key. The simulation already sees the
  // added nodes; we just need to pin them for non-force modes.
  useEffect(() => {
    if (layoutMode === 'force') return
    if (graphData.nodes.length === 0) return
    const positions = layoutMode === 'timeline'
      ? computeTimelineLayout(graphData.nodes as any)
      : computeRadialLayout(graphData.nodes as any)
    for (const n of graphData.nodes) {
      const p = positions.get(n.id)
      if (p) {
        ;(n as any).fx = p.fx
        ;(n as any).fy = p.fy
      }
    }
  }, [graphData, layoutMode])

  // Configure d3 forces for force-directed mode after remount
  useEffect(() => {
    if (layoutMode !== 'force' || !graphRef.current || graphData.nodes.length === 0) return
    const fg = graphRef.current
    try {
      fg.d3Force('charge')?.strength(-180)
      fg.d3Force('link')?.distance((l: any) => 80 / Math.max(0.3, l.strength || 0.3))
      fg.d3Force('cluster', clusterForce(graphData.nodes as any, 'discipline', 0.08))
    } catch (err) {
      console.warn('d3Force configure failed:', err)
    }
  }, [layoutMode, layoutKey])

  const handleNodeClick = (node: GraphNodeLite) => {
    const n = node as GraphNode
    setSelectedNode(n)

    const linked = graphData.links
      .filter((l) => {
        const sid = typeof l.source === 'string' ? l.source : (l.source as any)?.id
        const tid = typeof l.target === 'string' ? l.target : (l.target as any)?.id
        return sid === n.id || tid === n.id
      })
      .map((l) => {
        const sid = typeof l.source === 'string' ? l.source : (l.source as any)?.id
        const tid = typeof l.target === 'string' ? l.target : (l.target as any)?.id
        const otherId = sid === n.id ? tid : sid
        const otherNode = graphData.nodes.find((nn) => nn.id === otherId)
        return otherNode ? { node: otherNode, link: l } : null
      })
      .filter(Boolean) as Array<{ node: GraphNode; link: GraphLink }>

    setSelectedNodeLinks(linked)

    if (graphRef.current && n.x != null && n.y != null) {
      graphRef.current.centerAt(n.x, n.y, 500)
      graphRef.current.zoom(2.5, 500)
    }
  }

  const nodeLabel = useCallback((node: any) => {
    const n = node as GraphNode
    const discipline = (n.discipline || '').toUpperCase()
    const severity = (n.severity || '').toUpperCase()
    const source = n.source || '—'
    const time = n.createdAt ? formatRelativeTime(n.createdAt) : ''
    const verif = typeof n.verification === 'number' ? `verif ${n.verification}/100` : ''
    const linkCount = linkCountByNode.get(n.id) || 0
    const snippet = n.snippet ? String(n.snippet).replace(/\s+/g, ' ').slice(0, 120) : ''

    // Use HTML format (react-force-graph supports this via nodeLabel string as innerHTML)
    return `
<div style="font-family:system-ui,sans-serif;font-size:11px;padding:4px 6px;max-width:320px;line-height:1.4">
  <div style="font-weight:600;color:#e2e8f0;margin-bottom:4px">${escapeHtml(n.title || '').slice(0, 120)}</div>
  <div style="color:#94a3b8;font-size:10px">
    <span style="color:${DISCIPLINE_COLORS[n.discipline] || '#6b7280'}">${discipline}</span>
    &nbsp;|&nbsp; ${severity}
    &nbsp;|&nbsp; ${verif}
  </div>
  <div style="color:#64748b;font-size:10px;margin-top:2px">
    via <span style="color:#cbd5e1">${escapeHtml(source)}</span>
    ${time ? `&nbsp;•&nbsp; ${time}` : ''}
  </div>
  <div style="color:#64748b;font-size:10px;margin-top:2px">
    <span style="color:#3b82f6">${linkCount}</span> linked
    ${n.type === 'humint' && n.confidence ? `&nbsp;•&nbsp; confidence: <span style="color:#fbbf24">${n.confidence}</span>` : ''}
  </div>
  ${snippet ? `<div style="color:#94a3b8;font-size:10px;margin-top:4px;font-style:italic">"${escapeHtml(snippet)}"</div>` : ''}
</div>`.trim()
  }, [linkCountByNode])

  const linkLabel = useCallback((link: any) => {
    const type = LINK_LABELS[link.type] || link.type
    const strength = Math.round((link.strength || 0) * 100)
    return `${type} (${strength}%)\n${link.reason || ''}`
  }, [])

  // Timeline axis overlay — drawn via a separate canvas layer
  const timelineInfo = useMemo(() => {
    if (layoutMode !== 'timeline') return null
    return {
      lanes: getTimelineLaneInfo(graphData.nodes as any),
      range: getTimelineTimeRange(graphData.nodes as any)
    }
  }, [layoutMode, graphData.nodes])

  const radialInfo = useMemo(() => {
    if (layoutMode !== 'radial') return null
    return getRadialRingInfo(graphData.nodes as any)
  }, [layoutMode, graphData.nodes])

  return (
    <div className="flex h-full overflow-hidden relative">
      {/* Controls panel — non-scrolling header + scrollable body */}
      <div className="w-60 shrink-0 border-r border-border bg-card/50 flex flex-col overflow-hidden">
        {/* Sticky header: title + counts + layout toggle */}
        <div className="shrink-0 border-b border-border/50 p-4 space-y-3 bg-card/70">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold">Relationship Graph</span>
          </div>

          <div className="text-xs text-muted-foreground">
            {graphData.nodes.length} nodes · {graphData.links.length} links
            {updating && <span className="ml-1.5 text-primary">• updating…</span>}
          </div>

          {/* Layout mode */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Layout</Label>
            <div className="grid grid-cols-3 gap-1">
              <button
                onClick={() => setLayoutMode('force')}
                className={cn('flex flex-col items-center gap-0.5 p-1.5 rounded text-[9px] border transition-colors',
                  layoutMode === 'force' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground')}
                title="Force-directed (default, clustered by discipline)"
              >
                <Zap className="h-3.5 w-3.5" />Force
              </button>
              <button
                onClick={() => setLayoutMode('timeline')}
                className={cn('flex flex-col items-center gap-0.5 p-1.5 rounded text-[9px] border transition-colors',
                  layoutMode === 'timeline' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground')}
                title="Timeline swimlane: X=time, Y=discipline"
              >
                <Clock className="h-3.5 w-3.5" />Timeline
              </button>
              <button
                onClick={() => setLayoutMode('radial')}
                className={cn('flex flex-col items-center gap-0.5 p-1.5 rounded text-[9px] border transition-colors',
                  layoutMode === 'radial' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-foreground')}
                title="Radial: concentric rings by discipline"
              >
                <Sparkles className="h-3.5 w-3.5" />Radial
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable body: filters + legend */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Filters */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1"><Filter className="h-3 w-3" />Discipline</Label>
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
              <SelectItem value="preliminary_reference">Preliminary Reference</SelectItem>
              <SelectItem value="humint">HUMINT Links (all)</SelectItem>
              <SelectItem value="gap_identified">Gap Identified</SelectItem>
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

        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => loadGraph()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Refresh
          </Button>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={cn('p-1.5 rounded border', autoRefresh ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}
            title={autoRefresh ? 'Auto-refresh on (click to disable)' : 'Auto-refresh off (click to enable)'}
          >
            <Radio className={cn('h-3.5 w-3.5', autoRefresh && 'animate-pulse')} />
          </button>
        </div>

        {/* Legend */}
        <div className="space-y-1 pt-2 border-t border-border">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Node Icons</Label>
          {Object.entries(DISCIPLINE_COLORS).map(([disc, color]) => {
            const icon = TYPE_ICONS[disc] || DISCIPLINE_ICONS[disc] || '📄'
            const label = disc === 'preliminary' ? 'Preliminary' : disc === 'gap' ? 'Gap' : disc === 'humint' ? 'HUMINT' : (DISCIPLINE_LABELS[disc as keyof typeof DISCIPLINE_LABELS] || disc)
            return (
              <div key={disc} className="flex items-center gap-2 text-[10px]">
                <span className="text-[11px] w-4 text-center">{icon}</span>
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ background: color }}
                />
                <span className="truncate">{label}</span>
              </div>
            )
          })}
        </div>

        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Link Colors</Label>
          {Object.entries(LINK_COLORS).map(([t, c]) => (
            <div key={t} className="flex items-center gap-2 text-[10px]">
              <span className="h-0.5 w-4 shrink-0" style={{ background: c }} />
              <span className="truncate">{LINK_LABELS[t]}</span>
            </div>
          ))}
        </div>
        </div>
      </div>

      {/* Graph canvas */}
      <div className="flex-1 relative" style={{ background: '#0a0f1a' }}>
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : graphData.nodes.length > 0 ? (
          <>
            <ForceGraph2D
              key={layoutKey}
              ref={graphRef as any}
              graphData={graphData as any}
              nodeColor={(node: any) => DISCIPLINE_COLORS[node.discipline] || '#6b7280'}
              nodeVal={(node: any) => SEVERITY_SIZE[node.severity] || 3}
              nodeLabel={nodeLabel as any}
              linkColor={(link: any) => LINK_COLORS[link.type] || '#334155'}
              linkWidth={(link: any) => Math.max(0.5, (link.strength || 0.3) * 2)}
              linkLabel={linkLabel as any}
              linkDirectionalParticles={layoutMode === 'force' ? 1 : 0}
              linkDirectionalParticleWidth={1.5}
              linkCurvature={layoutMode === 'timeline' ? 0.2 : 0}
              onNodeClick={handleNodeClick as any}
              onNodeDragStart={() => { isInteracting.current = true }}
              onNodeDragEnd={(node: any) => {
                isInteracting.current = false
                if (layoutMode !== 'force') {
                  node.fx = node.x
                  node.fy = node.y
                }
              }}
              cooldownTicks={layoutMode === 'force' ? 200 : 0}
              d3AlphaDecay={0.015}
              backgroundColor="#0a0f1a"
              enableNodeDrag={true}
              nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const size = (SEVERITY_SIZE[node.severity] || 5) * 1.6
                const color = DISCIPLINE_COLORS[node.discipline] || '#6b7280'
                const isSelected = selectedNode?.id === node.id

                // Glow
                ctx.shadowColor = color
                ctx.shadowBlur = isSelected ? 18 : 10

                // All nodes are now filled circles with the discipline color
                // as a thin ring + dark interior so the emoji icon inside is
                // legible. Shape differentiation now comes from the icon.
                ctx.beginPath()
                ctx.arc(node.x, node.y, size, 0, 2 * Math.PI)
                ctx.fillStyle = 'rgba(15, 23, 42, 0.95)' // dark interior
                ctx.fill()

                ctx.shadowBlur = 0
                ctx.strokeStyle = isSelected ? '#ffffff' : color
                ctx.lineWidth = isSelected ? 3 : 2
                ctx.stroke()

                // Draw emoji icon centered in the node
                const icon = iconForNode(node)
                const iconSize = size * 1.3
                ctx.font = `${iconSize}px -apple-system, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`
                ctx.textAlign = 'center'
                ctx.textBaseline = 'middle'
                ctx.fillText(icon, node.x, node.y + iconSize * 0.05)

                // Title label below node when zoomed in
                if (globalScale > 1.3) {
                  ctx.font = `${Math.max(3, 11 / globalScale)}px -apple-system, sans-serif`
                  ctx.fillStyle = '#e2e8f0'
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'top'
                  ctx.fillText(String(node.title || '').slice(0, 30), node.x, node.y + size + 4)
                }
              }}
            />

            {/* Timeline overlay */}
            {timelineInfo && (
              <TimelineOverlay lanes={timelineInfo.lanes} range={timelineInfo.range} />
            )}

            {/* Radial overlay */}
            {radialInfo && <RadialOverlay rings={radialInfo} />}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Network className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">No relationship data</p>
          </div>
        )}
      </div>

      {/* Detail popup — floating overlay over the graph canvas, not an inline flex column */}
      {selectedNode && (
        <div className="absolute top-0 right-0 h-full z-[1000] shadow-2xl pointer-events-auto">
          <NodeDetailPanel
            node={selectedNode}
            linkedItems={selectedNodeLinks}
            linkColors={LINK_COLORS}
            onClose={() => {
              setSelectedNode(null)
              setSelectedNodeLinks([])
              // Recenter the graph so the area that was hidden under the popup
              // is visible again and the simulation settles back to its
              // natural layout.
              if (graphRef.current?.zoomToFit) {
                graphRef.current.zoomToFit(400, 60)
              }
            }}
            onSelectNode={(n) => handleNodeClick(n)}
          />
        </div>
      )}
    </div>
  )
}

// ---- Mode overlays ----

function TimelineOverlay({
  lanes, range
}: {
  lanes: Array<{ discipline: string; y: number }>
  range: { min: number; max: number }
}) {
  return (
    <div className="absolute top-2 left-2 right-2 pointer-events-none">
      <Card className="bg-card/70 backdrop-blur-sm border-border/50">
        <div className="px-3 py-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span><span className="text-foreground">{new Date(range.min).toLocaleDateString()}</span> → <span className="text-foreground">{new Date(range.max).toLocaleDateString()}</span></span>
          <span className="ml-auto">{lanes.length} disciplines</span>
        </div>
      </Card>
    </div>
  )
}

function RadialOverlay({ rings }: { rings: Array<{ discipline: string; r: number }> }) {
  return (
    <div className="absolute top-2 left-2 right-2 pointer-events-none">
      <Card className="bg-card/70 backdrop-blur-sm border-border/50">
        <div className="px-3 py-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground flex-wrap">
          <Sparkles className="h-3 w-3 mr-1" />
          {rings.map((r, i) => (
            <span key={r.discipline} className="flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: DISCIPLINE_COLORS[r.discipline] || '#6b7280' }}
              />
              {DISCIPLINE_LABELS[r.discipline as keyof typeof DISCIPLINE_LABELS] || r.discipline}
              {i < rings.length - 1 && <span className="text-muted-foreground/40 ml-1">·</span>}
            </span>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ---- Helpers ----

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  } as Record<string, string>)[ch] || ch)
}
