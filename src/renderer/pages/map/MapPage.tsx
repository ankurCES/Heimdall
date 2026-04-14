import { useEffect, useState, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Tooltip, CircleMarker, Polyline } from 'react-leaflet'
import L from 'leaflet'
import { Map as MapIcon, Filter, RefreshCw, Loader2 } from 'lucide-react'
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

const DISCIPLINE_ICONS: Record<string, string> = {
  osint: '🌐', cybint: '🛡️', finint: '💰', socmint: '💬',
  geoint: '🌍', sigint: '📡', rumint: '👂', ci: '🔒',
  agency: '🏛️', imint: '📷'
}

const TRAJECTORY_COLORS = [
  '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e',
  '#6366f1', '#22c55e', '#e879f9', '#0ea5e9', '#fb923c'
]
const ISS_COLOR = '#f59e0b'

interface TrajectoryPoint { lat: number; lng: number; time: number }
interface Trajectory { id: string; label: string; type: 'adsb' | 'iss'; points: TrajectoryPoint[] }

// Split a trajectory at antimeridian (±180° lng) crossings to avoid horizontal map-spanning lines
// Also interpolate intermediate points for smooth curves
function splitAtAntimeridian(points: Array<[number, number]>): Array<Array<[number, number]>> {
  if (points.length < 2) return [points]

  const segments: Array<Array<[number, number]>> = []
  let current: Array<[number, number]> = [points[0]]

  for (let i = 1; i < points.length; i++) {
    const prevLng = points[i - 1][1]
    const currLng = points[i][1]

    // Detect antimeridian crossing: longitude jump > 180°
    if (Math.abs(currLng - prevLng) > 180) {
      // End current segment, start new one
      if (current.length >= 2) segments.push(current)
      current = [points[i]]
    } else {
      current.push(points[i])
    }
  }
  if (current.length >= 2) segments.push(current)
  return segments
}

// Interpolate points along great circle arc for smooth orbital curves
function interpolateGreatCircle(points: Array<[number, number]>, stepsPerSegment: number = 8): Array<[number, number]> {
  if (points.length < 2) return points
  const result: Array<[number, number]> = []

  for (let i = 0; i < points.length - 1; i++) {
    const [lat1, lng1] = points[i]
    const [lat2, lng2] = points[i + 1]

    // Skip interpolation for very short segments
    const dLat = Math.abs(lat2 - lat1)
    const dLng = Math.abs(lng2 - lng1)
    if (dLat < 0.5 && dLng < 0.5) {
      result.push(points[i])
      continue
    }

    const toRad = (d: number) => d * Math.PI / 180
    const toDeg = (r: number) => r * 180 / Math.PI

    const phi1 = toRad(lat1), lam1 = toRad(lng1)
    const phi2 = toRad(lat2), lam2 = toRad(lng2)

    // Great circle distance
    const d = 2 * Math.asin(Math.sqrt(
      Math.sin((phi2 - phi1) / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2
    ))

    if (d < 1e-6) {
      result.push(points[i])
      continue
    }

    for (let s = 0; s < stepsPerSegment; s++) {
      const f = s / stepsPerSegment
      const A = Math.sin((1 - f) * d) / Math.sin(d)
      const B = Math.sin(f * d) / Math.sin(d)
      const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2)
      const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2)
      const z = A * Math.sin(phi1) + B * Math.sin(phi2)
      result.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))])
    }
  }
  // Add last point
  result.push(points[points.length - 1])
  return result
}

