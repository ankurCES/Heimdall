import { useState, useEffect, useCallback } from 'react'
import { Plus, X, Tag, Shield, Search, Moon } from 'lucide-react'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'

interface PickerItem {
  type: 'tag' | 'entity'
  value: string
  count?: number
}

/** Friendly group label for darkweb tag prefixes. */
function darkwebGroupOf(tag: string): string {
  if (tag.startsWith('actor:'))       return 'Threat actors'
  if (tag.startsWith('marketplace:')) return 'Marketplaces'
  if (tag.startsWith('victim:'))      return 'Victims'
  if (tag.startsWith('darkweb:'))     return 'Activity types'
  if (tag.startsWith('tech:'))        return 'Tech / CVEs'
  if (tag.startsWith('ioc:'))         return 'IOC types'
  if (tag.startsWith('lang:'))        return 'Language'
  return 'Other'
}

interface TagEntityPickerProps {
  selected: PickerItem[]
  onSelectionChange: (items: PickerItem[]) => void
}

export function TagEntityPicker({ selected, onSelectionChange }: TagEntityPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([])
  const [entities, setEntities] = useState<Array<{ type: string; value: string; count: number }>>([])
  const [darkwebTags, setDarkwebTags] = useState<Array<{ tag: string; count: number }>>([])
  const [activeTab, setActiveTab] = useState<'tags' | 'entities' | 'darkweb'>('tags')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    if (open) {
      loadData()
    }
  }, [open])

  const loadData = async () => {
    try {
      const [t, e, dw] = await Promise.all([
        invoke('enrichment:getTopTags', { limit: 50 }),
        invoke('enrichment:getTopEntities', { limit: 50 }),
        invoke('darkweb:tags_for_picker', { limit: 60 }).catch(() => [])
      ])
      setTags((t as any) || [])
      setEntities((e as any) || [])
      setDarkwebTags((dw as any) || [])
    } catch {}
  }

  const addItem = (item: PickerItem) => {
    if (!selected.find((s) => s.type === item.type && s.value === item.value)) {
      onSelectionChange([...selected, item])
    }
  }

  const removeItem = (item: PickerItem) => {
    onSelectionChange(selected.filter((s) => !(s.type === item.type && s.value === item.value)))
  }

  const filteredTags = tags.filter((t) => !search || t.tag.toLowerCase().includes(search.toLowerCase()))
  const filteredEntities = entities.filter((e) => !search || e.value.toLowerCase().includes(search.toLowerCase()))
  const filteredDarkweb = darkwebTags.filter((t) => !search || t.tag.toLowerCase().includes(search.toLowerCase()))

  // Group darkweb tags by prefix for visual scanning.
  const darkwebGrouped: Record<string, Array<{ tag: string; count: number }>> = {}
  for (const t of filteredDarkweb) {
    const g = darkwebGroupOf(t.tag)
    ;(darkwebGrouped[g] = darkwebGrouped[g] || []).push(t)
  }
  const darkwebGroupOrder = ['Threat actors', 'Activity types', 'Marketplaces', 'Victims', 'Tech / CVEs', 'IOC types', 'Language', 'Other']

  return (
    <div className="relative">
      {/* Selected pills */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selected.map((item) => (
            <Badge
              key={`${item.type}:${item.value}`}
              variant={item.type === 'tag' ? 'default' : 'secondary'}
              className="gap-1 text-[10px] py-0 pl-1.5 pr-0.5 cursor-pointer"
            >
              {item.type === 'tag' ? <Tag className="h-2.5 w-2.5" /> : <Shield className="h-2.5 w-2.5" />}
              {item.value}
              <button onClick={() => removeItem(item)} className="ml-0.5 hover:text-destructive p-0.5">
                <X className="h-2.5 w-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors',
          open ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:border-foreground'
        )}
      >
        <Plus className="h-3 w-3" />
        {selected.length > 0 ? `${selected.length} filters` : 'Add tags/entities'}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-72 bg-card border border-border rounded-lg shadow-xl z-50 max-h-64 flex flex-col">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className="pl-7 h-7 text-xs" />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border">
            <button onClick={() => setActiveTab('tags')} className={cn('flex-1 px-3 py-1.5 text-xs', activeTab === 'tags' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground')}>Tags ({filteredTags.length})</button>
            <button onClick={() => setActiveTab('entities')} className={cn('flex-1 px-3 py-1.5 text-xs', activeTab === 'entities' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground')}>Entities ({filteredEntities.length})</button>
            <button onClick={() => setActiveTab('darkweb')} className={cn('flex-1 px-3 py-1.5 text-xs flex items-center justify-center gap-1', activeTab === 'darkweb' ? 'border-b-2 border-fuchsia-400 text-fuchsia-300' : 'text-muted-foreground')}>
              <Moon className="h-3 w-3" /> Dark Web ({filteredDarkweb.length})
            </button>
          </div>

          {/* Items */}
          <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
            {activeTab === 'tags' && filteredTags.map((t) => {
              const isSelected = selected.some((s) => s.type === 'tag' && s.value === t.tag)
              return (
                <button key={t.tag} onClick={() => isSelected ? removeItem({ type: 'tag', value: t.tag }) : addItem({ type: 'tag', value: t.tag })}
                  className={cn('w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-accent transition-colors', isSelected && 'bg-primary/10 text-primary')}>
                  <span className="flex items-center gap-1.5"><Tag className="h-3 w-3" />{t.tag}</span>
                  <span className="text-muted-foreground">{t.count}</span>
                </button>
              )
            })}
            {activeTab === 'entities' && filteredEntities.map((e) => {
              const isSelected = selected.some((s) => s.type === 'entity' && s.value === e.value)
              return (
                <button key={`${e.type}:${e.value}`} onClick={() => isSelected ? removeItem({ type: 'entity', value: e.value }) : addItem({ type: 'entity', value: e.value })}
                  className={cn('w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-accent transition-colors', isSelected && 'bg-primary/10 text-primary')}>
                  <span className="flex items-center gap-1.5"><Shield className="h-3 w-3" /><span className="text-muted-foreground text-[9px]">{e.type}:</span>{e.value}</span>
                  <span className="text-muted-foreground">{e.count}</span>
                </button>
              )
            })}
            {activeTab === 'darkweb' && (
              filteredDarkweb.length === 0 ? (
                <p className="text-[10px] text-muted-foreground text-center py-3 italic">
                  No dark-web tags yet. Run a sweep on the Dark Web → Explorer tab to populate.
                </p>
              ) : (
                darkwebGroupOrder.filter((g) => darkwebGrouped[g]).map((group) => (
                  <div key={group} className="mb-1">
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 px-2 py-1 font-semibold">{group}</div>
                    {darkwebGrouped[group].map((t) => {
                      const isSelected = selected.some((s) => s.type === 'tag' && s.value === t.tag)
                      // Strip the prefix in display so the picker is scannable.
                      const display = t.tag.replace(/^[a-z]+:/, '')
                      return (
                        <button key={t.tag} onClick={() => isSelected ? removeItem({ type: 'tag', value: t.tag }) : addItem({ type: 'tag', value: t.tag })}
                          className={cn(
                            'w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-fuchsia-500/10 transition-colors',
                            isSelected && 'bg-fuchsia-500/15 text-fuchsia-200'
                          )}>
                          <span className="flex items-center gap-1.5 truncate">
                            <Moon className="h-3 w-3 text-fuchsia-300/70 shrink-0" />
                            {display}
                          </span>
                          <span className="text-muted-foreground shrink-0">{t.count}</span>
                        </button>
                      )
                    })}
                  </div>
                ))
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
