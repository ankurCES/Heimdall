import { useEffect, useState } from 'react'
import { useIntelStore } from '@renderer/stores/intelStore'
import { Virtuoso } from 'react-virtuoso'
import {
  FileText, Search, Filter, ChevronRight, ExternalLink,
  CheckCircle, X
} from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { DISCIPLINE_LABELS, type Discipline, type ThreatLevel, type IntelReport } from '@common/types/intel'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'
import { StanagBadge } from '@renderer/components/StanagBadge'
import { ClassificationBadge, isClassification, isCleared, type Classification } from '@renderer/components/ClassificationBanner'

const SEVERITY_BADGE: Record<ThreatLevel, { variant: 'destructive' | 'warning' | 'default' | 'secondary' | 'outline'; label: string }> = {
  critical: { variant: 'destructive', label: 'CRITICAL' },
  high: { variant: 'warning', label: 'HIGH' },
  medium: { variant: 'default', label: 'MEDIUM' },
  low: { variant: 'secondary', label: 'LOW' },
  info: { variant: 'outline', label: 'INFO' }
}

// Friendly labels for source types
const SOURCE_TYPE_LABELS: Record<string, string> = {
  'rss': 'RSS Feed',
  'telegram-channel': 'Telegram (Bot API)',
  'telegram-subscriber': 'Telegram (Public)',
  'github-repo': 'GitHub',
  'api-endpoint': 'Custom API',
  'twitter': 'Twitter/X',
  'reddit': 'Reddit',
  'gdelt': 'GDELT',
  'gnews': 'GNews',
  'cve': 'CVE/NVD',
  'threat-feed': 'Threat Feed',
  'cyber-ioc': 'Cyber IOC',
  'sans-isc': 'SANS ISC',
  'dns-whois': 'DNS/WHOIS',
  'edgar': 'SEC EDGAR',
  'sanctions': 'Sanctions',
  'commodity': 'Commodities',
  'mfapi': 'Indian Mutual Funds',
  'usgs-earthquake': 'USGS Earthquake',
  'noaa-weather': 'NOAA Weather',
  'nasa-firms': 'NASA FIRMS',
  'nasa-eonet': 'NASA EONET',
  'gdacs': 'GDACS',
  'radiation': 'Radiation',
  'climate-anomaly': 'Climate',
  'sentinel': 'Sentinel Sat',
  'adsb': 'ADS-B',
  'adsb-lol': 'ADS-B (LOL)',
  'satellite': 'Satellite/ISS',
  'fcc': 'FCC',
  'ais-maritime': 'Maritime AIS',
  'meshtastic': 'Meshtastic',
  'airport-delay': 'Airport Delays',
  'chokepoint': 'Chokepoints',
  'forum': 'Forums',
  'hibp': 'HIBP',
  'breach-feed': 'Breach Feed',
  'interpol': 'Interpol',
  'fbi': 'FBI',
  'europol': 'Europol',
  'unsc': 'UN Security Council',
  'security-advisory': 'Travel Advisory',
  'internet-outage': 'Internet Outage',
  'prediction-market': 'Prediction Market',
  'traffic-camera': 'Traffic Camera',
  'public-camera': 'Public Camera',
  'factbook': 'CIA Factbook',
  'public-records': 'Public Records',
  'academic': 'Academic (arXiv)',
  'government-data': 'Government Data',
  'fbi-crime-stats': 'FBI Crime Stats',
  'uk-police-crime': 'UK Police Crime'
}