function makeDivIcon(emoji: string, color: string, size: number = 24): L.DivIcon {
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${size * 0.6}px;border-radius:50%;border:2px solid ${color};background:rgba(15,23,42,0.85);box-shadow:0 0 6px ${color}40;">${emoji}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
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
  const [selectedNode, setSelectedNode] = useState<any>(null)
  const [filterDiscipline, setFilterDiscipline] = useState<string>('all')
  const [filterSeverity, setFilterSeverity] = useState<string>('all')
  const [layers, setLayers] = useState<Record<string, boolean>>({
    osint: true, cybint: true, finint: true, socmint: true,
    geoint: true, sigint: true, rumint: true, ci: true, agency: true, imint: true, mesh: true, paths: true
  })
  const [meshNodes, setMeshNodes] = useState<Array<{ node_id: string; long_name: string | null; latitude: number | null; longitude: number | null; battery_level: number | null; last_seen: number }>>([])
  const [trajectories, setTrajectories] = useState<Trajectory[]>([])

  const loadTrajectories = useCallback(async () => {
    try {
      const result = await window.heimdall.invoke('intel:getTrajectories') as { trajectories: Trajectory[] }
      setTrajectories((result.trajectories || []).slice(0, 50)) // Cap at 50 paths
    } catch (err) {
      console.error('Failed to load trajectories:', err)
    }
  }, [])

  const loadMeshNodes = useCallback(async () => {
    try {
      const nodes = await window.heimdall.invoke('meshtastic:getNodes') as any[]
      setMeshNodes((nodes || []).filter((n: any) => n.latitude && n.longitude))
    } catch {}
  }, [])

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
    loadMeshNodes()
    loadTrajectories()
    const interval = setInterval(() => { loadGeoReports(); loadMeshNodes(); loadTrajectories() }, 30000)
    return () => clearInterval(interval)
  }, [loadGeoReports, loadMeshNodes, loadTrajectories])

  // Subscribe to new reports
  useEffect(() => {
    const unsub = ipc.on.newReports((newReports: unknown) => {
      const reports = newReports as IntelReport[]
      const geoNew = reports.filter(
        (r): r is GeoReport => r.latitude !== null && r.longitude !== null
      )
      if (geoNew.length > 0) {
        setReports((prev) => [...geoNew, ...prev].slice(0, 2000)) // Cap at 2000
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50 relative z-10">
        <div className="flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Threat Map</span>
          <Badge variant="outline" className="text-xs">{stats.total} geo-tagged</Badge>
          {stats.critical > 0 && <Badge variant="destructive" className="text-xs">{stats.critical} critical</Badge>}
          {stats.high > 0 && <Badge variant="warning" className="text-xs">{stats.high} high</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {/* Layer selector dropdown */}
          <Select value="layers" onValueChange={() => {}}>
            <SelectTrigger className="w-40 h-7 text-xs">
              <span className="flex items-center gap-1.5">
                <Filter className="h-3 w-3" />
                Layers ({Object.values(layers).filter(Boolean).length})
              </span>
            </SelectTrigger>
            <SelectContent>
              {([
                { key: 'osint', icon: '🌐', label: 'OSINT — Open Source' },
                { key: 'cybint', icon: '🛡️', label: 'CYBINT — Cyber' },
                { key: 'finint', icon: '💰', label: 'FININT — Financial' },
                { key: 'socmint', icon: '💬', label: 'SOCMINT — Social Media' },
                { key: 'geoint', icon: '🌍', label: 'GEOINT — Geospatial' },
                { key: 'sigint', icon: '📡', label: 'SIGINT — Signals' },
                { key: 'rumint', icon: '👂', label: 'RUMINT — Rumor' },
                { key: 'ci', icon: '🔒', label: 'CI — Counter-Intel' },
                { key: 'agency', icon: '🏛️', label: 'Agency — Law Enforcement' },
                { key: 'imint', icon: '📷', label: 'IMINT — Imagery' },
                { key: 'mesh', icon: '📻', label: 'Meshtastic — Mesh Nodes' },
                { key: 'paths', icon: '✈️', label: 'Trajectory Paths' }
              ]).map(({ key, icon, label }) => (
                <div
                  key={key}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-accent rounded-sm"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setLayers((l) => ({ ...l, [key]: !l[key] })) }}
                >
                  <span className={cn('h-3 w-3 rounded-sm border flex items-center justify-center text-[8px]',
                    layers[key] ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground'
                  )}>
                    {layers[key] ? '✓' : ''}
                  </span>
                  <span>{icon}</span>
                  <span className={layers[key] ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
                </div>
              ))}
            </SelectContent>
          </Select>
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

          {reports.filter((r) => layers[r.discipline] !== false).map((report) => {
            const emoji = DISCIPLINE_ICONS[report.discipline] || '📄'
            const color = SEVERITY_COLORS[report.severity]
            const size = SEVERITY_RADIUS[report.severity] * 3
            return (
              <Marker
                key={report.id}
                position={[report.latitude, report.longitude]}
                icon={makeDivIcon(emoji, color, size)}
                eventHandlers={{ click: () => { setSelectedReport(report); setSelectedNode(null) } }}
              >
                <Tooltip direction="top" offset={[0, -size/2]} className="custom-tooltip">
                  <span style={{ fontSize: 10 }}>{emoji} {report.title.slice(0, 50)}</span>
                </Tooltip>
              </Marker>
            )
          })}

          {/* Meshtastic nodes */}
          {layers.mesh && meshNodes.map((node) => {
            const isSelf = node.node_id === 'self'
            const color = isSelf ? '#f59e0b' : '#10b981'
            const emoji = isSelf ? '📍' : '📻'
            return (
              <Marker
                key={node.node_id}
                position={[node.latitude!, node.longitude!]}
                icon={makeDivIcon(emoji, color, isSelf ? 30 : 24)}
                eventHandlers={{ click: () => { setSelectedNode(node); setSelectedReport(null) } }}
              >
                <Tooltip direction="top" offset={[0, -12]} className="custom-tooltip">
                  <span style={{ fontSize: 10 }}>{emoji} {node.long_name || node.node_id}{isSelf ? ' (You)' : ''}</span>
                </Tooltip>
              </Marker>
            )
          })}

          {/* Trajectory paths — smooth dotted bold lines */}
          {layers.paths && trajectories.map((traj, idx) => {
            const color = traj.type === 'iss' ? ISS_COLOR : TRAJECTORY_COLORS[idx % TRAJECTORY_COLORS.length]
            const rawPositions = traj.points.map((p) => [p.lat, p.lng] as [number, number])
            if (rawPositions.length < 2) return null

            // For ISS/orbital: interpolate great circle arcs + split at antimeridian
            const isOrbital = traj.type === 'iss'
            const interpolated = isOrbital ? interpolateGreatCircle(rawPositions, 12) : rawPositions
            const segments = isOrbital ? splitAtAntimeridian(interpolated) : [interpolated]
            const lastPt = rawPositions[rawPositions.length - 1]

            return (
              <span key={traj.id}>
                {segments.map((seg, si) => (
                  <Polyline
                    key={`${traj.id}-seg-${si}`}
                    positions={seg}
                    pathOptions={{
                      color,
                      weight: 3,
                      opacity: 0.75,
                      dashArray: '8 6',
                      lineCap: 'round',
                      lineJoin: 'round'
                    }}
                    smoothFactor={isOrbital ? 1.5 : 1.0}
                  />
                ))}
                {/* Endpoint marker — latest position */}
                <CircleMarker
                  center={lastPt}
                  radius={5}
                  pathOptions={{ color, fillColor: color, fillOpacity: 1, weight: 2 }}
                >
                  <Tooltip direction="top" offset={[0, -8]} className="custom-tooltip">
                    <span style={{ fontSize: 10 }}>{isOrbital ? '🛰️' : '✈️'} {traj.label} ({traj.points.length} pts)</span>
                  </Tooltip>
                </CircleMarker>
              </span>
            )
          })}

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

        {/* Mesh node detail panel */}
        {selectedNode && (
          <div className="absolute top-3 right-3 w-80 bg-card/95 backdrop-blur border border-border rounded-lg shadow-lg z-[1000] max-h-[70vh] overflow-auto">
            <div className="p-3">
              <div className="flex items-center justify-between mb-2">
                <Badge variant="outline" className="gap-1 text-green-500 border-green-500/30">
                  📻 Meshtastic Node
                </Badge>
                <button onClick={() => setSelectedNode(null)} className="text-muted-foreground hover:text-foreground text-xs">Close</button>
              </div>
              <h3 className="text-sm font-semibold mb-3">
                {selectedNode.node_id === 'self' ? '📍 ' : ''}{selectedNode.long_name || selectedNode.node_id}
              </h3>
              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-1">
                  <div className="text-muted-foreground">Node ID</div>
                  <div className="font-mono">{selectedNode.node_id}</div>
                  {selectedNode.short_name && <>
                    <div className="text-muted-foreground">Short Name</div>
                    <div>{selectedNode.short_name}</div>
                  </>}
                  {selectedNode.hardware_model && <>
                    <div className="text-muted-foreground">Hardware</div>
                    <div>{selectedNode.hardware_model}</div>
                  </>}
                  {selectedNode.battery_level !== null && selectedNode.battery_level !== undefined && <>
                    <div className="text-muted-foreground">Battery</div>
                    <div className={selectedNode.battery_level > 50 ? 'text-green-500' : selectedNode.battery_level > 20 ? 'text-yellow-500' : 'text-red-500'}>
                      {selectedNode.battery_level}%
                    </div>
                  </>}
                  {selectedNode.snr !== null && selectedNode.snr !== undefined && <>
                    <div className="text-muted-foreground">SNR</div>
                    <div>{typeof selectedNode.snr === 'number' ? selectedNode.snr.toFixed(2) : selectedNode.snr}</div>
                  </>}
                  {selectedNode.channel !== null && selectedNode.channel !== undefined && <>
                    <div className="text-muted-foreground">Channel</div>
                    <div>CH {selectedNode.channel}</div>
                  </>}
                  {selectedNode.latitude && selectedNode.longitude && <>
                    <div className="text-muted-foreground">Position</div>
                    <div>{selectedNode.latitude.toFixed(5)}, {selectedNode.longitude.toFixed(5)}</div>
                  </>}
                  <div className="text-muted-foreground">First Seen</div>
                  <div>{new Date(selectedNode.first_seen).toLocaleString()}</div>
                  <div className="text-muted-foreground">Last Seen</div>
                  <div>{new Date(selectedNode.last_seen).toLocaleString()}</div>
                  <div className="text-muted-foreground">Seen Count</div>
                  <div>{selectedNode.seen_count}x</div>
                </div>
              </div>
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
