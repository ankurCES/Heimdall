import { useEffect, useState, useCallback } from 'react'
import { FolderOpen, Plus, Trash2, Save, Loader2, FileText, Database, Users, AlertTriangle, Server, X, ChevronRight, Pause, Play, Archive } from 'lucide-react'
import { Card } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { toast } from 'sonner'

/**
 * Case Files page — investigation grouping for reports + intel + entities +
 * IOCs + sources. Mirrors the Library page layout: list on the left, detail
 * drawer on the right.
 *
 * Per-case view groups items by type with icon prefixes. Items reference
 * other tables; this page doesn't navigate to them yet (deferred to Phase
 * 1.1.7 polish) but shows their resolved title + summary.
 */

interface CaseFile {
  id: string
  name: string
  description: string | null
  status: 'open' | 'dormant' | 'closed'
  classification: string | null
  leadAnalyst: string | null
  tags: string[]
  itemCount: number
  reportCount: number
  createdAt: number
  updatedAt: number
}

interface CaseFileItem {
  id: string
  caseFileId: string
  itemType: 'report' | 'intel_report' | 'entity' | 'ioc' | 'source'
  itemId: string
  addedAt: number
  notes: string | null
  title?: string
  summary?: string
}

interface Stats {
  total: number
  open: number
  dormant: number
  closed: number
  totalItems: number
}

const STATUS_COLOR: Record<string, string> = {
  open:    'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  dormant: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  closed:  'bg-slate-500/10 text-slate-400 border-slate-500/30'
}

const ITEM_ICON: Record<string, typeof FileText> = {
  report: FileText,
  intel_report: Database,
  entity: Users,
  ioc: AlertTriangle,
  source: Server
}

const ITEM_COLOR: Record<string, string> = {
  report: 'text-cyan-400',
  intel_report: 'text-amber-400',
  entity: 'text-blue-400',
  ioc: 'text-red-400',
  source: 'text-slate-400'
}

function formatTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  if (delta < 7 * 86400_000) return `${Math.floor(delta / 86400_000)}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}

export function CaseFilesPage() {
  const [cases, setCases] = useState<CaseFile[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [items, setItems] = useState<CaseFileItem[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, s] = await Promise.all([
        window.heimdall.invoke('cases:list', {
          status: statusFilter.size > 0 ? Array.from(statusFilter) : undefined
        }) as Promise<{ ok: boolean; cases: CaseFile[] }>,
        window.heimdall.invoke('cases:stats') as Promise<Stats & { ok: boolean }>
      ])
      if (r.ok) setCases(r.cases || [])
      if (s.ok) setStats({ total: s.total, open: s.open, dormant: s.dormant, closed: s.closed, totalItems: s.totalItems })
    } catch (err) {
      toast.error('Failed to load case files', { description: String(err) })
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  // Load items when selection changes
  useEffect(() => {
    if (!selectedId) { setItems([]); return }
    (async () => {
      try {
        const r = await window.heimdall.invoke('cases:list_items', { caseFileId: selectedId }) as { ok: boolean; items?: CaseFileItem[] }
        if (r.ok) setItems(r.items || [])
      } catch (err) { console.warn(err) }
    })()
  }, [selectedId])

  const selected = cases.find((c) => c.id === selectedId) ?? null

  const create = async () => {
    if (!newName.trim()) { toast.error('Name required'); return }
    try {
      const r = await window.heimdall.invoke('cases:create', {
        name: newName.trim(),
        description: newDesc.trim() || undefined
      }) as { ok: boolean; case?: CaseFile; error?: string }
      if (r.ok && r.case) {
        toast.success(`Case "${r.case.name}" created`)
        setNewName(''); setNewDesc(''); setCreating(false)
        await load()
        setSelectedId(r.case.id)
      } else {
        toast.error('Create failed', { description: r.error })
      }
    } catch (err) {
      toast.error('Create failed', { description: String(err) })
    }
  }

  const updateStatus = async (id: string, status: 'open' | 'dormant' | 'closed') => {
    try {
      await window.heimdall.invoke('cases:update', { id, patch: { status } })
      toast.success(`Case status: ${status}`)
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const removeCase = async (id: string) => {
    if (!confirm('Delete this case file? Item references will be removed but the underlying reports/entities/IOCs are preserved.')) return
    try {
      await window.heimdall.invoke('cases:delete', id)
      toast.success('Case file deleted')
      if (selectedId === id) setSelectedId(null)
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const removeItem = async (itemId: string) => {
    try {
      await window.heimdall.invoke('cases:remove_item', itemId)
      toast.success('Item removed from case')
      // Reload items
      if (selectedId) {
        const r = await window.heimdall.invoke('cases:list_items', { caseFileId: selectedId }) as { ok: boolean; items?: CaseFileItem[] }
        if (r.ok) setItems(r.items || [])
      }
      load()
    } catch (err) { toast.error(String(err)) }
  }

  const toggle = (set: Set<string>, value: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }

  // Group items by type
  const itemsByType: Record<string, CaseFileItem[]> = {}
  for (const item of items) {
    if (!itemsByType[item.itemType]) itemsByType[item.itemType] = []
    itemsByType[item.itemType].push(item)
  }

  return (
    <div className="flex h-full">
      {/* LEFT: case list */}
      <div className={`${selectedId ? 'w-1/2' : 'w-full'} flex flex-col border-r border-border transition-all`}>
        {/* Header */}
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3">
              <FolderOpen className="w-6 h-6 text-amber-400" />
              <div>
                <h1 className="text-xl font-semibold">Case Files</h1>
                <p className="text-xs text-muted-foreground">
                  Long-running investigations grouping reports, intel, entities, and IOCs.
                </p>
              </div>
            </div>
            <Button onClick={() => setCreating(!creating)} size="sm">
              <Plus className="w-4 h-4 mr-1" /> New case
            </Button>
          </div>

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-5 gap-2 text-xs">
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Total</div>
                <div className="text-xl font-semibold">{stats.total}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Open</div>
                <div className="text-xl font-semibold text-emerald-300">{stats.open}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Dormant</div>
                <div className="text-xl font-semibold text-amber-300">{stats.dormant}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Closed</div>
                <div className="text-xl font-semibold text-slate-400">{stats.closed}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Items</div>
                <div className="text-xl font-semibold">{stats.totalItems}</div>
              </div>
            </div>
          )}

          {/* Inline create form */}
          {creating && (
            <Card className="mt-3 p-3 space-y-2">
              <Input
                placeholder='Case name (e.g. "Operation Bluefin")'
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
              <Input
                placeholder="Short description (optional)"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={create}><Save className="w-4 h-4 mr-1" /> Create</Button>
                <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(''); setNewDesc('') }}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* Filter chips */}
        <div className="border-b border-border px-6 py-2 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Status:</span>
          {(['open', 'dormant', 'closed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => toggle(statusFilter, s, setStatusFilter)}
              className={`text-[10px] px-2 py-0.5 rounded border capitalize transition-colors ${
                statusFilter.has(s) ? STATUS_COLOR[s] : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && cases.length === 0 && (
            <div className="text-center py-16 px-6 text-muted-foreground">
              <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No case files yet.</p>
              <p className="text-xs mt-2 opacity-70">Click "New case" to start an investigation.</p>
            </div>
          )}
          {!loading && cases.length > 0 && (
            <div className="divide-y divide-border">
              {cases.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                  className={`w-full text-left px-6 py-3 hover:bg-accent/30 transition-colors flex items-start gap-3 ${
                    selectedId === c.id ? 'bg-accent/40 border-l-2 border-l-amber-400' : ''
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate">{c.name}</span>
                      <Badge variant="outline" className={`text-[9px] capitalize ${STATUS_COLOR[c.status]}`}>{c.status}</Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="text-amber-300/80">{c.itemCount} item{c.itemCount === 1 ? '' : 's'}</span>
                      {c.reportCount > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-cyan-400/80">{c.reportCount} report{c.reportCount === 1 ? '' : 's'}</span>
                        </>
                      )}
                      <span>·</span>
                      <span>updated {formatTime(c.updatedAt)}</span>
                      {c.tags.length > 0 && (
                        <>
                          <span>·</span>
                          {c.tags.slice(0, 2).map((t) => (
                            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">{t}</span>
                          ))}
                        </>
                      )}
                    </div>
                    {c.description && (
                      <div className="text-xs text-muted-foreground mt-1 truncate">{c.description}</div>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT: detail */}
      {selected && (
        <div className="w-1/2 flex flex-col">
          <div className="border-b border-border px-6 py-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold truncate">{selected.name}</h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <Badge variant="outline" className={`text-[10px] capitalize ${STATUS_COLOR[selected.status]}`}>{selected.status}</Badge>
                {selected.classification && (
                  <span className="font-mono">{selected.classification}</span>
                )}
                <span>·</span>
                <span>created {formatTime(selected.createdAt)}</span>
              </div>
              {selected.description && (
                <p className="text-sm text-muted-foreground mt-2">{selected.description}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {selected.status === 'open' && (
                <Button size="sm" variant="outline" onClick={() => updateStatus(selected.id, 'dormant')} title="Pause investigation">
                  <Pause className="w-3.5 h-3.5 mr-1" /> Pause
                </Button>
              )}
              {selected.status === 'dormant' && (
                <Button size="sm" variant="outline" onClick={() => updateStatus(selected.id, 'open')} title="Resume investigation">
                  <Play className="w-3.5 h-3.5 mr-1" /> Resume
                </Button>
              )}
              {selected.status !== 'closed' && (
                <Button size="sm" variant="outline" onClick={() => updateStatus(selected.id, 'closed')} title="Close investigation">
                  <Archive className="w-3.5 h-3.5 mr-1" /> Close
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => removeCase(selected.id)} className="text-red-400 hover:text-red-300" title="Delete case file">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {items.length === 0 ? (
              <div className="text-center text-muted-foreground py-12">
                <p className="text-sm">No items in this case yet.</p>
                <p className="text-xs mt-2 opacity-70">
                  Open the Reports Library and click "Case" on any report to add it here.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {(['report', 'intel_report', 'entity', 'ioc', 'source'] as const).map((type) => {
                  const groupItems = itemsByType[type]
                  if (!groupItems || groupItems.length === 0) return null
                  const Icon = ITEM_ICON[type]
                  const colorClass = ITEM_COLOR[type]
                  const label = type === 'report' ? 'Reports'
                    : type === 'intel_report' ? 'Intel reports'
                    : type === 'entity' ? 'Entities'
                    : type === 'ioc' ? 'IOCs'
                    : 'Sources'
                  return (
                    <div key={type}>
                      <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                        <Icon className={`w-3.5 h-3.5 ${colorClass}`} />
                        <span>{label}</span>
                        <span className="text-[10px]">({groupItems.length})</span>
                      </div>
                      <div className="space-y-1">
                        {groupItems.map((item) => (
                          <div key={item.id} className="border border-border rounded px-3 py-2 flex items-start gap-3 hover:bg-accent/20 transition-colors group">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm truncate">{item.title || item.itemId}</div>
                              <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                                {item.summary && <span>{item.summary}</span>}
                                <span>·</span>
                                <span>added {formatTime(item.addedAt)}</span>
                              </div>
                              {item.notes && (
                                <div className="text-xs text-muted-foreground italic mt-1">"{item.notes}"</div>
                              )}
                            </div>
                            <button
                              onClick={() => removeItem(item.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-400"
                              title="Remove from case"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
