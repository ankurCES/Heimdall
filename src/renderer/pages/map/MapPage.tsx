import { Map } from 'lucide-react'

export function MapPage() {
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Map className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Threat Map</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Geospatial threat visualization with Meshtastic mesh overlay.
      </p>
      <div className="mt-8 rounded-lg border border-dashed border-border p-12 text-center">
        <Map className="mx-auto h-12 w-12 text-muted-foreground/30" />
        <p className="mt-4 text-muted-foreground">Map view coming soon</p>
        <p className="text-sm text-muted-foreground/70">Geospatial mapping will be available in Phase 7</p>
      </div>
    </div>
  )
}
