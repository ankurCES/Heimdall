import { useState, useEffect } from 'react'
import { FilePlus2, Check, Loader2, X, Search } from 'lucide-react'
import { Card } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { toast } from 'sonner'

/**
 * Modal dialog for building an executive briefing from N reports.
 * Multi-select from a filtered library list, then click Build → save dialog.
 */

interface ReportListItem {
  id: string
  title: string
  format: string
  status: string
  generatedAt: number
  tradecraftScore: number | null
}

interface Props {
  open: boolean
  onClose: () => void
}

const FORMAT_LABELS: Record<string, string> = {
  nie: 'NIE', pdb: 'PDB', iir: 'IIR', assessment: 'Assessment'
}

function formatTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  if (delta < 7 * 86400_000) return `${Math.floor(delta / 86400_000)}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}

export function BriefingBuilderDialog({ open, onClose }: Props) {
  const [reports, setReports] = useState<ReportListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState('')
  const [recipient, setRecipient] = useState('')
  const [introNote, setIntroNote] = useState('')
  const [building, setBuilding] = useState(false)

  useEffect(() => {
    if (!open) return
    (async () => {
      setLoading(true)
      try {
        const r = await window.heimdall.invoke('reports:list', {
          status: ['published', 'draft'],
          orderBy: 'recent',
          limit: 200
        }) as { ok: boolean; reports?: ReportListItem[] }
        if (r.ok && r.reports) setReports(r.reports)
      } catch (err) { toast.error(String(err)) }
      setLoading(false)
    })()
  }, [open])

  const toggle = (id: string): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const build = async (): Promise<void> => {
    if (selected.size === 0) { toast.error('Pick at least one report'); return }
    if (!title.trim()) { toast.error('Briefing title required'); return }
    setBuilding(true)
    try {
      const r = await window.heimdall.invoke('briefing:build', {
        title: title.trim(),
        reportIds: Array.from(selected),
        recipient: recipient.trim() || undefined,
        introNote: introNote.trim() || undefined
      }) as { ok: boolean; path?: string; pageCount?: number; reportCount?: number; fingerprint?: string; error?: string }
      if (r.ok) {
        toast.success(`Briefing built (${r.pageCount}pp from ${r.reportCount} reports)`, {
          description: r.path?.split('/').pop() + (r.fingerprint ? ` · signed: ${r.fingerprint.slice(0, 9)}…` : '')
        })
        // Reset + close
        setSelected(new Set()); setTitle(''); setRecipient(''); setIntroNote('')
        onClose()
      } else if (r.error !== 'cancelled') {
        toast.error('Build failed', { description: r.error })
      }
    } catch (err) {
      toast.error('Build failed', { description: String(err) })
    }
    setBuilding(false)
  }

  if (!open) return null

  const filtered = filter
    ? reports.filter((r) => r.title.toLowerCase().includes(filter.toLowerCase()))
    : reports

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <FilePlus2 className="w-5 h-5 text-amber-400" /> Briefing Builder
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Pick reports → assemble into one IC-format PDF with rolled-up key judgments.
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Title + recipient */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="title">Briefing title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder='e.g. "Weekly Threat Briefing — Apr 2026"' />
            </div>
            <div>
              <Label htmlFor="recipient">Recipient (optional)</Label>
              <Input id="recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)}
                placeholder="e.g. Director, Operations" />
            </div>
          </div>
          <div>
            <Label htmlFor="intro">Intro note (optional)</Label>
            <textarea id="intro" value={introNote} onChange={(e) => setIntroNote(e.target.value)}
              rows={2} className="w-full text-sm bg-card border border-border rounded p-2"
              placeholder="Free-form paragraph that appears above the consolidated key judgments." />
          </div>

          {/* Report multi-select */}
          <div>
            <Label>Reports to include</Label>
            <div className="flex items-center gap-2 mt-1 mb-2">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" />
              {selected.size > 0 && (
                <Badge variant="outline" className="text-[10px]">{selected.size} selected</Badge>
              )}
            </div>
            <Card className="p-0 max-h-72 overflow-y-auto">
              {loading && <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin" /></div>}
              {!loading && filtered.length === 0 && (
                <p className="text-xs text-muted-foreground text-center p-4">No reports match.</p>
              )}
              {filtered.map((r) => {
                const isSelected = selected.has(r.id)
                return (
                  <button key={r.id} onClick={() => toggle(r.id)}
                    className={`w-full text-left px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent transition-colors flex items-start gap-3 ${isSelected ? 'bg-amber-500/5' : ''}`}>
                    <div className={`w-4 h-4 rounded border mt-0.5 flex items-center justify-center shrink-0 ${
                      isSelected ? 'bg-amber-400 border-amber-400' : 'border-border'
                    }`}>
                      {isSelected && <Check className="w-3 h-3 text-black" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{r.title}</div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                        <Badge variant="outline" className="text-[9px]">{FORMAT_LABELS[r.format] || r.format}</Badge>
                        <Badge variant="outline" className="text-[9px] capitalize">{r.status}</Badge>
                        {r.tradecraftScore !== null && <span className="font-mono">ICD: {r.tradecraftScore}/100</span>}
                        <span>·</span>
                        <span>{formatTime(r.generatedAt)}</span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </Card>
          </div>
        </div>

        <div className="border-t border-border p-4 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {selected.size > 0
              ? `Will assemble ${selected.size} report${selected.size === 1 ? '' : 's'} into a single PDF`
              : 'Select reports to enable the build action'}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={build} disabled={building || selected.size === 0 || !title.trim()}>
              {building ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Building…</> :
                <><FilePlus2 className="w-4 h-4 mr-2" /> Build briefing</>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
