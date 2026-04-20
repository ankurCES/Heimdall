import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, Panel,
  addEdge, useNodesState, useEdgesState,
  type Connection, type Node, type Edge
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Play, Save, Plus, Trash2, Loader2, Search, Moon, Globe, Shield,
  FileText, Users, AlertTriangle, Download, Sparkles, MessageSquare,
  GitMerge, Settings
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { toast } from 'sonner'

interface NodeTypeDef {
  type: string
  label: string
  description: string
  category: string
  icon: string
  color: string
  inputs: Array<{ name: string; type: string }>
  outputs: Array<{ name: string; type: string }>
  configSchema: Array<{ name: string; type: string; label: string; default?: unknown; options?: Array<{ label: string; value: string }> }>
  isCustom?: boolean
}

interface WorkflowData {
  id: string
  name: string
  description: string | null
  nodes: any[]
  edges: any[]
  isPreset: boolean
  createdAt: number
  updatedAt: number
}

const ICON_MAP: Record<string, typeof Search> = {
  Search, Moon, Globe, Shield, FileText, Users, AlertTriangle,
  Download, Sparkles, MessageSquare, GitMerge, Settings
}

const CATEGORY_COLORS: Record<string, string> = {
  source: 'bg-blue-500/10 border-blue-500/30',
  search: 'bg-cyan-500/10 border-cyan-500/30',
  fetch: 'bg-green-500/10 border-green-500/30',
  transform: 'bg-amber-500/10 border-amber-500/30',
  analysis: 'bg-red-500/10 border-red-500/30',
  output: 'bg-emerald-500/10 border-emerald-500/30',
  control: 'bg-slate-500/10 border-slate-500/30'
}

/** Solid border + background colors for the canvas nodes (CSS values). */
const NODE_STYLE: Record<string, { bg: string; border: string; accent: string }> = {
  source:    { bg: 'hsl(221 44% 12%)', border: 'hsl(217 91% 60%)',  accent: '#3b82f6' },  // blue
  search:    { bg: 'hsl(195 40% 11%)', border: 'hsl(188 85% 50%)',  accent: '#06b6d4' },  // cyan
  fetch:     { bg: 'hsl(142 40% 10%)', border: 'hsl(142 71% 45%)',  accent: '#22c55e' },  // green
  transform: { bg: 'hsl(38 40% 11%)',  border: 'hsl(38 92% 50%)',   accent: '#eab308' },  // amber
  analysis:  { bg: 'hsl(0 40% 11%)',   border: 'hsl(0 84% 60%)',    accent: '#ef4444' },  // red
  output:    { bg: 'hsl(160 40% 10%)', border: 'hsl(160 84% 39%)',  accent: '#10b981' },  // emerald
  control:   { bg: 'hsl(220 20% 13%)', border: 'hsl(215 20% 45%)', accent: '#64748b' },  // slate
}

/** Edge stroke color based on source node category. */
function edgeColorForCategory(cat: string): string {
  return NODE_STYLE[cat]?.accent || '#64748b'
}

