import { useEffect, useState, useMemo, useCallback } from 'react'
import { Search, FileText, Filter, Loader2, X, Download, Send, Archive, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { AddToCaseDialog } from '@renderer/components/AddToCaseDialog'
import { toast } from 'sonner'

/**
 * Reports Library — first-class browseable list of every analyst product
 * Heimdall has produced. Backed by report_products + report_products_fts.
 *
 * UX:
 *   - Stats header (total / drafts / published / avg score / by-format)
 *   - Search bar (FTS5)
 *   - Format filter chips (NIE / PDB / IIR / Assessment)
 *   - Status filter chips (Draft / Published / Revised)
 *   - Sortable table on the left, detail drawer on the right
 *   - Click a row → drawer with full markdown render + version chain
 *
 * Phase 1.1.3 will add Export PDF/DOCX buttons. Phase 1.1.4 will add the
 * "Add to Case File" dropdown.
 */

interface ReportProduct {
  id: string
  sessionId: string | null
  parentReportId: string | null
  version: number
  title: string
  format: 'nie' | 'pdb' | 'iir' | 'assessment'
  classification: string
  query: string | null
  bodyMarkdown: string
  tradecraftScore: number | null
  tradecraftDeficiencies: string[]
  wasRegenerated: boolean
  modelUsed: string | null
  generatedAt: number
  status: 'draft' | 'published' | 'revised' | 'superseded'
  tags: string[]
  regionTags: string[]
  createdAt: number
}

interface LibraryStats {
  total: number
  drafts: number
  published: number
  revised: number
  avgScore: number | null
  byFormat: Record<string, number>
}

const FORMAT_LABELS: Record<string, string> = {
  nie: 'NIE',
  pdb: 'PDB Item',
  iir: 'IIR',
  assessment: 'Assessment'
}

const STATUS_COLORS: Record<string, string> = {
  draft:      'bg-amber-500/10 text-amber-300 border-amber-500/30',
  published:  'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  revised:    'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
  superseded: 'bg-slate-500/10 text-slate-400 border-slate-500/30'
}

function formatTime(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  if (delta < 7 * 86400_000) return `${Math.floor(delta / 86400_000)}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}

function scoreColor(score: number | null): string {
  if (score === null) return 'text-slate-500'
  if (score >= 70) return 'text-emerald-400'
  if (score >= 50) return 'text-amber-400'
  return 'text-red-400'
}

export function ReportsLibraryPage() {
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [reports, setReports] = useState<ReportProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [formatFilter, setFormatFilter] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<'recent' | 'score' | 'title'>('recent')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [versionChain, setVersionChain] = useState<ReportProduct[]>([])
  const [addToCaseOpen, setAddToCaseOpen] = useState(false)

  const loadStats = useCallback(async () => {
    try {
      const r = await window.heimdall.invoke('reports:stats') as
        { ok: boolean; total: number; drafts: number; published: number; revised: number; avgScore: number | null; byFormat: Record<string, number> }
      if (r.ok) setStats({ total: r.total, drafts: r.drafts, published: r.published, revised: r.revised, avgScore: r.avgScore, byFormat: r.byFormat })
    } catch (err) { console.warn('stats load failed:', err) }
  }, [])

  const loadReports = useCallback(async () => {
    setLoading(true)
    try {
      let r: { ok: boolean; reports?: ReportProduct[]; total?: number; error?: string }
      if (searchQuery.trim().length >= 2) {
        r = await window.heimdall.invoke('reports:search', { query: searchQuery, limit: 200 }) as typeof r
      } else {
        r = await window.heimdall.invoke('reports:list', {
          status: statusFilter.size > 0 ? Array.from(statusFilter) : undefined,
          format: formatFilter.size > 0 ? Array.from(formatFilter) : undefined,
          orderBy: sortBy,
          limit: 200
        }) as typeof r
      }
      if (r.ok && r.reports) setReports(r.reports)
      else { toast.error('Failed to load reports', { description: r.error }); setReports([]) }
    } catch (err) {
      toast.error('Failed to load reports', { description: String(err) })
      setReports([])
    } finally {
      setLoading(false)
    }
  }, [searchQuery, formatFilter, statusFilter, sortBy])

  useEffect(() => { loadStats() }, [loadStats])
  useEffect(() => { loadReports() }, [loadReports])

  // Apply client-side format/status filters when search is active (since the
  // search endpoint doesn't accept them).
  const filteredReports = useMemo(() => {
    if (searchQuery.trim().length < 2) return reports
    return reports.filter((r) => {
      if (formatFilter.size > 0 && !formatFilter.has(r.format)) return false
      if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false
      return true
    })
  }, [reports, searchQuery, formatFilter, statusFilter])

  const selected = useMemo(
    () => filteredReports.find((r) => r.id === selectedId) ?? null,
    [filteredReports, selectedId]
  )

  // Load version chain when selection changes
  useEffect(() => {
    if (!selectedId) { setVersionChain([]); return }
    (async () => {
      try {
        const r = await window.heimdall.invoke('reports:version_chain', selectedId) as { ok: boolean; chain?: ReportProduct[] }
        if (r.ok && r.chain) setVersionChain(r.chain)
      } catch (err) { console.warn('chain load failed:', err) }
    })()
  }, [selectedId])

  const toggle = (set: Set<string>, value: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }

  const publish = async (id: string) => {
    const r = await window.heimdall.invoke('reports:publish', id) as { ok: boolean; error?: string }
    if (r.ok) {
      toast.success('Report published')
      loadReports(); loadStats()
    } else {
      toast.error('Publish failed', { description: r.error })
    }
  }

  const exportPdf = async (id: string) => {
    toast.info('Generating PDF…')
    try {
      const r = await window.heimdall.invoke('reports:export_pdf', { reportId: id }) as
        { ok: boolean; path?: string; pageCount?: number; sha256?: string; fingerprint?: string; error?: string }
      if (r.ok && r.path) {
        toast.success(`PDF exported (${r.pageCount}pp)`, {
          description: r.path.split('/').pop() + (r.fingerprint ? ` · signed: ${r.fingerprint.slice(0, 9)}…` : '')
        })
      } else if (r.error === 'cancelled') {
        // user cancelled save dialog — silent
      } else {
        toast.error('Export failed', { description: r.error })
      }
    } catch (err) {
      toast.error('Export failed', { description: String(err) })
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this report? This is permanent.')) return
    const r = await window.heimdall.invoke('reports:delete', id) as { ok: boolean }
    if (r.ok) {
      toast.success('Report deleted')
      if (selectedId === id) setSelectedId(null)
      loadReports(); loadStats()
    }
  }

  return (
    <div className="flex h-full">
      {/* LEFT: list + filters */}
      <div className={`${selectedId ? 'w-1/2' : 'w-full'} flex flex-col border-r border-border transition-all`}>
        {/* Header */}
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center gap-3 mb-3">
            <FileText className="w-6 h-6 text-cyan-400" />
            <div>
              <h1 className="text-xl font-semibold">Reports Library</h1>
              <p className="text-xs text-muted-foreground">
                Every analyst product Heimdall has produced — searchable, filterable, versioned.
              </p>
            </div>
          </div>

          {/* Stat tiles */}
          {stats && (
            <div className="grid grid-cols-5 gap-2 text-xs">
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Total</div>
                <div className="text-xl font-semibold">{stats.total.toLocaleString()}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Drafts</div>
                <div className="text-xl font-semibold text-amber-300">{stats.drafts}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Published</div>
                <div className="text-xl font-semibold text-emerald-300">{stats.published}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Revised</div>
                <div className="text-xl font-semibold text-cyan-300">{stats.revised}</div>
              </div>
              <div className="border border-border rounded px-3 py-2">
                <div className="text-muted-foreground">Avg Score</div>
                <div className={`text-xl font-semibold ${scoreColor(stats.avgScore)}`}>
                  {stats.avgScore !== null ? `${stats.avgScore}/100` : '—'}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Search + filters */}
        <div className="border-b border-border px-6 py-3 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search reports… (FTS5: 'lockbit ransomware', 'china taiwan', etc.)"
              className="pl-9"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground"><Filter className="w-3 h-3 inline mr-1" />Format:</span>
            {(['nie', 'pdb', 'iir', 'assessment'] as const).map((f) => (
              <button
                key={f}
                onClick={() => toggle(formatFilter, f, setFormatFilter)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  formatFilter.has(f)
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                {FORMAT_LABELS[f]}{stats?.byFormat[f] ? ` · ${stats.byFormat[f]}` : ''}
              </button>
            ))}
            <span className="ml-3 text-[10px] text-muted-foreground">Status:</span>
            {(['draft', 'published', 'revised'] as const).map((s) => (
              <button
                key={s}
                onClick={() => toggle(statusFilter, s, setStatusFilter)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors capitalize ${
                  statusFilter.has(s)
                    ? STATUS_COLORS[s]
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                {s}
              </button>
            ))}
            <span className="ml-3 text-[10px] text-muted-foreground">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="bg-transparent border border-border rounded px-2 py-0.5 text-[10px] text-foreground cursor-pointer"
            >
              <option value="recent">Recent</option>
              <option value="score">Tradecraft score</option>
              <option value="title">Title</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && filteredReports.length === 0 && (
            <div className="text-center py-16 px-6 text-muted-foreground">
              <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No reports match your filters.</p>
              <p className="text-xs mt-2 opacity-70">
                Generate a report from chat or trigger the promotion migration to see existing reports here.
              </p>
            </div>
          )}
          {!loading && filteredReports.length > 0 && (
            <div className="divide-y divide-border">
              {filteredReports.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                  className={`w-full text-left px-6 py-3 hover:bg-accent/30 transition-colors flex items-start gap-3 ${
                    selectedId === r.id ? 'bg-accent/40 border-l-2 border-l-cyan-400' : ''
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate">{r.title}</span>
                      {r.version > 1 && (
                        <Badge variant="outline" className="text-[9px]">v{r.version}</Badge>
                      )}
                      {r.wasRegenerated && (
                        <Badge variant="outline" className="text-[9px] text-cyan-400 border-cyan-400/40">regen</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[9px] uppercase">{FORMAT_LABELS[r.format]}</Badge>
                      <Badge variant="outline" className={`text-[9px] capitalize ${STATUS_COLORS[r.status]}`}>{r.status}</Badge>
                      <span className={`font-mono ${scoreColor(r.tradecraftScore)}`}>
                        {r.tradecraftScore !== null ? `${r.tradecraftScore}/100` : '—'}
                      </span>
                      <span>·</span>
                      <span>{formatTime(r.generatedAt)}</span>
                      {r.tags.length > 0 && (
                        <>
                          <span>·</span>
                          {r.tags.slice(0, 2).map((t) => (
                            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
                              {t.length > 20 ? t.slice(0, 20) + '…' : t}
                            </span>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer count */}
        <div className="border-t border-border px-6 py-2 text-xs text-muted-foreground">
          {filteredReports.length.toLocaleString()} report{filteredReports.length === 1 ? '' : 's'}
          {searchQuery && ` matching "${searchQuery}"`}
        </div>
      </div>

      {/* RIGHT: detail drawer */}
      {selected && (
        <div className="w-1/2 flex flex-col">
          <div className="border-b border-border px-6 py-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-muted-foreground mb-1 font-mono">
                {selected.classification}
              </div>
              <h2 className="text-lg font-semibold truncate">{selected.title}</h2>
              <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="text-[10px] uppercase">{FORMAT_LABELS[selected.format]}</Badge>
                <Badge variant="outline" className={`text-[10px] capitalize ${STATUS_COLORS[selected.status]}`}>{selected.status}</Badge>
                <span className={`font-mono ${scoreColor(selected.tradecraftScore)}`}>
                  ICD 203: {selected.tradecraftScore !== null ? `${selected.tradecraftScore}/100` : '—'}
                </span>
                <span>·</span>
                <span>{new Date(selected.generatedAt).toLocaleString()}</span>
              </div>
              {versionChain.length > 1 && (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Version history: {versionChain.map((v, i) => (
                    <button
                      key={v.id}
                      onClick={() => setSelectedId(v.id)}
                      className={`mx-1 px-1.5 py-0.5 rounded ${v.id === selected.id ? 'bg-cyan-500/20 text-cyan-200' : 'hover:bg-accent'}`}
                    >
                      v{v.version}{i < versionChain.length - 1 ? ' →' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {selected.status === 'draft' && (
                <Button size="sm" variant="default" onClick={() => publish(selected.id)} title="Publish">
                  <Send className="w-3.5 h-3.5 mr-1" /> Publish
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => exportPdf(selected.id)} title="Export as IC-format PDF with classification banners + signature">
                <Download className="w-3.5 h-3.5 mr-1" /> PDF
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAddToCaseOpen(true)} title="Add this report to a case file">
                <Archive className="w-3.5 h-3.5 mr-1" /> Case
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {selected.tradecraftDeficiencies.length > 0 && (
            <div className="border-b border-border px-6 py-2 bg-amber-500/5">
              <div className="text-[10px] font-semibold text-amber-300 mb-1">
                ICD 203 deficiencies ({selected.tradecraftDeficiencies.length})
              </div>
              <ul className="text-[10px] text-muted-foreground space-y-0.5">
                {selected.tradecraftDeficiencies.slice(0, 3).map((d, i) => (
                  <li key={i} className="truncate">· {d}</li>
                ))}
                {selected.tradecraftDeficiencies.length > 3 && (
                  <li className="text-[10px] opacity-60">…+{selected.tradecraftDeficiencies.length - 3} more</li>
                )}
              </ul>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="prose prose-invert prose-sm max-w-none">
              <MarkdownRenderer content={selected.bodyMarkdown} />
            </div>
          </div>

          <div className="border-t border-border px-6 py-2 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{selected.bodyMarkdown.length.toLocaleString()} chars · model: {selected.modelUsed || 'unknown'}</span>
            <Button size="sm" variant="ghost" onClick={() => remove(selected.id)} className="text-red-400 hover:text-red-300 h-6 text-[10px]">
              Delete
            </Button>
          </div>
        </div>
      )}

      {/* Add-to-case dialog */}
      {selected && (
        <AddToCaseDialog
          open={addToCaseOpen}
          onClose={() => setAddToCaseOpen(false)}
          itemType="report"
          itemId={selected.id}
          itemTitle={selected.title}
        />
      )}
    </div>
  )
}
