import { useState, useEffect, useCallback } from 'react'
import {
  Eye, Plus, Trash2, RefreshCw, Search, Bot, User,
  AlertTriangle, Target, Loader2, X, ToggleLeft, ToggleRight
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { toast } from 'sonner'
import { formatRelativeTime, cn } from '@renderer/lib/utils'

interface WatchTerm {
  id: string; term: string; source: 'manual' | 'agent' | 'action' | 'gap'
  sourceId: string | null; category: string | null; priority: string
  enabled: boolean; hits: number; lastHitAt: number | null
  createdAt: number; updatedAt: number
}

const SOURCE_CONFIG = {
  manual: { icon: User, color: 'text-blue-500', bg: 'bg-blue-500/10', label: 'Manual' },
  agent: { icon: Bot, color: 'text-violet-500', bg: 'bg-violet-500/10', label: 'Agent' },
  action: { icon: Target, color: 'text-green-500', bg: 'bg-green-500/10', label: 'From Action' },
  gap: { icon: AlertTriangle, color: 'text-amber-500', bg: 'bg-amber-500/10', label: 'From Gap' }
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-500', high: 'text-orange-500', medium: 'text-yellow-500', low: 'text-blue-500'
}

export function WatchPage() {
  const [terms, setTerms] = useState<WatchTerm[]>([])
  const [loading, setLoading] = useState(true)
  const [newTerm, setNewTerm] = useState('')
  const [newPriority, setNewPriority] = useState('medium')
  const [scanning, setScanning] = useState(false)
  const [filterSource, setFilterSource] = useState('all')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadTerms = async () => {
    setLoading(true)
    try { setTerms(await invoke('watch:getTerms') as WatchTerm[] || []) } catch {}
    setLoading(false)
  }

  useEffect(() => { loadTerms() }, [])

  const addTerm = async () => {
    if (!newTerm.trim()) return
    try {
      await invoke('watch:addTerm', { term: newTerm.trim(), priority: newPriority })
      toast.success(`Watch term added: "${newTerm.trim()}"`)
      setNewTerm('')
      loadTerms()
    } catch (err) { toast.error(String(err)) }
  }

  const toggleTerm = async (id: string, enabled: boolean) => {
    await invoke('watch:toggleTerm', { id, enabled })
    setTerms((prev) => prev.map((t) => t.id === id ? { ...t, enabled } : t))
  }

  const removeTerm = async (id: string) => {
    await invoke('watch:removeTerm', { id })
    setTerms((prev) => prev.filter((t) => t.id !== id))
    toast.info('Watch term removed')
  }

  const scanNow = async () => {
    setScanning(true)
    try {
      const results = await invoke('watch:scan') as Array<{ termId: string; term: string; matchCount: number }>
      if (results.length > 0) {
        toast.success(`${results.length} terms matched new intel`, {
          description: results.slice(0, 3).map((r) => `"${r.term}" (${r.matchCount} hits)`).join(', ')
        })
      } else {
        toast.info('No new matches found')
      }
      loadTerms()
    } catch (err) { toast.error(String(err)) }
    setScanning(false)
  }

  const filtered = filterSource === 'all' ? terms : terms.filter((t) => t.source === filterSource)
  const manualCount = terms.filter((t) => t.source === 'manual').length
  const agentCount = terms.filter((t) => t.source !== 'manual').length
  const enabledCount = terms.filter((t) => t.enabled).length

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Eye className="h-6 w-6 text-primary" /> Watch Terms
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Targeted search terms for intelligence collection. Auto-extracted from recommended actions and gaps.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={scanNow} disabled={scanning}>
            {scanning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
            Scan Now
          </Button>
          <Button variant="outline" size="sm" onClick={loadTerms}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total Terms</p>
          <p className="text-2xl font-bold">{terms.length}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Active</p>
          <p className="text-2xl font-bold text-green-500">{enabledCount}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><User className="h-3 w-3" />Manual</p>
          <p className="text-2xl font-bold text-blue-500">{manualCount}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Bot className="h-3 w-3" />Agent-Added</p>
          <p className="text-2xl font-bold text-violet-500">{agentCount}</p>
        </CardContent></Card>
      </div>

      {/* Add term */}
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-2">
            <Input value={newTerm} onChange={(e) => setNewTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTerm()}
              placeholder="Add a watch term..." className="flex-1" />
            <Select value={newPriority} onValueChange={setNewPriority}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={addTerm} disabled={!newTerm.trim()}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Filter */}
      <div className="flex gap-1">
        {[{ key: 'all', label: 'All' }, ...Object.entries(SOURCE_CONFIG).map(([k, v]) => ({ key: k, label: v.label }))].map(({ key, label }) => (
          <Button key={key} variant={filterSource === key ? 'default' : 'outline'} size="sm" className="text-xs"
            onClick={() => setFilterSource(key)}>
            {label}
          </Button>
        ))}
      </div>

      {/* Terms list */}
      <Card>
        <CardContent className="p-0">
          {filtered.length > 0 ? (
            <div className="divide-y divide-border">
              {filtered.map((term) => {
                const srcCfg = SOURCE_CONFIG[term.source] || SOURCE_CONFIG.manual
                const SrcIcon = srcCfg.icon
                return (
                  <div key={term.id} className={cn('flex items-center gap-3 px-4 py-3', !term.enabled && 'opacity-50')}>
                    {/* Source icon */}
                    <div className={cn('p-1.5 rounded', srcCfg.bg)}>
                      <SrcIcon className={cn('h-3.5 w-3.5', srcCfg.color)} />
                    </div>

                    {/* Term */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{term.term}</span>
                        <Badge variant="outline" className={cn('text-[9px] py-0', PRIORITY_COLORS[term.priority])}>{term.priority}</Badge>
                        <Badge variant="secondary" className="text-[9px] py-0">{srcCfg.label}</Badge>
                        {term.category && <Badge variant="outline" className="text-[9px] py-0">{term.category}</Badge>}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground">
                        <span>{term.hits} hits</span>
                        {term.lastHitAt && <span>Last: {formatRelativeTime(term.lastHitAt)}</span>}
                        <span>Added: {formatRelativeTime(term.createdAt)}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <Switch checked={term.enabled} onCheckedChange={(v) => toggleTerm(term.id, v)} />
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeTerm(term.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <Eye className="mx-auto h-10 w-10 opacity-30 mb-3" />
              <p className="text-sm">No watch terms yet</p>
              <p className="text-xs mt-1">Add terms manually or they'll be auto-extracted from recommended actions</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
