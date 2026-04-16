import { useEffect, useState } from 'react'
import { Image, Upload, Loader2, MapPin, Trash2, Camera, Clock } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

interface ImageEvidence {
  id: string
  source_path: string
  file_name: string | null
  file_size: number | null
  mime_type: string | null
  sha256: string | null
  report_id: string | null
  latitude: number | null
  longitude: number | null
  altitude_m: number | null
  captured_at: number | null
  camera_make: string | null
  camera_model: string | null
  lens_model: string | null
  orientation: number | null
  width: number | null
  height: number | null
  gps_accuracy_m: number | null
  raw_exif: string | null
  ingested_at: number
}

export function ImagesPage() {
  const [images, setImages] = useState<ImageEvidence[]>([])
  const [selected, setSelected] = useState<ImageEvidence | null>(null)
  const [geoOnly, setGeoOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void load() }, [geoOnly])

  async function load() {
    setError(null)
    try {
      const rows = await window.heimdall.invoke('image:list', { limit: 200, geo_only: geoOnly }) as ImageEvidence[]
      setImages(rows)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  async function pick() {
    setBusy(true); setError(null)
    try {
      const rows = await window.heimdall.invoke('image:ingest_pick') as ImageEvidence[]
      if (rows.length > 0) setSelected(rows[0])
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  async function remove(img: ImageEvidence) {
    if (!confirm(`Delete ${img.file_name ?? img.id}?`)) return
    try {
      await window.heimdall.invoke('image:delete', img.id)
      if (selected?.id === img.id) setSelected(null)
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const geoCount = images.filter((i) => i.latitude != null && i.longitude != null).length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-start justify-between gap-4 flex-wrap p-6 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <Image className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold">Image evidence</h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Analyst-ingested images with EXIF / GPS / camera metadata extracted.
            Drag a photo into the app via the picker; Heimdall hashes and
            indexes it for intel reference. Reverse-image-search and
            face-blur-on-ingest come in follow-up batches.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={geoOnly ? 'default' : 'outline'} onClick={() => setGeoOnly((v) => !v)}>
            <MapPin className="h-4 w-4 mr-2" />
            {geoOnly ? `Geo-tagged (${geoCount})` : `Show all (${images.length})`}
          </Button>
          <Button onClick={pick} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            Ingest image(s)
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-6 my-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>
      )}

      <div className="flex-1 overflow-hidden flex">
        <div className="w-[420px] border-r border-border overflow-auto">
          {images.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No images ingested yet. Click <strong>Ingest image(s)</strong>.
            </div>
          ) : images.map((img) => (
            <button
              key={img.id}
              onClick={() => setSelected(img)}
              className={cn(
                'w-full text-left px-4 py-3 border-b border-border/40 hover:bg-accent/30 flex items-start gap-3',
                selected?.id === img.id && 'bg-accent/50'
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{img.file_name ?? img.id}</div>
                <div className="flex items-center gap-2 mt-1 flex-wrap text-[10px] text-muted-foreground">
                  {img.width && img.height && (
                    <span className="font-mono">{img.width}×{img.height}</span>
                  )}
                  {img.file_size != null && (
                    <span className="font-mono">{(img.file_size / 1024).toFixed(0)}KB</span>
                  )}
                  {img.captured_at && (
                    <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" />{formatRelativeTime(img.captured_at)}</span>
                  )}
                  {img.latitude != null && (
                    <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">
                      <MapPin className="h-2.5 w-2.5 mr-0.5" />
                      {img.latitude.toFixed(3)}, {img.longitude!.toFixed(3)}
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {selected ? (
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3">
                <Image className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold truncate">{selected.file_name ?? selected.id}</h2>
                  <p className="text-xs font-mono text-muted-foreground break-all">{selected.source_path}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void remove(selected)}>
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>

              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                    <CardTitle className="text-sm">File + camera</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-xs">
                  <KV k="Size" v={selected.file_size != null ? `${(selected.file_size / 1024).toFixed(1)} KB` : '—'} />
                  <KV k="Dimensions" v={selected.width && selected.height ? `${selected.width}×${selected.height}` : '—'} />
                  <KV k="MIME" v={selected.mime_type ?? '—'} />
                  <KV k="SHA-256" v={selected.sha256 ? `${selected.sha256.slice(0, 16)}…` : '—'} mono />
                  <KV k="Camera" v={[selected.camera_make, selected.camera_model].filter(Boolean).join(' ') || '—'} />
                  <KV k="Lens" v={selected.lens_model ?? '—'} />
                  <KV k="Captured" v={selected.captured_at ? new Date(selected.captured_at).toLocaleString() : '—'} />
                  <KV k="Orientation" v={selected.orientation != null ? `${selected.orientation}` : '—'} />
                </CardContent>
              </Card>

              {selected.latitude != null && (
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                      <CardTitle className="text-sm">GPS</CardTitle>
                    </div>
                    <CardDescription className="text-xs">From EXIF — treat as self-reported. No coordinate lookup performed.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-3 text-xs">
                    <KV k="Latitude" v={selected.latitude.toFixed(6)} mono />
                    <KV k="Longitude" v={selected.longitude!.toFixed(6)} mono />
                    <KV k="Altitude" v={selected.altitude_m != null ? `${selected.altitude_m.toFixed(1)} m` : '—'} />
                    <KV k="Accuracy" v={selected.gps_accuracy_m != null ? `±${selected.gps_accuracy_m.toFixed(1)} m` : '—'} />
                  </CardContent>
                </Card>
              )}

              {selected.raw_exif && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Raw EXIF (truncated to 20 KB)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted/50 p-2 rounded max-h-80 overflow-auto">
                      {(() => {
                        try { return JSON.stringify(JSON.parse(selected.raw_exif!), null, 2) }
                        catch { return selected.raw_exif }
                      })()}
                    </pre>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Image className="h-10 w-10 mb-2 opacity-30" />
              <p className="text-sm">Select an image to view EXIF metadata</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
      <div className={cn('truncate', mono && 'font-mono text-[11px]')}>{v}</div>
    </div>
  )
}
