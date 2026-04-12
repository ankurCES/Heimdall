import { useEffect, useState, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from 'react-leaflet'
import L from 'leaflet'
import { Map as MapIcon, Filter, RefreshCw, Loader2, Maximize2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { DISCIPLINE_LABELS, type IntelReport, type ThreatLevel, type Discipline } from '@common/types/intel'
import { formatRelativeTime } from '@renderer/lib/utils'
import { ipc } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import 'leaflet/dist/leaflet.css'

const SEVERITY_COLORS: Record<ThreatLevel, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  info: '#6b7280'
}

const SEVERITY_RADIUS: Record<ThreatLevel, number> = {
  critical: 10,
  high: 8,
  medium: 6,
  low: 5,
  info: 4
}

// Fix Leaflet default icon path issue in bundled apps
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
})

interface GeoReport extends IntelReport {
  latitude: number
  longitude: number
}

export function MapPage() {
  const [reports, setReports] = useState<GeoReport[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedReport, setSelectedReport] = useState<GeoReport | null>(null)
  const [filterDiscipline, setFilterDiscipline] = useState<string>('all')
  const [filterSeverity, setFilterSeverity] = useState<string>('all')
  const [layers, setLayers] = useState<Record<string, boolean>>({
    osint: true, cybint: true, finint: true, socmint: true,
    geoint: true, sigint: true, rumint: true, ci: true, agency: true, imint: true
  })

  const loadGeoReports = useCallback(async () => {
    setLoading(true)
    try {
      const result = await ipc.intel.getReports({
        offset: 0,
        limit: 2000,
        discipline: filterDiscipline !== 'all' ? filterDiscipline : undefined,
        severity: filterSeverity !== 'all' ? filterSeverity : undefined
      })
      const geoReports = (result.reports as IntelReport[]).filter(
        (r): r is GeoReport => r.latitude !== null && r.longitude !== null && r.latitude !== 0 && r.longitude !== 0
      )
      setReports(geoReports)
    } catch (err) {
      console.error('Failed to load geo reports:', err)
    } finally {
      setLoading(false)
    }
  }, [filterDiscipline, filterSeverity])

  useEffect(() => {
    loadGeoReports()
    const interval = setInterval(loadGeoReports, 30000)
    return () => clearInterval(interval)
  }, [loadGeoReports])

  // Subscribe to new reports
  useEffect(() => {
    const unsub = ipc.on.newReports((newReports: unknown) => {
      const reports = newReports as IntelReport[]
      const geoNew = reports.filter(
        (r): r is GeoReport => r.latitude !== null && r.longitude !== null
      )
      if (geoNew.length > 0) {
        setReports((prev) => [...geoNew, ...prev])
      }
    })
    return unsub
  }, [])

  const stats = {
    total: reports.length,
    critical: reports.filter((r) => r.severity === 'critical').length,
    high: reports.filter((r) => r.severity === 'high').length
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Threat Map</span>
          <Badge variant="outline" className="text-xs">{stats.total} geo-tagged</Badge>
          {stats.critical > 0 && <Badge variant="destructive" className="text-xs">{stats.critical} critical</Badge>}
          {stats.high > 0 && <Badge variant="warning" className="text-xs">{stats.high} high</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {/* Layer toggles */}
          <div className="flex items-center gap-0.5">
            {Object.entries({ osint: '🔵', cybint: '🔴', geoint: '🟡', sigint: '🟢', agency: '🟣', imint: '📷' }).map(([disc, emoji]) => (
              <button
                key={disc}
                onClick={() => setLayers((l) => ({ ...l, [disc]: !l[disc] }))}
                className={`px-1.5 py-0.5 rounded text-[9px] border transition-opacity ${layers[disc] ? 'opacity-100 border-primary' : 'opacity-40 border-border'}`}
                title={disc.toUpperCase()}
              >
                {emoji}
              </button>
            ))}
          </div>
          <Select value={filterDiscipline} onValueChange={setFilterDiscipline}>
            <SelectTrigger className="w-32 h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Disciplines</SelectItem>
              {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterSeverity} onValueChange={setFilterSeverity}>
            <SelectTrigger className="w-28 h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-7" onClick={loadGeoReports} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 relative">
        <MapContainer
          center={[20, 0]}
          zoom={2}
          style={{ height: '100%', width: '100%', background: '#0f172a' }}
          zoomControl={true}
          attributionControl={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          {reports.filter((r) => layers[r.discipline] !== false).map((report) => (
            <CircleMarker
              key={report.id}
              center={[report.latitude, report.longitude]}
              radius={SEVERITY_RADIUS[report.severity]}
              pathOptions={{
                color: SEVERITY_COLORS[report.severity],
                fillColor: SEVERITY_COLORS[report.severity],
                fillOpacity: 0.6,
                weight: 1.5
              }}
              eventHandlers={{
                click: () => setSelectedReport(report)
              }}
            >
              <Popup>
                <div style={{ minWidth: 200, color: '#e2e8f0', background: '#1e293b', padding: 8, borderRadius: 6, margin: -12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{report.title.slice(0, 80)}</div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>
                    <div>{report.discipline.toUpperCase()} | {report.severity.toUpperCase()}</div>
                    <div>{report.sourceName}</div>
                    <div>{formatRelativeTime(report.createdAt)}</div>
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}

          <MapLegend />
        </MapContainer>

        {/* Detail panel */}
        {selectedReport && (
          <div className="absolute top-3 right-3 w-80 bg-card/95 backdrop-blur border border-border rounded-lg shadow-lg z-[1000] max-h-[60vh] overflow-auto">
            <div className="p-3">
              <div className="flex items-center justify-between mb-2">
                <Badge
                  variant={selectedReport.severity === 'critical' ? 'destructive' : selectedReport.severity === 'high' ? 'warning' : 'secondary'}
                >
                  {selectedReport.severity.toUpperCase()}
                </Badge>
                <button onClick={() => setSelectedReport(null)} className="text-muted-foreground hover:text-foreground text-xs">
                  Close
                </button>
              </div>
              <h3 className="text-sm font-semibold mb-2">{selectedReport.title}</h3>
              <div className="text-xs space-y-1 text-muted-foreground mb-3">
                <div>Discipline: {DISCIPLINE_LABELS[selectedReport.discipline as Discipline]}</div>
                <div>Source: {selectedReport.sourceName}</div>
                <div>Location: {selectedReport.latitude.toFixed(4)}, {selectedReport.longitude.toFixed(4)}</div>
                <div>Verification: {selectedReport.verificationScore}/100</div>
                <div>Collected: {formatRelativeTime(selectedReport.createdAt)}</div>
              </div>
              <div className="text-xs text-foreground/80 whitespace-pre-wrap max-h-40 overflow-auto">
                {selectedReport.content.slice(0, 500)}
              </div>
              {selectedReport.sourceUrl && (
                <a
                  href={selectedReport.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline mt-2 block"
                >
                  Open Source
                </a>
              )}
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute bottom-3 left-3 bg-card/90 border border-border rounded px-3 py-1.5 text-xs flex items-center gap-2 z-[1000]">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading geo data...
          </div>
        )}
      </div>
    </div>
  )
}

function MapLegend() {
  return (
    <div className="leaflet-bottom leaflet-left" style={{ pointerEvents: 'auto' }}>
      <div className="leaflet-control" style={{
        background: 'rgba(15, 23, 42, 0.9)', padding: '8px 12px', borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.1)', fontSize: 10, color: '#94a3b8', margin: 12
      }}>
        {Object.entries(SEVERITY_COLORS).map(([sev, color]) => (
          <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {sev.charAt(0).toUpperCase() + sev.slice(1)}
          </div>
        ))}
      </div>
    </div>
  )
}
