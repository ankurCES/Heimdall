import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, Star, FileText, Save, Copy, Trash2, Edit3, Plus, Download, Upload, Loader2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { useAnalyticsStore } from '@renderer/stores/analyticsStore'
import { cn } from '@renderer/lib/utils'
import type { AnalyticsReport } from '@common/analytics/types'

export function ReportSelector() {
  const {
    reports, currentReport, dirty, loading,
    loadReports, loadReport, newReport, saveReport,
    deleteReport, duplicateReport, renameReport
  } = useAnalyticsStore()

  const [selectorOpen, setSelectorOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadReports().then(() => {
      // Auto-load the most recent report on first mount
      if (!currentReport && reports.length > 0) {
        void loadReport(reports[0].id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!currentReport && reports.length > 0 && !loading) {
      void loadReport(reports[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports.length])

  const filtered = reports.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))

  const handleSave = async () => {
    const result = await saveReport()
    if (result?.forked) {
      toast.success('Preset forked — saved as a new copy')
    } else if (result) {
      toast.success('Report saved')
    }
  }

  const handleDelete = async () => {
    if (!currentReport) return
    if (currentReport.isPreset) {
      toast.error('Cannot delete preset reports')
      return
    }
    if (!confirm(`Delete "${currentReport.name}"? This cannot be undone.`)) return
    const ok = await deleteReport(currentReport.id)
    if (ok) toast.success('Report deleted')
  }

  const handleDuplicate = async () => {
    if (!currentReport) return
    await duplicateReport(currentReport.id, `${currentReport.name} (copy)`)
    toast.success('Report duplicated')
  }

  const handleExport = () => {
    if (!currentReport) return
    const blob = new Blob([JSON.stringify(currentReport, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentReport.name.replace(/[^\w-]+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Report exported')
  }

  const handleImport = async (file: File) => {
    try {
      const text = await file.text()
      const imported = JSON.parse(text) as AnalyticsReport
      // Force a new ID on import so we don't clobber existing
      imported.id = ''
      imported.isPreset = false
      imported.name = `${imported.name} (imported)`
      useAnalyticsStore.setState({ currentReport: imported, dirty: true, editMode: true })
      toast.success('Report imported — click Save to persist')
    } catch (err) {
      toast.error(`Import failed: ${err}`)
    }
  }

  const startRename = () => {
    if (!currentReport) return
    setRenameVal(currentReport.name)
    setRenameOpen(true)
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Combobox-style dropdown */}
        <DropdownMenu open={selectorOpen} onOpenChange={setSelectorOpen}>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-card hover:bg-accent min-w-[280px] max-w-[420px]">
              {currentReport?.isPreset ? (
                <Star className="h-4 w-4 text-yellow-500 shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <span className="text-sm font-medium truncate flex-1 text-left">
                {currentReport?.name || (loading ? 'Loading...' : 'Select a report')}
              </span>
              {dirty && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 shrink-0" title="Unsaved changes" />}
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[320px]" align="start">
            <div className="p-2">
              <Input
                autoFocus
                placeholder="Search reports..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <DropdownMenuSeparator />
            <div className="max-h-80 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">No reports</div>
              ) : filtered.map((r) => (
                <DropdownMenuItem key={r.id} onSelect={() => { void loadReport(r.id); setSelectorOpen(false) }}>
                  {r.isPreset ? <Star className="h-3.5 w-3.5 text-yellow-500" /> : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className={cn('flex-1 truncate', currentReport?.id === r.id && 'font-semibold')}>{r.name}</span>
                  {r.isPreset && <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70">preset</span>}
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { newReport(); setSelectorOpen(false) }}>
              <Plus className="h-3.5 w-3.5" />
              <span>New Report</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant={dirty ? 'default' : 'outline'}
          size="sm"
          onClick={handleSave}
          disabled={!currentReport || loading}
          className="gap-1.5"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={!currentReport}>
              More <ChevronDown className="h-3.5 w-3.5 ml-0.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem onSelect={startRename} disabled={currentReport?.isPreset}>
              <Edit3 className="h-3.5 w-3.5" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleDuplicate}>
              <Copy className="h-3.5 w-3.5" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleExport}>
              <Download className="h-3.5 w-3.5" /> Export JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Import JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleDelete} disabled={currentReport?.isPreset} className="text-red-500 focus:text-red-500">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImport(f)
            e.target.value = ''
          }}
        />
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rename report</DialogTitle></DialogHeader>
          <div className="py-2 space-y-2">
            <Label>Name</Label>
            <Input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={() => { renameReport(renameVal); setRenameOpen(false) }}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
