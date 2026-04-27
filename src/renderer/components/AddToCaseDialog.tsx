import { useEffect, useState } from 'react'
import { FolderOpen, Plus, Check, Loader2, X, FolderPlus } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { toast } from 'sonner'

/**
 * Modal dialog for adding an arbitrary item (report / intel_report /
 * entity / ioc / source) to one or more case files. Supports inline
 * creation of a new case if needed.
 *
 * Used from the Library drawer (Add to Case button) — and Phase 1.1.7
 * will reuse it from the entity / IOC pages.
 */

interface CaseFile {
  id: string
  name: string
  status: 'open' | 'dormant' | 'closed'
  itemCount: number
}

interface Props {
  open: boolean
  onClose: () => void
  itemType: 'report' | 'intel_report' | 'entity' | 'ioc' | 'source'
  itemId: string
  itemTitle: string
}

export function AddToCaseDialog({ open, onClose, itemType, itemId, itemTitle }: Props) {
  const [cases, setCases] = useState<CaseFile[]>([])
  const [containing, setContaining] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!open) return
    (async () => {
      setLoading(true)
      try {
        const [list, contain] = await Promise.all([
          window.heimdall.invoke('cases:list', { status: ['open', 'dormant'] }) as Promise<{ ok: boolean; cases: CaseFile[] }>,
          window.heimdall.invoke('cases:containing', { itemType, itemId }) as Promise<{ ok: boolean; cases: CaseFile[] }>
        ])
        if (list.ok) setCases(list.cases || [])
        if (contain.ok) setContaining(new Set((contain.cases || []).map((c) => c.id)))
      } catch (err) { console.warn(err) }
      setLoading(false)
    })()
  }, [open, itemType, itemId])

  const addToCase = async (caseFileId: string) => {
    setAdding(caseFileId)
    try {
      const r = await window.heimdall.invoke('cases:add_item', {
        caseFileId, itemType, itemId
      }) as { ok: boolean; reason?: string }
      if (r.ok) {
        setContaining((prev) => new Set([...prev, caseFileId]))
        toast.success('Added to case')
      } else {
        toast.error('Add failed', { description: r.reason })
      }
    } catch (err) {
      toast.error('Add failed', { description: String(err) })
    } finally {
      setAdding(null)
    }
  }

  const createAndAdd = async () => {
    if (!newName.trim()) { toast.error('Name required'); return }
    try {
      const r = await window.heimdall.invoke('cases:create', { name: newName.trim() }) as
        { ok: boolean; case?: CaseFile; error?: string }
      if (!r.ok || !r.case) {
        toast.error('Create failed', { description: r.error })
        return
      }
      setCases((prev) => [r.case!, ...prev])
      await addToCase(r.case.id)
      setNewName('')
      setCreating(false)
    } catch (err) {
      toast.error('Create failed', { description: String(err) })
    }
  }

  if (!open) return null

  const filtered = filter
    ? cases.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : cases

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-lg mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-amber-400" /> Add to Case File
            </h2>
            <p className="text-xs text-muted-foreground mt-1 truncate max-w-md" title={itemTitle}>
              {itemType.replace('_', ' ')}: {itemTitle}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <Input
              placeholder="Filter cases…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="mb-3"
            />

            <div className="border border-border rounded max-h-72 overflow-y-auto divide-y divide-border">
              {filtered.length === 0 && !creating && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {cases.length === 0 ? 'No case files yet.' : 'No cases match your filter.'}
                </div>
              )}
              {filtered.map((c) => {
                const isContaining = containing.has(c.id)
                return (
                  <button
                    key={c.id}
                    onClick={() => !isContaining && addToCase(c.id)}
                    disabled={isContaining}
                    className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                      isContaining ? 'bg-emerald-500/5 cursor-default' : 'hover:bg-accent'
                    }`}
                  >
                    <FolderOpen className={`w-4 h-4 ${isContaining ? 'text-emerald-400' : 'text-amber-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.itemCount} item{c.itemCount === 1 ? '' : 's'}</div>
                    </div>
                    <Badge variant="outline" className="text-[9px] capitalize">{c.status}</Badge>
                    {isContaining ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : adding === c.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                )
              })}
            </div>

            {/* Create new */}
            {creating ? (
              <div className="mt-3 flex gap-2">
                <Input
                  placeholder='New case name (e.g. "Operation Bluefin")'
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
                  autoFocus
                />
                <Button size="sm" onClick={createAndAdd}>
                  <FolderPlus className="w-4 h-4 mr-1" /> Create + Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName('') }}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreating(true)}
                className="mt-3 w-full"
              >
                <FolderPlus className="w-4 h-4 mr-2" /> Create new case file
              </Button>
            )}
          </>
        )}

        <div className="mt-4 flex justify-end">
          <Button onClick={onClose} variant="outline" size="sm">Done</Button>
        </div>
      </div>
    </div>
  )
}
