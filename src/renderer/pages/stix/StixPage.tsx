import { useEffect, useState } from 'react'
import { Share2, Upload, Download, Loader2, Check, X, FileJson } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'
import { DISCIPLINE_LABELS } from '@common/types/intel'

interface StixRun {
  id: number; kind: string; started_at: number; finished_at: number | null
  objects_in: number | null; objects_out: number | null
  bundle_path: string | null; summary: string | null
  duration_ms: number | null; error: string | null
}

interface ExportResult {
  run_id: number; bundle_path: string; objects_count: number
  reports_included: number; indicators_created: number
  attack_patterns_created: number; duration_ms: number
}

interface ImportResult {
  run_id: number; bundle_path: string; objects_in: number
  reports_created: number; reports_updated: number; entities_created: number
  skipped_unsupported: number; duration_ms: number; summary: string
}

export function StixPage() {
  const [runs, setRuns] = useState<StixRun[]>([])
  const [windowDays, setWindowDays] = useState(30)
  const [discipline, setDiscipline] = useState<string>('_all')
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [lastExport, setLastExport] = useState<ExportResult | null>(null)
  const [lastImport, setLastImport] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    try {
      const rs = await window.heimdall.invoke('stix:runs', { limit: 50 }) as StixRun[]
      setRuns(rs)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function doExport() {
    setExporting(true); setError(null); setLastExport(null)
    try {
      const since = Date.now() - windowDays * 24 * 60 * 60 * 1000
      const res = await window.heimdall.invoke('stix:export', {
        since_ms: since,
        discipline: discipline === '_all' ? null : discipline
      }) as ExportResult | null
      if (res) {
        setLastExport(res)
        await load()
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setExporting(false) }
  }

  async function doImport() {
    setImporting(true); setError(null); setLastImport(null)
    try {
      const res = await window.heimdall.invoke('stix:import_pick') as ImportResult | null
      if (res) {
        setLastImport(res)
        await load()
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setImporting(false) }
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-6 space-y-6">
      <div className="flex items-start gap-4">
        <Share2 className="h-5 w-5 text-primary mt-1" />
        <div>
          <h1 className="text-xl font-semibold">STIX 2.1 Interop</h1>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Export a slice of the corpus as an OASIS STIX 2.1 bundle, or
            import a partner-agency bundle. Object ids are deterministic
            UUIDv5 so the same report exported twice lands with the same id,
            and duplicate imports dedup on stix_id. Mapping covers report,
            indicator (IP / hash / URL / email), vulnerability (CVE),
            malware, threat-actor, identity, attack-pattern, relationship.
          </p>
        </div>
      </div>

      {error && (
        <div className="text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Export */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Export bundle</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Exports reports (and their entities + ATT&CK mappings) created
              within the time window. Quarantined reports are excluded.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Window (days)</label>
                <Input type="number" min="1" max="365" value={windowDays}
                  onChange={(e) => setWindowDays(Math.max(1, parseInt(e.target.value) || 30))} />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Discipline</label>
                <Select value={discipline} onValueChange={setDiscipline}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">All disciplines</SelectItem>
                    {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={doExport} disabled={exporting} className="w-full">
              {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Export STIX bundle…
            </Button>
            {lastExport && (
              <div className="p-3 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-emerald-300">
                  <Check className="h-3.5 w-3.5" />Exported
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  <div><span className="text-muted-foreground">Objects:</span> <span className="font-mono">{lastExport.objects_count}</span></div>
                  <div><span className="text-muted-foreground">Reports:</span> <span className="font-mono">{lastExport.reports_included}</span></div>
                  <div><span className="text-muted-foreground">Indicators:</span> <span className="font-mono">{lastExport.indicators_created}</span></div>
                  <div><span className="text-muted-foreground">Attack-patterns:</span> <span className="font-mono">{lastExport.attack_patterns_created}</span></div>
                </div>
                <div className="text-[10px] font-mono break-all">{lastExport.bundle_path}</div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Import */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Import bundle</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Reads a .json STIX bundle and creates intel_reports + entities.
              Reports with matching stix_id are updated rather than duplicated.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={doImport} disabled={importing} className="w-full" variant="outline">
              {importing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              Select bundle file…
            </Button>
            {lastImport && (
              <div className="p-3 rounded border border-blue-500/30 bg-blue-500/10 text-xs space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-blue-300">
                  <Check className="h-3.5 w-3.5" />Imported
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  <div><span className="text-muted-foreground">Objects in:</span> <span className="font-mono">{lastImport.objects_in}</span></div>
                  <div><span className="text-muted-foreground">Reports new:</span> <span className="font-mono">{lastImport.reports_created}</span></div>
                  <div><span className="text-muted-foreground">Reports updated:</span> <span className="font-mono">{lastImport.reports_updated}</span></div>
                  <div><span className="text-muted-foreground">Entities added:</span> <span className="font-mono">{lastImport.entities_created}</span></div>
                  <div className="col-span-2"><span className="text-muted-foreground">Skipped:</span> <span className="font-mono">{lastImport.skipped_unsupported}</span> (unsupported object types)</div>
                </div>
                <div className="text-[10px] font-mono break-all">{lastImport.bundle_path}</div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Runs history */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileJson className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent runs</CardTitle>
          </div>
          <CardDescription className="text-xs">
            All STIX import + export operations are audit-logged to the
            tamper-evident chain in addition to this view.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left py-2 font-medium">#</th>
                  <th className="text-left py-2 font-medium">Kind</th>
                  <th className="text-left py-2 font-medium">Finished</th>
                  <th className="text-left py-2 font-medium">Bundle</th>
                  <th className="text-left py-2 font-medium">Summary</th>
                  <th className="text-right py-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border/40">
                    <td className="py-1.5 font-mono text-xs">{r.id}</td>
                    <td className="py-1.5">
                      <Badge variant="outline" className={cn(
                        'text-[9px] py-0 px-1 font-mono uppercase',
                        r.kind === 'export' ? 'border-emerald-500/40 text-emerald-300' : 'border-blue-500/40 text-blue-300'
                      )}>{r.kind}</Badge>
                    </td>
                    <td className="py-1.5 text-xs">{r.finished_at ? formatRelativeTime(r.finished_at) : 'in progress'}</td>
                    <td className="py-1.5 text-[10px] font-mono truncate max-w-[240px]" title={r.bundle_path ?? ''}>{r.bundle_path?.split('/').pop() ?? '—'}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">
                      {r.error ? <span className="text-red-400">{r.error}</span> : (r.summary ?? '—')}
                    </td>
                    <td className="py-1.5 text-right text-xs font-mono">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