export function WorkflowEditorPage() {
  const [nodeTypes, setNodeTypes] = useState<NodeTypeDef[]>([])
  const [workflows, setWorkflows] = useState<WorkflowData[]>([])
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowData | null>(null)
  const [workflowName, setWorkflowName] = useState('Untitled workflow')
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [executing, setExecuting] = useState(false)
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: string; message?: string }>>({})
  const [paletteSearch, setPaletteSearch] = useState('')
  const [customNodeOpen, setCustomNodeOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customDesc, setCustomDesc] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadNodeTypes = useCallback(async () => {
    const types = await invoke('workflow:node_types') as NodeTypeDef[]
    setNodeTypes(types)
  }, [invoke])

  const loadWorkflows = useCallback(async () => {
    const wfs = await invoke('workflow:list') as WorkflowData[]
    setWorkflows(wfs)
  }, [invoke])

  useEffect(() => { void loadNodeTypes(); void loadWorkflows() }, [loadNodeTypes, loadWorkflows])

  // Live node progress.
  useEffect(() => {
    const unsub = window.heimdall.on('workflow:node_progress', (payload: unknown) => {
      const p = payload as { nodeId: string; status: string; message?: string }
      setNodeStatuses((prev) => ({ ...prev, [p.nodeId]: { status: p.status, message: p.message } }))
    })
    const unsubComplete = window.heimdall.on('workflow:run_complete', (payload: unknown) => {
      setExecuting(false)
      const r = payload as { status: string }
      if (r.status === 'completed') toast.success('Workflow completed')
      else toast.error(`Workflow ${r.status}`)
    })
    return () => { unsub(); unsubComplete() }
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    // Color the edge based on the source node's category.
    const srcNode = nodes.find((n) => n.id === connection.source)
    const srcCat = (srcNode?.data as any)?.category || 'control'
    const strokeColor = edgeColorForCategory(srcCat)

    setEdges((eds) => addEdge({
      ...connection,
      animated: true,
      style: { stroke: strokeColor, strokeWidth: 2 }
    }, eds))
  }, [setEdges, nodes])

  const addNode = (typeDef: NodeTypeDef) => {
    const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const catStyle = NODE_STYLE[typeDef.category] || NODE_STYLE.control
    const newNode: Node = {
      id,
      type: 'default',
      position: { x: 250 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: {
        label: typeDef.label,
        nodeType: typeDef.type,
        category: typeDef.category,
        icon: typeDef.icon,
        color: typeDef.color,
        config: Object.fromEntries(typeDef.configSchema.map((c) => [c.name, c.default ?? ''])),
        inputs: typeDef.inputs,
        outputs: typeDef.outputs
      },
      style: {
        background: catStyle.bg,
        border: `2px solid ${catStyle.border}`,
        borderRadius: '10px',
        padding: '10px 14px',
        color: 'hsl(210 40% 93%)',
        fontSize: '12px',
        minWidth: '170px',
        boxShadow: `0 0 12px ${catStyle.accent}30`
      }
    }
    setNodes((nds) => [...nds, newNode])
  }

  const saveWorkflow = async () => {
    const wfNodes = nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType,
      position: n.position,
      config: n.data.config || {}
    }))
    const wfEdges = edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: (e.data as any)?.sourcePort || e.sourceHandle || 'output',
      target: e.target,
      targetHandle: (e.data as any)?.targetPort || e.targetHandle || 'input'
    }))
    const r = await invoke('workflow:save', {
      id: activeWorkflow?.id,
      name: workflowName,
      nodes: wfNodes,
      edges: wfEdges
    }) as WorkflowData
    setActiveWorkflow(r)
    toast.success('Workflow saved')
    void loadWorkflows()
  }

  const executeWorkflow = async () => {
    if (!activeWorkflow) {
      await saveWorkflow()
    }
    const wfId = activeWorkflow?.id
    if (!wfId) return
    setExecuting(true)
    setNodeStatuses({})
    try {
      await invoke('workflow:execute', { workflowId: wfId })
    } catch (err) {
      toast.error('Execution failed', { description: String(err) })
      setExecuting(false)
    }
  }

  const loadWorkflow = async (wf: WorkflowData) => {
    setActiveWorkflow(wf)
    setWorkflowName(wf.name)
    // Convert workflow nodes to reactflow nodes.
    const rfNodes: Node[] = wf.nodes.map((n: any) => {
      const typeDef = nodeTypes.find((t) => t.type === n.type)
      const cat = typeDef?.category || 'control'
      const catStyle = NODE_STYLE[cat] || NODE_STYLE.control
      return {
        id: n.id,
        type: 'default',
        position: n.position || { x: 100, y: 100 },
        data: {
          label: typeDef?.label || n.type,
          nodeType: n.type,
          category: cat,
          icon: typeDef?.icon || 'Sparkles',
          color: typeDef?.color || 'border-slate-400',
          config: n.config || {},
          inputs: typeDef?.inputs || [],
          outputs: typeDef?.outputs || []
        },
        style: {
          background: catStyle.bg,
          border: `2px solid ${catStyle.border}`,
          borderRadius: '10px',
          padding: '10px 14px',
          color: 'hsl(210 40% 93%)',
          fontSize: '12px',
          minWidth: '170px',
          boxShadow: `0 0 12px ${catStyle.accent}30`
        }
      }
    })
    setNodes(rfNodes)
    setEdges(wf.edges.map((e: any) => {
      // Resolve the source node's category to color the edge.
      const srcNode = wf.nodes.find((n: any) => n.id === e.source)
      const srcTypeDef = srcNode ? nodeTypes.find((t) => t.type === srcNode.type) : null
      const srcCat = srcTypeDef?.category || 'control'
      const strokeColor = edgeColorForCategory(srcCat)

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: null,
        targetHandle: null,
        animated: true,
        style: { stroke: strokeColor, strokeWidth: 2 },
        data: { sourcePort: e.sourceHandle, targetPort: e.targetHandle }
      }
    }))
  }

  const createCustomNode = async () => {
    if (!customName.trim() || !customPrompt.trim()) return
    const type = `custom_${customName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
    await invoke('workflow:register_custom_node', {
      type, label: customName, description: customDesc,
      inputs: [{ name: 'input', type: 'text' }],
      outputs: [{ name: 'output', type: 'text' }],
      prompt: customPrompt
    })
    toast.success(`Custom node "${customName}" created`)
    setCustomNodeOpen(false)
    setCustomName(''); setCustomDesc(''); setCustomPrompt('')
    void loadNodeTypes()
  }

  // Filter node palette.
  const groupedTypes = useMemo(() => {
    const filtered = nodeTypes.filter((t) =>
      !paletteSearch || t.label.toLowerCase().includes(paletteSearch.toLowerCase()) ||
      t.type.toLowerCase().includes(paletteSearch.toLowerCase())
    )
    const groups: Record<string, NodeTypeDef[]> = {}
    for (const t of filtered) {
      ;(groups[t.category] = groups[t.category] || []).push(t)
    }
    return groups
  }, [nodeTypes, paletteSearch])

  const categoryOrder = ['source', 'search', 'fetch', 'transform', 'analysis', 'output', 'control']

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Node palette + saved workflows */}
      <div className="w-64 border-r border-border bg-card/30 flex flex-col">
        <div className="p-3 border-b border-border">
          <h2 className="text-sm font-semibold mb-2">Workflow Builder</h2>
          <Input value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)}
            placeholder="Search nodes…" className="h-7 text-xs" />
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-2">
          {categoryOrder.filter((c) => groupedTypes[c]).map((cat) => (
            <div key={cat}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 px-1">{cat}</div>
              {groupedTypes[cat].map((t) => {
                const Icon = ICON_MAP[t.icon] || Sparkles
                return (
                  <button key={t.type} onClick={() => addNode(t)}
                    className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/50 transition-colors border', CATEGORY_COLORS[t.category] || '')}>
                    <Icon className="h-3 w-3 shrink-0" />
                    <span className="truncate flex-1 text-left">{t.label}</span>
                    {t.isCustom && <Badge variant="outline" className="text-[8px] py-0 px-1">custom</Badge>}
                  </button>
                )
              })}
            </div>
          ))}

          <button onClick={() => setCustomNodeOpen(true)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs border border-dashed border-border hover:border-primary text-muted-foreground hover:text-primary">
            <Plus className="h-3 w-3" /> Create custom node
          </button>
        </div>

        {/* Saved workflows */}
        <div className="border-t border-border p-2 max-h-40 overflow-auto">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Saved workflows</div>
          {workflows.map((wf) => (
            <button key={wf.id} onClick={() => loadWorkflow(wf)}
              className={cn('w-full text-left px-2 py-1 rounded text-xs hover:bg-accent/50',
                activeWorkflow?.id === wf.id && 'bg-accent')}>
              <div className="truncate">{wf.name}</div>
              <div className="text-[10px] text-muted-foreground">{wf.nodes.length} nodes</div>
            </button>
          ))}
          {workflows.length === 0 && <p className="text-[10px] text-muted-foreground italic">No saved workflows</p>}
        </div>
      </div>

      {/* Center: ReactFlow canvas */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          colorMode="dark"
          defaultEdgeOptions={{ style: { stroke: '#64748b', strokeWidth: 2 }, animated: true }}
        >
          <Background color="hsl(217 33% 20%)" gap={20} />
          <Controls position="bottom-right" />
          <MiniMap nodeColor={() => 'hsl(262 83% 58%)'} maskColor="rgba(0,0,0,0.7)" />

          <Panel position="top-left">
            <div className="flex items-center gap-2 bg-card/80 backdrop-blur px-3 py-1.5 rounded-lg border border-border shadow-lg">
              <Input value={workflowName} onChange={(e) => setWorkflowName(e.target.value)}
                className="h-7 text-xs w-48 bg-transparent border-none" />
              <Button size="sm" variant="outline" onClick={saveWorkflow} className="h-7 text-xs">
                <Save className="h-3 w-3 mr-1" /> Save
              </Button>
              <Button size="sm" onClick={executeWorkflow} disabled={executing || nodes.length === 0} className="h-7 text-xs">
                {executing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                {executing ? 'Running…' : 'Execute'}
              </Button>
            </div>
          </Panel>

          {/* Node execution status overlay */}
          {Object.keys(nodeStatuses).length > 0 && (
            <Panel position="top-right">
              <div className="bg-card/80 backdrop-blur px-3 py-2 rounded-lg border border-border shadow-lg space-y-1 max-h-60 overflow-auto">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Execution</div>
                {Object.entries(nodeStatuses).map(([nodeId, { status, message }]) => {
                  const node = nodes.find((n) => n.id === nodeId)
                  return (
                    <div key={nodeId} className="flex items-center gap-2 text-xs">
                      <span className={cn('w-2 h-2 rounded-full',
                        status === 'completed' ? 'bg-emerald-400' :
                        status === 'running' ? 'bg-amber-400 animate-pulse' :
                        status === 'error' ? 'bg-red-400' : 'bg-slate-400'
                      )} />
                      <span className="truncate max-w-40">{String(node?.data?.label || nodeId.slice(0, 8))}</span>
                      {message && <span className="text-muted-foreground truncate max-w-40">{message.slice(0, 40)}</span>}
                    </div>
                  )
                })}
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* Custom node creation modal */}
      <Dialog open={customNodeOpen} onOpenChange={setCustomNodeOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> Create custom node</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Name</label>
              <Input value={customName} onChange={(e) => setCustomName(e.target.value)}
                placeholder="e.g. Translate to English" className="text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">Description</label>
              <Input value={customDesc} onChange={(e) => setCustomDesc(e.target.value)}
                placeholder="What this node does" className="text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium">LLM Prompt</label>
              <textarea value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Use {{input}} to reference the input text. Example:&#10;&#10;Translate the following to English:&#10;&#10;{{input}}"
                rows={6} className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background resize-y font-mono" />
              <p className="text-[10px] text-muted-foreground mt-1">
                Use <code className="font-mono">{'{{input}}'}</code> for the input text and <code className="font-mono">{'{{config.name}}'}</code> for config values.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCustomNodeOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={createCustomNode} disabled={!customName.trim() || !customPrompt.trim()}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Create node
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
