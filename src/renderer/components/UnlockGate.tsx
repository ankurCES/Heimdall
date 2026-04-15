import { useEffect, useState, type ReactNode } from 'react'
import { Lock, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'

interface EncryptionStatus {
  enabled: boolean
  enabled_at: number | null
  db_unlocked: boolean
  db_path: string
  looks_encrypted: boolean
}

/**
 * Pre-boot unlock screen — Theme 10.3.
 *
 * If the main process reports that encryption is enabled and the DB is
 * still locked, the whole app is hidden behind this gate until a valid
 * passphrase is supplied. Once unlocked, we call `encryption:finish_boot`
 * (which emits `heimdall-unlocked` in the main process and runs deferred
 * init) and then render the real app tree.
 *
 * Failed attempts show an inline error. There is no retry throttle here —
 * SQLCipher's KDF cost already makes brute force computationally painful.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<EncryptionStatus | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void refreshStatus()
  }, [])

  async function refreshStatus() {
    try {
      const s = await window.heimdall.invoke('encryption:status') as EncryptionStatus
      setStatus(s)
    } catch (err) {
      setError(String(err))
    }
  }

  const submit = async () => {
    if (!passphrase) return
    setSubmitting(true)
    setError(null)
    try {
      await window.heimdall.invoke('encryption:unlock', passphrase)
      await window.heimdall.invoke('encryption:finish_boot')
      setPassphrase('')
      await refreshStatus()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally {
      setSubmitting(false)
    }
  }

  if (status == null) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />Checking encryption state…
      </div>
    )
  }

  // No encryption OR already unlocked → render the real app.
  if (!status.enabled || status.db_unlocked) {
    return <>{children}</>
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-12 w-12 rounded-full border border-amber-500/40 bg-amber-500/10">
            <Lock className="h-5 w-5 text-amber-300" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Heimdall is locked</h1>
            <p className="text-xs text-muted-foreground">At-rest encryption is active. Enter your passphrase to unlock the database.</p>
          </div>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-3">
          <div>
            <Label htmlFor="passphrase">Passphrase</Label>
            <Input
              id="passphrase"
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase…"
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <Button type="submit" disabled={!passphrase || submitting} className="w-full">
            {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
            Unlock
          </Button>
        </form>

        <div className="text-[10px] text-muted-foreground space-y-1 pt-2 border-t border-border">
          <p>Database: <span className="font-mono break-all">{status.db_path}</span></p>
          <p>
            SQLCipher (PBKDF2-HMAC-SHA512, 256 000 iterations). Passphrase is
            never stored. A wrong passphrase cannot be distinguished from
            file corruption — double-check capitals and layout before panicking.
          </p>
        </div>
      </div>
    </div>
  )
}
