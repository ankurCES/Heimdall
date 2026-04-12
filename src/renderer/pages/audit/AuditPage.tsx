import { Activity } from 'lucide-react'

export function AuditPage() {
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Audit Log</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Complete audit trail of all data collection, access, and alert dispatch actions.
      </p>
      <div className="mt-8 rounded-lg border border-dashed border-border p-12 text-center">
        <Activity className="mx-auto h-12 w-12 text-muted-foreground/30" />
        <p className="mt-4 text-muted-foreground">No audit entries yet</p>
        <p className="text-sm text-muted-foreground/70">Entries will appear once collectors start running</p>
      </div>
    </div>
  )
}
