import { useState, useEffect, useMemo } from 'react'
import { X, Search, Sparkles, Wrench, Check, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import { ipc } from '@renderer/lib/ipc'
import { CustomSourceForm } from './SourceForm'

interface SourcePreset {
  id: string
  name: string
  discipline: string
  type: string
  category: string
  description: string
  config: Record<string, unknown>
  schedule: string
  url?: string
}

interface AddSourceModalProps {
  open: boolean
  onClose: () => void
  onAdded: () => void
}

export function AddSourceModal({ open, onClose, onAdded }: AddSourceModalProps) {
  const [tab, setTab] = useState<'presets' | 'custom'>('presets')
  const [presets, setPresets] = useState<SourcePreset[]>([])
  const [search, setSearch] = useState('')
  const [addingId, setAddingId] = useState<string | null>(null)
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    void window.heimdall.invoke('sources:listPresets').then((p: unknown) => setPresets(p as SourcePreset[]))
  }, [open])

  const filteredPresets = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return presets
    return presets.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.discipline.toLowerCase().includes(q)
    )
  }, [presets, search])

  const grouped = useMemo(() => {
    const map = new Map<string, SourcePreset[]>()
    for (const p of filteredPresets) {
      const list = map.get(p.category) || []
      list.push(p)
      map.set(p.category, list)
    }
    return map
  }, [filteredPresets])

  const handleAddPreset = async (preset: SourcePreset) => {
    setAddingId(preset.id)
    try {
      await ipc.sources.create({
        name: preset.name,
        discipline: preset.discipline as never,
        type: preset.type,
        config: preset.config,
        schedule: preset.schedule,
        enabled: true
      })
      setAddedIds((s) => new Set(s).add(preset.id))
      onAdded()
    } catch (err) {
      console.error('Failed to add preset:', err)
      alert(`Failed to add: ${err}`)
    } finally {
      setAddingId(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-card/50">
          <div>
            <h2 className="text-lg font-semibold">Add Intelligence Source</h2>
            <p className="text-xs text-muted-foreground">Browse presets or create a custom collector</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border bg-card/30">
          <button
            onClick={() => setTab('presets')}
            className={cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2',
              tab === 'presets' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Sparkles className="h-4 w-4" />
            Browse Presets ({presets.length})
          </button>
          <button
            onClick={() => setTab('custom')}
            className={cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2',
              tab === 'custom' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Wrench className="h-4 w-4" />
            Add Custom
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5">
          {tab === 'presets' && (
            <div className="space-y-4">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search presets by name, category, or description..."
                  className="pl-9"
                />
              </div>

              {/* Grouped presets */}
              {Array.from(grouped.entries()).map(([category, items]) => (
                <div key={category}>
                  <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{category} ({items.length})</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {items.map((p) => {
                      const isAdded = addedIds.has(p.id)
                      const isAdding = addingId === p.id
                      return (
                        <div key={p.id} className="border border-border rounded-md p-3 hover:bg-accent/30 transition-colors">
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">{p.name}</span>
                                <Badge variant="outline" className="text-[10px]">{p.discipline.toUpperCase()}</Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{p.description}</p>
                            </div>
                            <Button
                              size="sm"
                              variant={isAdded ? 'outline' : 'default'}
                              onClick={() => !isAdded && !isAdding && handleAddPreset(p)}
                              disabled={isAdded || isAdding}
                              className="shrink-0 h-7 px-3 text-xs"
                            >
                              {isAdding ? <Loader2 className="h-3 w-3 animate-spin" /> :
                               isAdded ? <><Check className="h-3 w-3 mr-1" />Added</> : 'Add'}
                            </Button>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <Badge variant="secondary" className="text-[10px]">{p.type}</Badge>
                            <span>•</span>
                            <span className="font-mono">{p.schedule}</span>
                            {p.url && <>
                              <span>•</span>
                              <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-primary inline-flex items-center gap-0.5"
                                 onClick={(e) => { e.preventDefault(); window.open(p.url, '_blank') }}>
                                source <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            </>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}

              {filteredPresets.length === 0 && (
                <p className="text-center text-sm text-muted-foreground py-8">No presets match your search.</p>
              )}
            </div>
          )}

          {tab === 'custom' && (
            <CustomSourceForm onSaved={() => { onAdded(); onClose() }} />
          )}
        </div>
      </div>
    </div>
  )
}
