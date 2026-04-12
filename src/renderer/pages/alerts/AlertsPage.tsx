import { Bell } from 'lucide-react'

export function AlertsPage() {
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Bell className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Alerts</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Alert rules and dispatch history. Configure email, Telegram, and Meshtastic dispatch channels.
      </p>
      <div className="mt-8 rounded-lg border border-dashed border-border p-12 text-center">
        <Bell className="mx-auto h-12 w-12 text-muted-foreground/30" />
        <p className="mt-4 text-muted-foreground">No alerts dispatched yet</p>
        <p className="text-sm text-muted-foreground/70">Alerting will be available in Phase 6</p>
      </div>
    </div>
  )
}
