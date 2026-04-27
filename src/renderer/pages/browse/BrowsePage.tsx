import { useState, useEffect, useCallback } from 'react'
import {
  Layers, Search, RefreshCw, X, ExternalLink, ChevronRight,
  Shield, Globe, Cpu, DollarSign, MessageCircle, MapPin, Radio,
  Ear, Lock, Building2, Camera, Loader2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { DISCIPLINE_LABELS, type IntelReport, type Discipline, type ThreatLevel } from '@common/types/intel'
import { formatRelativeTime, cn } from '@renderer/lib/utils'
import { ipc } from '@renderer/lib/ipc'

const CATEGORIES = [
  { key: 'all', label: 'All Intel', icon: Layers, color: 'text-primary' },
  { key: 'crime', label: 'Crime & Law Enforcement', icon: Shield, color: 'text-red-500',
    disciplines: ['agency'], sources: ['FBI', 'Interpol', 'Europol', 'UK Police', 'Crime'] },
  { key: 'news', label: 'News & OSINT', icon: Globe, color: 'text-blue-500',
    disciplines: ['osint'], sources: ['Reuters', 'BBC', 'NYT', 'Al Jazeera', 'France 24', 'GDELT', 'GNews'] },
  { key: 'cyber', label: 'Cyber Threats', icon: Cpu, color: 'text-orange-500',
    disciplines: ['cybint', 'ci'], sources: ['CVE', 'OTX', 'URLhaus', 'HIBP', 'Breach'] },
  { key: 'financial', label: 'Financial Intelligence', icon: DollarSign, color: 'text-emerald-500',
    disciplines: ['finint'], sources: ['EDGAR', 'OFAC', 'Sanctions'] },
  { key: 'geospatial', label: 'Geospatial & Weather', icon: MapPin, color: 'text-yellow-500',
    disciplines: ['geoint'], sources: ['USGS', 'NOAA', 'NASA', 'FIRMS', 'EONET', 'Sentinel'] },
  { key: 'signals', label: 'Signals & Meshtastic', icon: Radio, color: 'text-green-500',
    disciplines: ['sigint'], sources: ['ADS-B', 'AIS', 'Meshtastic', 'FCC'] },
  { key: 'social', label: 'Social Media', icon: MessageCircle, color: 'text-violet-500',
    disciplines: ['socmint'], sources: ['Reddit', 'Twitter', 'Telegram'] },
  { key: 'imagery', label: 'Camera & Imagery', icon: Camera, color: 'text-cyan-500',
    disciplines: ['imint'], sources: ['Traffic', 'Camera', 'IMINT'] },
  { key: 'rumor', label: 'Rumors & Unverified', icon: Ear, color: 'text-amber-500',
    disciplines: ['rumint'], sources: [] },
]

const SEVERITY_BADGE: Record<ThreatLevel, { variant: 'destructive' | 'warning' | 'default' | 'secondary' | 'outline'; color: string }> = {
  critical: { variant: 'destructive', color: 'bg-red-500' },
  high: { variant: 'warning', color: 'bg-orange-500' },
  medium: { variant: 'default', color: 'bg-yellow-500' },
  low: { variant: 'secondary', color: 'bg-blue-500' },
  info: { variant: 'outline', color: 'bg-gray-500' }
}

export function BrowsePage() {
  const [reports, setReports] = useState<IntelReport[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [activeCategory, setActiveCategory] = useState('all')
  // v1.5.4 — Cmd-K spotlight can hand off a query to this page via
  // sessionStorage. Initial state honours the hint, then clears it
  // so reloading the page doesn't re-seed an old query.
  const [searchQuery, setSearchQuery] = useState(() => {
    if (typeof sessionStorage !== 'undefined') {
      const hint = sessionStorage.getItem('browse:query')
      if (hint) {
        sessionStorage.removeItem('browse:query')
        return hint
      }
    }
    return ''
  })
  const [selectedReport, setSelectedReport] = useState<IntelReport | null>(null)
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})

  const loadReports = useCallback(async () => {
    setLoading(true)
    const cat = CATEGORIES.find((c) => c.key === activeCategory)

    // Build filter
    const discipline = cat?.disciplines?.[0]
    const search = searchQuery || undefined

    try {
      const result = await ipc.intel.getReports({
        offset: 0, limit: 100,
        discipline: activeCategory === 'all' ? undefined : discipline,
        search
      })

      let filtered = result.reports as IntelReport[]

      // If category has multiple disciplines or source filters, apply client-side
      if (cat && cat.key !== 'all') {
        filtered = filtered.filter((r) => {
          if (cat.disciplines?.includes(r.discipline)) return true
          if (cat.sources?.length) {
            return cat.sources.some((s) => r.sourceName.toLowerCase().includes(s.toLowerCase()))
          }
          return false
        })
      }

      setReports(filtered)
      setTotal(filtered.length)
    } catch {}
    setLoading(false)
  }, [activeCategory, searchQuery])

  // Load counts per category on mount
  useEffect(() => {
    const loadCounts = async () => {
      const result = await ipc.intel.getReports({ offset: 0, limit: 5000 })
      const all = result.reports as IntelReport[]
      const counts: Record<string, number> = { all: all.length }

      for (const cat of CATEGORIES) {
        if (cat.key === 'all') continue
        counts[cat.key] = all.filter((r) => {
          if (cat.disciplines?.includes(r.discipline)) return true
          if (cat.sources?.length) return cat.sources.some((s) => r.sourceName.toLowerCase().includes(s.toLowerCase()))
          return false
        }).length
      }
      setCategoryCounts(counts)
    }
    loadCounts()
  }, [])

  useEffect(() => { loadReports() }, [loadReports])

  return (
    <div className="flex h-full">
      {/* Category sidebar */}
      <div className="w-56 border-r border-border bg-card/50 flex flex-col">
        <div className="p-3 border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" /> Browse Intel
          </h2>
        </div>
        <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon
            const count = categoryCounts[cat.key] || 0
            return (
              <button
                key={cat.key}
                onClick={() => setActiveCategory(cat.key)}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs transition-colors',
                  activeCategory === cat.key
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <Icon className={cn('h-3.5 w-3.5 shrink-0', cat.color)} />
                <span className="flex-1 text-left truncate">{cat.label}</span>
                {count > 0 && <Badge variant="secondary" className="text-[9px] py-0 px-1.5">{count}</Badge>}
              </button>
            )
          })}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Search bar */}
        <div className="flex items-center gap-2 p-3 border-b border-border bg-card/50">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadReports()}
              placeholder={`Search ${CATEGORIES.find((c) => c.key === activeCategory)?.label || 'all intel'}...`}
              className="pl-8 h-8 text-sm"
            />
          </div>
          {searchQuery && (
            <Button variant="ghost" size="sm" className="h-8" onClick={() => { setSearchQuery(''); loadReports() }}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8" onClick={loadReports} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>

        {/* Results header */}
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border flex items-center justify-between">
          <span>{total} items</span>
          <span>{CATEGORIES.find((c) => c.key === activeCategory)?.label}</span>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reports.length > 0 ? (
            <div className="divide-y divide-border">
              {reports.map((report) => {
                const sev = SEVERITY_BADGE[report.severity]
                const catInfo = CATEGORIES.find((c) =>
                  c.disciplines?.includes(report.discipline) ||
                  c.sources?.some((s) => report.sourceName.toLowerCase().includes(s.toLowerCase()))
                )
                const CatIcon = catInfo?.icon || Globe

                return (
                  <div
                    key={report.id}
                    className={cn(
                      'flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-accent/50 transition-colors',
                      selectedReport?.id === report.id && 'bg-accent'
                    )}
                    onClick={() => setSelectedReport(report)}
                  >
                    <div className={cn('mt-0.5 p-1 rounded', catInfo?.color?.replace('text-', 'bg-') + '/10')}>
                      <CatIcon className={cn('h-3.5 w-3.5', catInfo?.color)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{report.title}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={cn('h-1.5 w-1.5 rounded-full', sev.color)} />
                        <Badge variant={sev.variant} className="text-[9px] py-0 px-1.5">{report.severity.toUpperCase()}</Badge>
                        <span className="text-[10px] text-muted-foreground">{report.sourceName}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">{formatRelativeTime(report.createdAt)}</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <Layers className="h-10 w-10 mb-2 opacity-30" />
              <p className="text-sm">No data in this category</p>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedReport && (
        <div className="w-[400px] border-l border-border overflow-auto bg-card/30">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <Badge variant={SEVERITY_BADGE[selectedReport.severity].variant}>
                {selectedReport.severity.toUpperCase()}
              </Badge>
              <button onClick={() => setSelectedReport(null)} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
            </div>

            <h2 className="text-base font-semibold leading-tight">{selectedReport.title}</h2>

            <Card>
              <CardContent className="p-3 space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Discipline</span><span>{DISCIPLINE_LABELS[selectedReport.discipline] || selectedReport.discipline}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Source</span><span>{selectedReport.sourceName}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Verification</span>
                  <span className={selectedReport.verificationScore >= 80 ? 'text-green-500' : selectedReport.verificationScore >= 50 ? 'text-yellow-500' : 'text-red-500'}>
                    {selectedReport.verificationScore}/100
                  </span>
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Collected</span><span>{new Date(selectedReport.createdAt).toLocaleString()}</span></div>
                {selectedReport.latitude && selectedReport.longitude && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Location</span><span>{selectedReport.latitude.toFixed(4)}, {selectedReport.longitude.toFixed(4)}</span></div>
                )}
              </CardContent>
            </Card>

            <div className="text-sm">
              <MarkdownRenderer content={selectedReport.content} className="text-sm" />
            </div>

            {selectedReport.sourceUrl && (
              <Button variant="outline" size="sm" className="w-full" onClick={() => window.open(selectedReport.sourceUrl!, '_blank')}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Open Source
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
