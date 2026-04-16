import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Circle, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { MapPin, Plus, Trash2, Loader2, RefreshCw, Bell, Edit2, Check, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'
import { DISCIPLINE_LABELS, type Discipline } from '@common/types/intel'

// Default Leaflet marker icons — fix the broken-icon issue under Vite bundling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/images/marker-shadow.png'
})

interface Geofence {
  id: string
  name: string
  center_lat: number
  center_lng: number
  radius_km: number
  discipline_filter: string | null
  severity_filter: string | null
  enabled: number
  notes: string | null
}

interface GeofenceAlert {
  id: number
  geofence_id: string
  geofence_name: string
  report_id: string
  report_title: string
  report_discipline: string
  report_severity: string
  report_created_at: number
  distance_km: number
  created_at: number
}

interface RunRow {
  id: number; started_at: number; finished_at: number;
  fences_scanned: number; reports_scanned: number;
  alerts_created: number; duration_ms: number
}

interface StatRow { geofence_id: string; name: string; alert_count: number; last_alert_at: number | null }

const FENCE_COLORS = ['#60a5fa', '#f97316', '#a78bfa', '#22c55e', '#ef4444', '#eab308', '#ec4899']

function fenceColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return FENCE_COLORS[h % FENCE_COLORS.length]
}

function ClickPicker({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) })
  return null
}

