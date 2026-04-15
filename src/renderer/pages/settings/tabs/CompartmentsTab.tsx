import { useEffect, useState, useCallback } from 'react'
import { Lock, Plus, Trash2, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@renderer/components/ui/dialog'
import { invalidateCompartmentCache } from '@renderer/components/CompartmentBadge'

/**
 * Need-to-know compartment management — Theme 10.2 + 10.5.
 *
 * Two responsibilities in one tab:
 *   1. Define / list / delete compartments (the codeword catalog)
 *   2. Grant or revoke YOUR OWN tickets per compartment (single-user mode)
 *
 * When multi-user RBAC lands (Theme 10.10), this tab will gain an actor
 * picker so an Admin can grant tickets to other analysts.
 */

interface CompartmentSummary {
  id: string
  ticket: string
  name: string
  description: string | null
  color: string | null
  granted: boolean
  created_at: number
  updated_at: number
}

export function CompartmentsTab() {
  const [list, setList] = useState<CompartmentSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.heimdall.invoke('compartments:list_with_grants') as CompartmentSummary[]
      setList(result || [])
      invalidateCompartmentCache()
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const toggleGrant = async (c: CompartmentSummary) => {
    if (c.granted) {
      await window.heimdall.invoke('compartments:revoke', { compartment_id: c.id })
    } else {
      await window.heimdall.invoke('compartments:grant', { compartment_id: c.id })
    }
    await load()
  }

  const removeCompartment = async (c: CompartmentSummary) => {
    if (!confirm(`Delete compartment ${c.ticket}? Existing artifacts tagged with it keep the tag (now resolves to "Unknown") until manually re-tagged.`)) return
    await window.heimdall.invoke('compartments:delete', { id: c.id })
    await load()
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Need-to-know Compartments</CardTitle>
            </div>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />New Compartment
            </Button>
          </div>
          <CardDescription>
            Compartments are an orthogonal axis to classification. An artifact tagged
            <code className="mx-1 px-1 rounded bg-muted text-foreground">[SI//NOFORN]</code>
            is visible only to actors holding grants for ALL listed compartments.
            Heimdall ships no defaults — real codewords are themselves classified, so define your own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />Loading…
            </div>
          ) : list.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              No compartments defined. Click <strong>New Compartment</strong> to create one
              (e.g. <code className="font-mono">SI</code> for SIGINT, <code className="font-mono">HCS</code> for HUMINT
              control system, <code className="font-mono">NOFORN</code> for No Foreign Nationals).
            </div>
          ) : (
            <div className="space-y-2">
              {list.map((c) => (
                <div key={c.id} className="flex items-center gap-3 p-3 rounded border border-border bg-card/30 hover:bg-accent/30">
                  <span
                    className="font-mono font-bold text-xs px-2 py-1 rounded shrink-0 border"
                    style={c.color ? { background: `${c.color}22`, color: c.color, borderColor: `${c.color}66` } : { background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', borderColor: 'rgba(245, 158, 11, 0.4)' }}
                  >
                    {c.ticket}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{c.name}</div>
                    {c.description && <div className="text-xs text-muted-foreground mt-0.5">{c.description}</div>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {c.granted ? 'Granted' : 'Not granted'}
                    </span>
                    <Switch checked={c.granted} onCheckedChange={() => toggleGrant(c)} />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => removeCompartment(c)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How compartments work</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside">
            <li>An artifact tagged <code className="font-mono">[A, B]</code> is visible only to actors with active grants for <strong>both</strong> A AND B.</li>
            <li>An artifact with no compartment tags is visible to anyone within their classification clearance.</li>
            <li>Every grant / revoke / compartment create / delete / artifact tag is recorded in the tamper-evident audit chain.</li>
            <li>When you revoke a grant, every artifact tagged with that compartment becomes invisible to you immediately on next refresh — but the data remains in the database for analysts who do hold it.</li>
            <li>Multi-user RBAC (Theme 10.10) will let an Admin grant tickets to other analysts. Today, Heimdall is single-user — you grant your own.</li>
          </ul>
        </CardContent>
      </Card>

      <CreateCompartmentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); void load() }}
      />
    </div>
  )
}

function CreateCompartmentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [ticket, setTicket] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) { setTicket(''); setName(''); setDescription(''); setColor(''); setError(null) }
  }, [open])

  const submit = async () => {
    if (!ticket.trim() || !name.trim()) {
      setError('Ticket and Name are both required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await window.heimdall.invoke('compartments:create', {
        ticket: ticket.trim(), name: name.trim(),
        description: description.trim() || undefined,
        color: color.trim() || undefined
      })
      onCreated()
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Lock className="h-4 w-4" />New Compartment</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Ticket</Label>
            <Input value={ticket} onChange={(e) => setTicket(e.target.value.toUpperCase())} placeholder="SI" maxLength={32} />
            <p className="text-[10px] text-muted-foreground mt-1">Short uppercase code. A–Z 0–9 _, must start with a letter.</p>
          </div>
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Special Intelligence (SIGINT)"' />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this compartment covers" />
          </div>
          <div>
            <Label>Color (optional, hex)</Label>
            <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#fbbf24" />
          </div>
          {error && <p className="text-xs text-red-300">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><X className="h-3.5 w-3.5 mr-1.5" />Cancel</Button>
          <Button onClick={submit} disabled={submitting || !ticket.trim() || !name.trim()}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1.5" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
