import { useState } from 'react'
import { toast } from 'sonner'
import { Download, FileText, FileJson, FileType, Lock, Loader2, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator
} from '@renderer/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

/**
 * Reusable export menu — renders next to any analytical product (DPB
 * brief, ACH session, preliminary report, HUMINT, raw intel). Five
 * formats (Theme 9.4):
 *
 *   PDF       — printable, classification-banner-wrapped
 *   Markdown  — raw source for Obsidian / re-edit
 *   JSON      — structured payload for downstream tools
 *   INTREP    — NATO STANAG 5500-style text message
 *   Bundle    — AES-256-GCM-encrypted archive (passphrase prompted)
 *
 * Every export funnels through `export:write` IPC → ExportService → which
 * appends an `export.write` row to the tamper-evident audit chain.
 */

export type ExportSourceType = 'dpb' | 'ach' | 'preliminary' | 'humint' | 'intel'

interface ExportResult { ok: boolean; path?: string; bytes?: number; error?: string }

interface Props {
  source_type: ExportSourceType
  source_id: string
  /** Optional title for the dropdown trigger; default is just an icon. */
  triggerLabel?: string
  /** Compact = icon-only trigger; else "Export" button with label. */
  variant?: 'icon' | 'button'
  size?: 'sm' | 'default'
}

export function ExportMenu({ source_type, source_id, triggerLabel = 'Export', variant = 'button', size = 'sm' }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [bundleOpen, setBundleOpen] = useState(false)

  const run = async (format: 'pdf' | 'markdown' | 'json' | 'intrep') => {
    setBusy(format)
    try {
      const result = await window.heimdall.invoke('export:write', { format, source_type, source_id }) as ExportResult
      if (result.ok) {
        toast.success(`Exported ${format.toUpperCase()} (${formatBytes(result.bytes || 0)})`)
      } else if (result.error !== 'Export cancelled') {
        toast.error(`Export failed: ${result.error}`)
      }
    } catch (err) {
      toast.error(`Export failed: ${err}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === 'icon' ? (
            <Button size={size} variant="ghost" className="h-7 w-7 p-0" title="Export">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            </Button>
          ) : (
            <Button size={size} variant="outline" disabled={!!busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
              {triggerLabel}
              <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Export as</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => run('pdf')}>
            <FileType className="h-3.5 w-3.5 mr-2" />
            <div className="flex-1">
              <div>PDF</div>
              <div className="text-[10px] text-muted-foreground">printable, banner-wrapped</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => run('markdown')}>
            <FileText className="h-3.5 w-3.5 mr-2" />
            <div className="flex-1">
              <div>Markdown</div>
              <div className="text-[10px] text-muted-foreground">Obsidian / re-edit</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => run('json')}>
            <FileJson className="h-3.5 w-3.5 mr-2" />
            <div className="flex-1">
              <div>JSON</div>
              <div className="text-[10px] text-muted-foreground">structured payload</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => run('intrep')}>
            <FileText className="h-3.5 w-3.5 mr-2" />
            <div className="flex-1">
              <div>NATO INTREP</div>
              <div className="text-[10px] text-muted-foreground">STANAG 5500-style text</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setBundleOpen(true)}>
            <Lock className="h-3.5 w-3.5 mr-2" />
            <div className="flex-1">
              <div>Encrypted bundle</div>
              <div className="text-[10px] text-muted-foreground">AES-256 + passphrase</div>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BundleDialog
        open={bundleOpen}
        onClose={() => setBundleOpen(false)}
        onSubmit={async (passphrase) => {
          setBundleOpen(false)
          setBusy('bundle')
          try {
            const result = await window.heimdall.invoke('export:write', {
              format: 'bundle', source_type, source_id, passphrase
            }) as ExportResult
            if (result.ok) toast.success(`Encrypted bundle saved (${formatBytes(result.bytes || 0)})`)
            else if (result.error !== 'Export cancelled') toast.error(`Export failed: ${result.error}`)
          } catch (err) {
            toast.error(`Export failed: ${err}`)
          } finally {
            setBusy(null)
          }
        }}
      />
    </>
  )
}

function BundleDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (passphrase: string) => void }) {
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (pass.length < 8) return setError('Passphrase must be at least 8 characters.')
    if (pass !== confirm) return setError('Passphrases do not match.')
    setError(null)
    setPass(''); setConfirm('')
    onSubmit(pass)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setPass(''); setConfirm(''); setError(null); onClose() } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Lock className="h-4 w-4" />Encrypted Bundle</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          <p className="text-muted-foreground">
            The bundle is encrypted with AES-256-GCM using a key derived from your passphrase
            (scrypt N=16384). Heimdall uses its own format — anyone with the passphrase can
            import it on the receiving side.
          </p>
          <div>
            <Label>Passphrase</Label>
            <Input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <div>
            <Label>Confirm Passphrase</Label>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter" />
          </div>
          {error && <p className="text-red-300">{error}</p>}
          <p className="text-amber-300/90 text-[11px]">⚠ The passphrase cannot be recovered. Store it securely.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!pass || !confirm}>
            <Lock className="h-3.5 w-3.5 mr-1.5" />Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