export function FeedPage() {
  const { reports, total, loading, filters, fetchReports, setFilters, markReviewed } = useIntelStore()
  const [searchInput, setSearchInput] = useState('')
  const [selectedReport, setSelectedReport] = useState<IntelReport | null>(null)
  const [sourceTypes, setSourceTypes] = useState<Array<{ type: string; count: number }>>([])

  useEffect(() => {
    fetchReports()
    void window.heimdall.invoke('intel:getSourceTypes').then((rows: unknown) => {
      setSourceTypes(rows as Array<{ type: string; count: number }>)
    })
  }, [fetchReports])

  const handleSearch = () => {
    setFilters({ ...filters, search: searchInput || undefined })
  }

  return (
    <div className="flex h-full">
      {/* Left: Feed list */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-border">
        {/* Filters bar */}
        <div className="flex items-center gap-2 flex-wrap p-3 border-b border-border bg-card/50">
          <div className="relative flex-1 min-w-[150px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search reports..."
              className="pl-8 h-8 text-sm"
            />
          </div>
          <Select
            value={filters.discipline || 'all'}
            onValueChange={(v) => setFilters({ ...filters, discipline: v === 'all' ? undefined : v })}
          >
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue placeholder="Discipline" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Disciplines</SelectItem>
              {Object.entries(DISCIPLINE_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.severity || 'all'}
            onValueChange={(v) => setFilters({ ...filters, severity: v === 'all' ? undefined : v })}
          >
            <SelectTrigger className="w-28 h-8 text-xs">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.sourceType || 'all'}
            onValueChange={(v) => setFilters({ ...filters, sourceType: v === 'all' ? undefined : v })}
          >
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue placeholder="Source Type" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all">All Source Types</SelectItem>
              {sourceTypes.map(({ type, count }) => (
                <SelectItem key={type} value={type}>
                  {SOURCE_TYPE_LABELS[type] || type} ({count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={() => { setFilters({}); setSearchInput('') }}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Results count */}
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border">
          {total} reports {(filters.discipline || filters.severity || filters.search || filters.sourceType) ? '(filtered)' : ''}
        </div>

        {/* Feed list with virtual scroll */}
        <div className="flex-1">
          {reports.length > 0 ? (
            <Virtuoso
              style={{ height: '100%' }}
              totalCount={reports.length}
              itemContent={(index) => {
                const report = reports[index]
                const sevBadge = SEVERITY_BADGE[report.severity]
                const isSelected = selectedReport?.id === report.id
                return (
                  <div
                    className={cn(
                      'flex items-start gap-3 px-3 py-2.5 border-b border-border cursor-pointer hover:bg-accent/50 transition-colors',
                      isSelected && 'bg-accent'
                    )}
                    onClick={() => setSelectedReport(report)}
                  >
                    <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
                      report.severity === 'critical' ? 'bg-red-500' :
                      report.severity === 'high' ? 'bg-orange-500' :
                      report.severity === 'medium' ? 'bg-yellow-500' :
                      report.severity === 'low' ? 'bg-blue-500' : 'bg-gray-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{report.title}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant={sevBadge.variant} className="text-[9px] py-0 px-1.5">{sevBadge.label}</Badge>
                        <Badge variant="outline" className="text-[9px] py-0 px-1.5 font-mono">{report.discipline}</Badge>
                        <ClassificationBadge level={report.classification} />
                        <StanagBadge reliability={report.sourceReliability} credibility={report.credibility} />
                        <span className="text-[10px] text-muted-foreground">{report.sourceName}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">{formatRelativeTime(report.createdAt)}</span>
                      </div>
                    </div>
                    {report.reviewed && <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0 mt-1" />}
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                  </div>
                )
              }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <FileText className="h-12 w-12 mb-3 opacity-30" />
              <p className="text-sm">{loading ? 'Loading...' : 'No reports found'}</p>
              <p className="text-xs opacity-70 mt-1">
                {!loading && 'Try adjusting your filters or wait for collectors to run'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail panel — slides in as overlay on mobile, fixed sidebar on desktop */}
      <div className={cn(
        'overflow-auto bg-card/95 md:bg-card/30 backdrop-blur md:backdrop-blur-none',
        'fixed md:relative inset-y-0 right-0 z-40 md:z-auto',
        'w-full sm:w-[440px] md:w-[420px] border-l border-border md:border-l',
        selectedReport ? 'block' : 'hidden md:block'
      )}>
        {selectedReport ? (
          <>
            {/* Mobile close button */}
            <button
              onClick={() => setSelectedReport(null)}
              className="md:hidden absolute top-3 right-3 z-10 p-1.5 rounded bg-muted hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
            <ReportDetail
              report={selectedReport}
              onMarkReviewed={() => {
                markReviewed([selectedReport.id])
                setSelectedReport({ ...selectedReport, reviewed: true })
              }}
            />
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <FileText className="h-10 w-10 mb-2 opacity-30" />
            <p className="text-sm">Select a report to view details</p>
          </div>
        )}
      </div>
    </div>
  )
}

function ReportDetail({ report, onMarkReviewed }: { report: IntelReport; onMarkReviewed: () => void }) {
  const sevBadge = SEVERITY_BADGE[report.severity]

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Badge variant={sevBadge.variant}>{sevBadge.label}</Badge>
          <Badge variant="outline" className="font-mono text-xs">{report.discipline.toUpperCase()}</Badge>
          <StanagBadge reliability={report.sourceReliability} credibility={report.credibility} size="md" />
          {report.reviewed && <Badge variant="success">Reviewed</Badge>}
        </div>
        <h2 className="text-lg font-semibold leading-tight">{report.title}</h2>
      </div>

      {/* Metadata */}
      <Card>
        <CardContent className="p-3 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Source</span>
            <span>{report.sourceName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">STANAG 2511</span>
            <span className="font-mono">{report.sourceReliability || 'F'}{report.credibility || 6} ({((['', 'Confirmed', 'Probably true', 'Possibly true', 'Doubtfully true', 'Improbable', 'Cannot judge'][report.credibility || 6]) || 'Cannot judge')})</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Verification</span>
            <span className={cn(
              report.verificationScore >= 80 ? 'text-green-500' :
              report.verificationScore >= 50 ? 'text-yellow-500' : 'text-red-500'
            )}>{report.verificationScore}/100</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Collected</span>
            <span>{new Date(report.createdAt).toLocaleString()}</span>
          </div>
          {report.latitude && report.longitude && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Location</span>
              <span>{report.latitude.toFixed(4)}, {report.longitude.toFixed(4)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content */}
      <div className="prose prose-sm prose-invert max-w-none">
        <div className="text-sm whitespace-pre-wrap text-foreground/90 leading-relaxed">
          {report.content}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-2 border-t border-border">
        {report.sourceUrl && (
          <Button size="sm" variant="outline" onClick={() => window.open(report.sourceUrl!, '_blank')}>
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            Open Source
          </Button>
        )}
        {!report.reviewed && (
          <Button size="sm" variant="outline" onClick={onMarkReviewed}>
            <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
            Mark Reviewed
          </Button>
        )}
      </div>
    </div>
  )
}
