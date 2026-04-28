// AssumptionsPage — v1.9.4 Key Assumptions Check workspace.
//
// Master/detail. Left rail: every check with its parent kind + a
// traffic-light status summary. Right pane: the assumption list with
// per-row status pills + inline rationale; analyst can add, edit,
// re-grade, and delete items, plus run an LLM extraction against the
// parent artifact when the check is bound to one.

import { useEffect, useState, useCallback } from 'react'
import {
  CheckCircle2, AlertTriangle, HelpCircle, AlertOctagon,
  ListTodo, Plus, Loader2, AlertCircle, Trash2, Edit3, Sparkles, Target,
  ListChecks, Scale, History as HistoryIcon, ScrollText
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { promptDialog } from '@renderer/components/PromptDialog'
import { cn, formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'

type ParentKind = 'hypothesis' | 'comparison' | 'chronology' | 'briefing' | null
type ItemStatus = 'well_supported' | 'supported_caveats' | 'unsupported' | 'vulnerable'

interface AssumptionItem {
  id: string
  check_id: string
  assumption_text: string
  status: ItemStatus
  rationale: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

interface AssumptionCheck {
  id: string
  name: string
  context: string | null
  parent_kind: ParentKind
  parent_id: string | null
  parent_label: string | null
  created_at: number
  updated_at: number
  items: AssumptionItem[]
  counts: Record<ItemStatus, number>
}

const STATUS_META: Record<ItemStatus, { label: string; icon: typeof CheckCircle2; color: string; bg: string }> = {
  well_supported:    { label: 'Well-supported',    icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/15' },
  supported_caveats: { label: 'With caveats',      icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400',    bg: 'bg-amber-500/15' },
  unsupported:       { label: 'Unsupported',       icon: HelpCircle,    color: 'text-muted-foreground',                  bg: 'bg-muted/30' },
  vulnerable:        { label: 'Vulnerable',        icon: AlertOctagon,  color: 'text-red-600 dark:text-red-400',         bg: 'bg-red-500/15' }
}

const PARENT_META: Record<NonNullable<ParentKind> | 'free', { label: string; icon: typeof ListChecks }> = {
  hypothesis: { label: 'Hypothesis', icon: ListChecks },
  comparison: { label: 'Comparison', icon: Scale },
  chronology: { label: 'Chronology', icon: HistoryIcon },
  briefing:   { label: 'Briefing',   icon: ScrollText },
  free:       { label: 'Standalone', icon: Target }
}

function StatusPill({ status, onChange }: { status: ItemStatus; onChange?: (s: ItemStatus) => void }) {
  const m = STATUS_META[status]
  const Icon = m.icon
  if (!onChange) {
    return (
      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium inline-flex items-center gap-1', m.bg, m.color)}>
        <Icon className="h-3 w-3" />{m.label}
      </span>
    )
  }
  return (
    <select
      value={status}
      onChange={(e) => onChange(e.target.value as ItemStatus)}
      className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium border-0 outline-none cursor-pointer', m.bg, m.color)}
    >
      {Object.entries(STATUS_META).map(([k, v]) => (
        <option key={k} value={k}>{v.label}</option>
      ))}
    </select>
  )
}

export function AssumptionsPage() {
  const [list, setList] = useState<AssumptionCheck[]>([])
  const [selected, setSelected] = useState<AssumptionCheck | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    try {
      const rows = await window.heimdall.invoke('kac:list') as AssumptionCheck[]
      setList(rows)
      if (selected) {
        const refreshed = rows.find((r) => r.id === selected.id) || null
        setSelected(refreshed)
      }
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selected?.id])

  useEffect(() => { loadList() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNew = useCallback(async () => {
    const name = await promptDialog({
      label: 'Check name',
      placeholder: 'e.g. "Russia Ukraine 2026 ops" assumptions',
      validate: (v) => v.trim().length < 3 ? 'At least 3 chars' : null
    })
    if (!name) return
    const context = await promptDialog({
      label: 'What analysis are you stress-testing? (optional)',
      multiline: true
    })
    setBusy(true)
    try {
      const created = await window.heimdall.invoke('kac:create', { name, context }) as AssumptionCheck
      await loadList()
      setSelected(created)
    } catch (e) {
      toast.error('Create failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [loadList])

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this assumption check and all its items?')) return
    setBusy(true)
    try {
      await window.heimdall.invoke('kac:delete', id)
      if (selected?.id === id) setSelected(null)
      await loadList()
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected?.id, loadList])

  const handleRename = useCallback(async (c: AssumptionCheck) => {
    const name = await promptDialog({
      label: 'Rename check',
      initialValue: c.name,
      validate: (v) => v.trim().length < 3 ? 'At least 3 chars' : null
    })
    if (!name || name === c.name) return
    setBusy(true)
    try {
      await window.heimdall.invoke('kac:update', { id: c.id, patch: { name } })
      await loadList()
    } catch (e) {
      toast.error('Rename failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [loadList])

  const handleAddItem = useCallback(async () => {
    if (!selected) return
    const text = await promptDialog({
      label: 'Assumption (atomic, falsifiable)',
      placeholder: 'e.g. "Sanctions enforcement remains at current intensity"',
      validate: (v) => v.trim().length < 8 ? 'Too short' : null
    })
    if (!text) return
    const rationale = await promptDialog({
      label: 'Why is this an assumption (optional)',
      multiline: true
    })
    setBusy(true)
    try {
      await window.heimdall.invoke('kac:add_item', {
        checkId: selected.id,
        assumption_text: text,
        rationale,
        status: 'unsupported'
      })
      await loadList()
    } catch (e) {
      toast.error('Add failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, loadList])

  const handleUpdateItem = useCallback(async (
    item: AssumptionItem,
    patch: { assumption_text?: string; status?: ItemStatus; rationale?: string | null }
  ) => {
    try {
      await window.heimdall.invoke('kac:update_item', { itemId: item.id, patch })
      await loadList()
    } catch (e) {
      toast.error('Update failed: ' + (e as Error).message)
    }
  }, [loadList])

  const handleEditItem = useCallback(async (item: AssumptionItem) => {
    const text = await promptDialog({
      label: 'Edit assumption',
      initialValue: item.assumption_text,
      validate: (v) => v.trim().length < 8 ? 'Too short' : null
    })
    if (!text) return
    const rationale = await promptDialog({
      label: 'Edit rationale',
      initialValue: item.rationale || '',
      multiline: true
    })
    await handleUpdateItem(item, { assumption_text: text, rationale })
  }, [handleUpdateItem])

  const handleRemoveItem = useCallback(async (itemId: string) => {
    if (!confirm('Remove this assumption?')) return
    try {
      await window.heimdall.invoke('kac:remove_item', itemId)
      await loadList()
    } catch (e) {
      toast.error('Remove failed: ' + (e as Error).message)
    }
  }, [loadList])

  const handleExtract = useCallback(async () => {
    if (!selected) return
    if (!selected.parent_kind || !selected.parent_id) {
      toast.error('No parent artifact bound — extract is unavailable. Add assumptions manually.')
      return
    }
    setBusy(true)
    try {
      const r = await window.heimdall.invoke('kac:extract_from_parent', selected.id) as { added: number }
      toast.success(`Extracted ${r.added} candidate assumption${r.added === 1 ? '' : 's'} from the parent`)
      await loadList()
    } catch (e) {
      toast.error('Extract failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, loadList])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left rail */}
      <div className="w-80 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Assumptions</span>
          </div>
          <Button size="sm" variant="ghost" onClick={handleNew} disabled={busy} title="New assumption check">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 p-3 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 mt-0.5" /> {error}
            </div>
          )}
          {!loading && !error && list.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">
              No assumption checks yet. Click <Plus className="inline h-3 w-3" /> to start.
              You can also bind one to an existing analytical artifact via "Run KAC" buttons elsewhere.
            </div>
          )}
          {list.map((c) => {
            const meta = c.parent_kind ? PARENT_META[c.parent_kind] : PARENT_META.free
            const Icon = meta.icon
            const total = c.items.length
            return (
              <button
                key={c.id}
                onClick={() => setSelected(c)}
                className={cn(
                  'w-full text-left rounded-md p-2.5 transition-colors',
                  selected?.id === c.id ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-accent'
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{meta.label}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{total} items</span>
                </div>
                <div className="text-sm font-medium truncate">{c.name}</div>
                {c.parent_label && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground truncate">↳ {c.parent_label}</div>
                )}
                {total > 0 && (
                  <div className="mt-1 flex h-1.5 rounded-full overflow-hidden bg-muted">
                    {(['well_supported', 'supported_caveats', 'unsupported', 'vulnerable'] as ItemStatus[]).map((s) => {
                      const pct = (c.counts[s] / total) * 100
                      if (pct === 0) return null
                      const m = STATUS_META[s]
                      const colorBg = s === 'well_supported' ? 'bg-emerald-500'
                                    : s === 'supported_caveats' ? 'bg-amber-500'
                                    : s === 'unsupported' ? 'bg-muted-foreground/40'
                                    : 'bg-red-500'
                      return <div key={s} title={`${m.label}: ${c.counts[s]}`} className={colorBg} style={{ width: `${pct}%` }} />
                    })}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-muted-foreground">{formatRelativeTime(c.updated_at)}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex-1 overflow-y-auto">
        {!selected && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a check to grade its assumptions.
          </div>
        )}
        {selected && (
          <div className="p-6 max-w-4xl mx-auto">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <ListTodo className="h-5 w-5 text-primary" />
                      {selected.name}
                    </CardTitle>
                    {selected.parent_label && (
                      <CardDescription className="mt-1 text-xs">
                        Linked to {selected.parent_kind}: <strong>{selected.parent_label}</strong>
                      </CardDescription>
                    )}
                    {selected.context && (
                      <CardDescription className="mt-1 italic">{selected.context}</CardDescription>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {selected.parent_kind && selected.parent_id && (
                      <Button size="sm" variant="outline" onClick={handleExtract} disabled={busy} title="LLM extracts candidate assumptions from the parent artifact">
                        <Sparkles className="h-3.5 w-3.5 mr-1" /> Extract
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => handleRename(selected)} disabled={busy} title="Rename">
                      <Edit3 className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(selected.id)} disabled={busy} title="Delete">
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-medium">Assumptions ({selected.items.length})</div>
                  <Button size="sm" onClick={handleAddItem} disabled={busy}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add assumption
                  </Button>
                </div>

                {selected.items.length === 0 && (
                  <div className="text-sm text-muted-foreground p-6 text-center border border-dashed rounded-md">
                    No assumptions yet. Add manually or use Extract (if linked to a parent).
                  </div>
                )}

                <div className="space-y-2">
                  {selected.items.map((item, idx) => (
                    <div key={item.id} className="group rounded-md border border-border bg-card p-3 hover:border-primary/40 transition-colors">
                      <div className="flex items-start gap-3">
                        <span className="text-xs font-mono text-muted-foreground w-6 shrink-0 pt-0.5">#{idx + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start gap-2 flex-wrap">
                            <div className="text-sm flex-1 min-w-0">{item.assumption_text}</div>
                            <StatusPill status={item.status} onChange={(s) => handleUpdateItem(item, { status: s })} />
                          </div>
                          {item.rationale && (
                            <div className="mt-1 text-xs text-muted-foreground italic">↳ {item.rationale}</div>
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button size="sm" variant="ghost" onClick={() => handleEditItem(item)} title="Edit"><Edit3 className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => handleRemoveItem(item.id)} title="Remove"><Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" /></Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Summary tally */}
                {selected.items.length > 0 && (
                  <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
                    {(['well_supported', 'supported_caveats', 'unsupported', 'vulnerable'] as ItemStatus[]).map((s) => {
                      const m = STATUS_META[s]
                      return (
                        <div key={s} className={cn('rounded-md p-2 border border-border', m.bg)}>
                          <div className={cn('text-[10px] uppercase tracking-wide', m.color)}>{m.label}</div>
                          <div className="text-lg font-semibold">{selected.counts[s]}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