export function GeofencesPage() {
  const [fences, setFences] = useState<Geofence[]>([])
  const [stats, setStats] = useState<StatRow[]>([])
  const [alerts, setAlerts] = useState<GeofenceAlert[]>([])
  const [run, setRun] = useState<RunRow | null>(null)
  const [selected, setSelected] = useState<Geofence | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<{ name: string; lat: number; lng: number; radius_km: number; discipline: string; severity: string; notes: string }>({
    name: '', lat: 35, lng: 0, radius_km: 50, discipline: '', severity: '', notes: ''
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void loadAll() }, [])

  async function loadAll() {
    setError(null)
    try {
      const [f, s, a, r] = await Promise.all([
        window.heimdall.invoke('geofence:list'),
        window.heimdall.invoke('geofence:stats'),
        window.heimdall.invoke('geofence:alerts', { limit: 100 }),
        window.heimdall.invoke('geofence:latest')
      ]) as [Geofence[], StatRow[], GeofenceAlert[], RunRow | null]
      setFences(f); setStats(s); setAlerts(a); setRun(r)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function scan() {
    setBusy(true); setError(null)
    try {
      await window.heimdall.invoke('geofence:scan')
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  async function create() {
    setError(null)
    if (!draft.name.trim()) { setError('Name required'); return }
    setBusy(true)
    try {
      await window.heimdall.invoke('geofence:create', {
        name: draft.name, center_lat: draft.lat, center_lng: draft.lng,
        radius_km: draft.radius_km,
        discipline_filter: draft.discipline || null,
        severity_filter: draft.severity || null,
        notes: draft.notes || null
      })
      setCreating(false)
      setDraft({ name: '', lat: 35, lng: 0, radius_km: 50, discipline: '', severity: '', notes: '' })
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  async function toggle(fence: Geofence) {
    try {
      await window.heimdall.invoke('geofence:update', { id: fence.id, patch: { enabled: fence.enabled === 0 } })
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function remove(fence: Geofence) {
    if (!confirm(`Delete geofence "${fence.name}" and its ${stats.find((s) => s.geofence_id === fence.id)?.alert_count ?? 0} alert(s)?`)) return
    try {
      await window.heimdall.invoke('geofence:delete', fence.id)
      if (selected?.id === fence.id) setSelected(null)
      await loadAll()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const statsById = new Map(stats.map((s) => [s.geofence_id, s]))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Geofences</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Circular watch zones over the map. Click a point to set a center,
            pick a radius (km), and optionally filter by discipline / severity.
            Any intel_reports row with coordinates inside a zone fires a
            geofence alert. Run the corpus scan after editing zones.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-2" />New geofence
          </Button>
          <Button onClick={scan} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Scan corpus
          </Button>
        </div>
      </div>

      {/* Run stats */}
      <div className="px-6 py-3 border-b border-border">
        <Card>
          <CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <Stat label="Fences" value={fences.length} />
            <Stat label="Reports scanned" value={run?.reports_scanned ?? 0} />
            <Stat label="Total alerts" value={alerts.length} />
            <Stat label="Duration" value={run?.duration_ms != null ? `${run.duration_ms} ms` : '—'} />
            <Stat label="Last scan" value={run ? formatRelativeTime(run.finished_at) : 'never'} />
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      <div className="flex-1 overflow-hidden flex">
        {/* Left — fence list + create panel */}
        <div className="w-[420px] border-r border-border overflow-auto">
          {creating && (
            <div className="p-3 border-b border-border bg-primary/5 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <Plus className="h-3.5 w-3.5" />New geofence
                <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 p-0" onClick={() => setCreating(false)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <Label className="text-[10px]">Lat</Label>
                  <Input type="number" step="0.001" value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: parseFloat(e.target.value) || 0 })} className="text-xs" />
                </div>
                <div>
                  <Label className="text-[10px]">Lng</Label>
                  <Input type="number" step="0.001" value={draft.lng} onChange={(e) => setDraft({ ...draft, lng: parseFloat(e.target.value) || 0 })} className="text-xs" />
                </div>
                <div>
                  <Label className="text-[10px]">Radius (km)</Label>
                  <Input type="number" min="1" value={draft.radius_km} onChange={(e) => setDraft({ ...draft, radius_km: parseFloat(e.target.value) || 50 })} className="text-xs" />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">Tip: click anywhere on the map to set center.</p>
              <div className="grid grid-cols-2 gap-1.5">
                <Select value={draft.discipline} onValueChange={(v) => setDraft({ ...draft, discipline: v === '_all' ? '' : v })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Any discipline" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">Any discipline</SelectItem>
                    {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={draft.severity} onValueChange={(v) => setDraft({ ...draft, severity: v === '_all' ? '' : v })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Any severity" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_all">Any severity</SelectItem>
                    {['critical', 'high', 'medium', 'low', 'info'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Input placeholder="Notes (optional)" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              <Button onClick={create} disabled={busy || !draft.name.trim()} className="w-full">
                {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
                Create
              </Button>
            </div>
          )}

          {fences.length === 0 && !creating ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No geofences yet. Click <strong>New geofence</strong> above.
            </div>
          ) : fences.map((f) => {
            const s = statsById.get(f.id)
            const isSel = selected?.id === f.id
            return (
              <div key={f.id} className={cn(
                'px-3 py-2 border-b border-border/40 hover:bg-accent/30 cursor-pointer',
                isSel && 'bg-accent/50'
              )} onClick={() => setSelected(f)}>
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-3 w-3 shrink-0 rounded-full border-2" style={{ borderColor: fenceColor(f.id), background: `${fenceColor(f.id)}30` }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{f.name}</span>
                      {f.enabled === 0 && <Badge variant="outline" className="text-[9px] py-0 px-1">off</Badge>}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono">
                      {f.center_lat.toFixed(3)}, {f.center_lng.toFixed(3)} · r={f.radius_km}km
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {f.discipline_filter && <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{f.discipline_filter}</Badge>}
                      {f.severity_filter && <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{f.severity_filter}</Badge>}
                      {s && s.alert_count > 0 && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 ml-auto">
                          <Bell className="h-3 w-3" />{s.alert_count}
                        </span>
                      )}
                    </div>
                  </div>
                  <Switch checked={f.enabled === 1} onCheckedChange={() => void toggle(f)} onClick={(e) => e.stopPropagation()} />
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); void remove(f) }}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Right — map + alert pane */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0">
            <MapContainer
              center={creating ? [draft.lat, draft.lng] : selected ? [selected.center_lat, selected.center_lng] : [20, 0]}
              zoom={creating || selected ? 5 : 2}
              style={{ width: '100%', height: '100%' }}
            >
              <TileLayer
                attribution='&copy; OpenStreetMap contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {creating && (
                <>
                  <ClickPicker onPick={(lat, lng) => setDraft({ ...draft, lat, lng })} />
                  <Marker position={[draft.lat, draft.lng]} />
                  <Circle
                    center={[draft.lat, draft.lng]}
                    radius={draft.radius_km * 1000}
                    pathOptions={{ color: '#ec4899', fillOpacity: 0.1, weight: 2 }}
                  />
                </>
              )}
              {fences.map((f) => (
                <Circle
                  key={f.id}
                  center={[f.center_lat, f.center_lng]}
                  radius={f.radius_km * 1000}
                  pathOptions={{
                    color: fenceColor(f.id),
                    fillOpacity: f.enabled === 1 ? 0.12 : 0.04,
                    weight: selected?.id === f.id ? 3 : 1.5,
                    opacity: f.enabled === 1 ? 0.9 : 0.4,
                    dashArray: f.enabled === 1 ? undefined : '6 4'
                  }}
                  eventHandlers={{ click: () => setSelected(f) }}
                />
              ))}
            </MapContainer>
          </div>

          {/* Alert feed */}
          <div className="h-56 border-t border-border overflow-auto">
            <div className="px-3 py-2 border-b border-border text-xs font-semibold flex items-center gap-2">
              <Bell className="h-3.5 w-3.5" />
              Recent alerts ({alerts.length})
            </div>
            {alerts.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No alerts yet. Create a zone and hit <strong>Scan corpus</strong>.
              </div>
            ) : alerts.map((a) => (
              <div key={a.id} className="px-3 py-1.5 border-b border-border/30 text-xs flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: fenceColor(a.geofence_id) }} />
                <span className="font-medium shrink-0">{a.geofence_name}</span>
                <span className="flex-1 truncate text-muted-foreground">{a.report_title}</span>
                <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">{a.report_discipline}</Badge>
                <span className="font-mono text-[10px] text-muted-foreground">{a.distance_km.toFixed(1)}km</span>
                <span className="text-[10px] text-muted-foreground">{formatRelativeTime(a.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold font-mono">{value}</div>
    </div>
  )
}
