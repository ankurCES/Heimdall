import { useState, useEffect } from 'react'
import { ShieldCheck, Check, Lock, PlugZap, Flame, AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting } from '@renderer/hooks/useSettings'
import type { SafetyConfig } from '@common/types/settings'
import { CLASSIFICATION_LEVELS, type Classification, isClassification } from '@renderer/components/ClassificationBanner'

const DEFAULT_SAFETY: SafetyConfig = {
  rateLimitPerDomain: 30,
  respectRobotsTxt: true,
  airGapMode: false,
  airGapAllowlist: [],
  proxyUrl: '',
  retentionDays: 90
}

export function SafetyTab() {
  const { value: saved, save, saving } = useSetting<SafetyConfig>('safety', DEFAULT_SAFETY)
  const [config, setConfig] = useState<SafetyConfig>(DEFAULT_SAFETY)
  const [didSave, setDidSave] = useState(false)

  useEffect(() => {
    if (saved && saved.rateLimitPerDomain !== undefined) {
      setConfig(saved)
    }
  }, [saved])

  const update = (field: keyof SafetyConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Safety Controls</CardTitle>
          </div>
          <CardDescription>
            Heimdall is designed for ethical, legal intelligence gathering from public sources only.
            These controls ensure responsible data collection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Rate Limit (requests per minute per domain)</Label>
            <Input
              type="number"
              value={config.rateLimitPerDomain}
              onChange={(e) => update('rateLimitPerDomain', Math.max(1, parseInt(e.target.value) || 30))}
              className="w-32"
              min={1}
              max={120}
            />
            <p className="text-xs text-muted-foreground">
              Maximum HTTP requests per minute to any single domain. Lower values are more polite.
              Recommended: 30.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Respect robots.txt</Label>
              <p className="text-xs text-muted-foreground">
                Check and obey robots.txt rules before scraping any page. Strongly recommended.
              </p>
            </div>
            <Switch
              checked={config.respectRobotsTxt}
              onCheckedChange={(v) => update('respectRobotsTxt', v)}
            />
          </div>

          <div className="space-y-2">
            <Label>Data Retention (days)</Label>
            <Input
              type="number"
              value={config.retentionDays}
              onChange={(e) => update('retentionDays', Math.max(1, parseInt(e.target.value) || 90))}
              className="w-32"
              min={1}
              max={365}
            />
            <p className="text-xs text-muted-foreground">
              Automatically purge intelligence reports older than this many days. Default: 90.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Proxy Server (optional)</Label>
            <Input
              value={config.proxyUrl}
              onChange={(e) => update('proxyUrl', e.target.value)}
              placeholder="http://proxy.example.com:8080"
            />
            <p className="text-xs text-muted-foreground">
              Route all collector HTTP traffic through this proxy. Leave empty for direct connections.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Safety Statement</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>Heimdall is designed exclusively for public safety and operates under these principles:</p>
            <ul className="list-disc list-inside space-y-1 text-xs">
              <li>All data sources are publicly available — no unauthorized access</li>
              <li>Rate limiting and robots.txt compliance on every request</li>
              <li>Complete audit trail of all external data access</li>
              <li>No offensive capabilities — monitoring and alerting only</li>
              <li>Meshtastic integration only monitors channels the node is authorized for</li>
              <li>User-Agent header clearly identifies Heimdall on all requests</li>
              <li>Data retention limits ensure compliance with privacy principles</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={saving || didSave}>
        {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save Safety Settings'}
      </Button>

      <ClearanceCard />
      <EncryptionCard />
      <TwoPersonCard />
      <AirGapCard />
      <PanicWipeCard />
    </div>
  )
}

/**
 * User clearance level (single-user mode). Sets the highest classification
 * the analyst is allowed to view in this session. The top + bottom
 * classification banners on every page reflect this value.
 *
 * Multi-user RBAC + per-user clearance is Theme 10.10 — for now Heimdall
 * is single-user and the operating environment is presumed to enforce
 * physical access control to the host.
 */
function ClearanceCard() {
  const [clearance, setClearance] = useState<Classification>('UNCLASSIFIED')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const v = await window.heimdall.invoke('settings:get', { key: 'security.clearance' })
        if (isClassification(v)) setClearance(v)
      } catch {}
    })()
  }, [])

  const handle = async (next: Classification) => {
    setClearance(next)
    setSaving(true)
    try {
      await window.heimdall.invoke('settings:set', { key: 'security.clearance', value: next })
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Security Clearance</CardTitle>
        </div>
        <CardDescription>
          The highest classification level you are cleared to view in this session.
          Banners on every page reflect this value. Reports above your clearance
          remain in the database but are filtered from list views and detail panes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label>Current Clearance</Label>
          <Select value={clearance} onValueChange={(v) => handle(v as Classification)}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CLASSIFICATION_LEVELS.map((lvl) => (
                <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {saving && <p className="text-xs text-muted-foreground">Saving…</p>}
          {savedAt && !saving && (
            <p className="text-xs text-emerald-400">
              <Check className="inline h-3 w-3 mr-1" />
              Clearance set to {clearance} — banners refresh within 30 s
            </p>
          )}
        </div>
        <div className="text-xs text-muted-foreground border-t border-border pt-3">
          <p className="font-semibold mb-1">Order (lowest to highest):</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li><span className="font-mono">UNCLASSIFIED</span> — public information; no clearance required</li>
            <li><span className="font-mono">CONFIDENTIAL</span> — could damage national security if disclosed</li>
            <li><span className="font-mono">SECRET</span> — could cause serious damage to national security</li>
            <li><span className="font-mono">TOP SECRET</span> — could cause exceptionally grave damage</li>
          </ul>
          <p className="mt-3 italic">Every classification change is recorded in the tamper-evident audit chain (Audit Log → Tamper-Evident Chain).</p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * At-rest encryption (SQLCipher, Theme 10.3). One-click enable; subsequent
 * launches prompt for passphrase before any DB access. Passphrase is never
 * stored — SQLCipher derives the key at unlock time via PBKDF2-HMAC-SHA512
 * (256 000 iterations, 16-byte salt in the DB header).
 */
function EncryptionCard() {
  const [status, setStatus] = useState<{ enabled: boolean; enabled_at: number | null; db_path: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [enableOpen, setEnableOpen] = useState(false)
  const [changeOpen, setChangeOpen] = useState(false)
  const [pp1, setPp1] = useState('')
  const [pp2, setPp2] = useState('')
  const [oldPp, setOldPp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => { void refresh() }, [])

  async function refresh() {
    try {
      const s = await window.heimdall.invoke('encryption:status') as { enabled: boolean; enabled_at: number | null; db_path: string }
      setStatus(s)
    } catch { /* noop */ }
  }

  const submitEnable = async () => {
    setError(null)
    if (pp1.length < 8) return setError('Passphrase must be at least 8 characters.')
    if (pp1 !== pp2) return setError('Passphrases do not match.')
    setBusy(true)
    try {
      await window.heimdall.invoke('encryption:enable', pp1)
      setNotice('Encryption enabled. On next launch you will be prompted for this passphrase before the database unlocks.')
      setEnableOpen(false); setPp1(''); setPp2('')
      await refresh()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const submitChange = async () => {
    setError(null)
    if (pp1.length < 8) return setError('New passphrase must be at least 8 characters.')
    if (pp1 !== pp2) return setError('New passphrases do not match.')
    setBusy(true)
    try {
      await window.heimdall.invoke('encryption:change', { old: oldPp, next: pp1 })
      setNotice('Passphrase changed. Remember the new passphrase — there is no recovery path.')
      setChangeOpen(false); setOldPp(''); setPp1(''); setPp2('')
      await refresh()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">At-rest Encryption (SQLCipher)</CardTitle>
        </div>
        <CardDescription>
          Encrypt the local SQLite database with a passphrase. On subsequent
          launches Heimdall stays locked until you type it in. Passphrase is
          never stored anywhere — lose it and the data is unrecoverable.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 p-3 rounded border border-border bg-card/30">
          <div className={`h-2 w-2 rounded-full ${status?.enabled ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <div className="flex-1">
            <div className="text-sm font-medium">
              {status == null ? 'Loading…' : status.enabled ? 'Encryption enabled' : 'Encryption disabled'}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground break-all">{status?.db_path}</div>
          </div>
          {status && !status.enabled && (
            <Button size="sm" onClick={() => { setEnableOpen(true); setError(null); setNotice(null) }}>
              <Lock className="h-3.5 w-3.5 mr-1.5" />Enable
            </Button>
          )}
          {status && status.enabled && (
            <Button size="sm" variant="outline" onClick={() => { setChangeOpen(true); setError(null); setNotice(null) }}>
              Change passphrase
            </Button>
          )}
        </div>

        {notice && (
          <div className="text-xs p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
            {notice}
          </div>
        )}

        {enableOpen && (
          <div className="p-3 rounded border border-amber-500/40 bg-amber-500/5 space-y-3">
            <p className="text-xs text-amber-200">
              ⚠ Encryption is a one-way action in this release. A plaintext backup of
              your current database will be preserved next to it (look for
              <code className="mx-1 font-mono">heimdall.db.backup-&lt;timestamp&gt;</code>)
              so you can roll back manually if something goes wrong. The migration
              may take a few seconds on larger databases.
            </p>
            <div>
              <Label>New passphrase (min 8 chars)</Label>
              <Input type="password" value={pp1} onChange={(e) => setPp1(e.target.value)} />
            </div>
            <div>
              <Label>Confirm passphrase</Label>
              <Input type="password" value={pp2} onChange={(e) => setPp2(e.target.value)} />
            </div>
            {error && <p className="text-xs text-red-300">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setEnableOpen(false); setError(null) }}>Cancel</Button>
              <Button size="sm" onClick={submitEnable} disabled={busy || !pp1 || !pp2}>
                {busy ? 'Encrypting…' : 'Enable encryption'}
              </Button>
            </div>
          </div>
        )}

        {changeOpen && (
          <div className="p-3 rounded border border-border bg-card/30 space-y-3">
            <div>
              <Label>Current passphrase</Label>
              <Input type="password" value={oldPp} onChange={(e) => setOldPp(e.target.value)} />
            </div>
            <div>
              <Label>New passphrase (min 8 chars)</Label>
              <Input type="password" value={pp1} onChange={(e) => setPp1(e.target.value)} />
            </div>
            <div>
              <Label>Confirm new passphrase</Label>
              <Input type="password" value={pp2} onChange={(e) => setPp2(e.target.value)} />
            </div>
            {error && <p className="text-xs text-red-300">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setChangeOpen(false); setError(null) }}>Cancel</Button>
              <Button size="sm" onClick={submitChange} disabled={busy || !oldPp || !pp1 || !pp2}>
                {busy ? 'Rekeying…' : 'Change passphrase'}
              </Button>
            </div>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground pt-2 border-t border-border space-y-1">
          <p><strong>Algorithm:</strong> SQLCipher 4.x default — AES-256-CBC + HMAC-SHA512 per page, PBKDF2-HMAC-SHA512 KDF with 256 000 iterations and a 16-byte random salt stored in the DB header.</p>
          <p><strong>Scope:</strong> encrypts every byte of <code className="font-mono">heimdall.db</code> and its WAL/SHM companions. Vector index, Obsidian vault cache, and settings DB are <em>not</em> covered by this batch.</p>
          <p><strong>Recovery:</strong> none. Lose the passphrase → lose the data. Store it in a password manager or secure paper backup.</p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Two-person integrity — Theme 10.8. A separate passphrase required
 * to approve SECRET+ exports, panic wipe, encryption change, and
 * air-gap disable. Single-user mode; multi-user upgrades this to a
 * different authenticated user in Batch 5.
 */
function TwoPersonCard() {
  const [status, setStatus] = useState<{ enabled: boolean; has_passphrase: boolean } | null>(null)
  const [pp1, setPp1] = useState('')
  const [pp2, setPp2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = async () => {
    try { setStatus(await window.heimdall.invoke('twoperson:status') as { enabled: boolean; has_passphrase: boolean }) }
    catch { /* noop */ }
  }
  useEffect(() => { void load() }, [])

  const save = async () => {
    setError(null); setNotice(null)
    if (pp1.length < 8) { setError('Passphrase must be at least 8 characters.'); return }
    if (pp1 !== pp2) { setError('Passphrases do not match.'); return }
    try {
      await window.heimdall.invoke('twoperson:set_passphrase', pp1)
      setNotice('Two-person integrity enabled. SECRET+ exports and panic-wipe now require this passphrase.')
      setPp1(''); setPp2(''); setShowForm(false)
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const disable = async () => {
    try {
      await window.heimdall.invoke('twoperson:disable')
      setNotice('Two-person integrity disabled.')
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Two-person integrity</CardTitle>
        </div>
        <CardDescription>
          Require a separate passphrase to approve SECRET+ exports, panic-wipe,
          encryption changes, and air-gap toggles. The "second person" in
          single-user mode is a different passphrase; in multi-user mode it
          becomes a different authenticated user.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 p-3 rounded border border-border bg-card/30">
          <div className={`h-2 w-2 rounded-full ${status?.enabled ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
          <div className="flex-1 text-sm">
            {status == null ? 'Loading…' : status.enabled ? 'Enabled' : 'Disabled'}
          </div>
          {status?.enabled ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>Change passphrase</Button>
              <Button size="sm" variant="ghost" onClick={disable}>Disable</Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Lock className="h-3.5 w-3.5 mr-1.5" />Enable
            </Button>
          )}
        </div>
        {notice && <div className="text-xs p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">{notice}</div>}
        {showForm && (
          <div className="p-3 rounded border border-amber-500/40 bg-amber-500/5 space-y-3">
            <div>
              <Label>{status?.enabled ? 'New passphrase' : 'Second-person passphrase'} (min 8 chars)</Label>
              <Input type="password" value={pp1} onChange={(e) => setPp1(e.target.value)} />
            </div>
            <div>
              <Label>Confirm passphrase</Label>
              <Input type="password" value={pp2} onChange={(e) => setPp2(e.target.value)} />
            </div>
            {error && <p className="text-xs text-red-300">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setShowForm(false); setError(null) }}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={!pp1 || !pp2}>
                {status?.enabled ? 'Update' : 'Enable'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Air-gap mode — Theme 10.6. When enabled, SafeFetcher refuses any
 * outbound fetch whose hostname isn't on the allowlist (exact or DNS
 * suffix match). Intended for SCIF / classified deployments.
 */
function AirGapCard() {
  const { value: saved, save } = useSetting<SafetyConfig>('safety', DEFAULT_SAFETY)
  const [enabled, setEnabled] = useState(false)
  const [allowlist, setAllowlist] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)

  useEffect(() => {
    if (saved) {
      setEnabled(saved.airGapMode ?? false)
      setAllowlist((saved.airGapAllowlist ?? []).join('\n'))
    }
  }, [saved])

  const handleSave = async () => {
    setSaving(true)
    try {
      const list = allowlist.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      await save({ ...saved, airGapMode: enabled, airGapAllowlist: list } as SafetyConfig)
      await window.heimdall.invoke('safety:apply_airgap', { enabled, allowlist: list })
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(0), 2500)
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <PlugZap className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Air-gap mode</CardTitle>
        </div>
        <CardDescription>
          When enabled, every outbound HTTP fetch from any collector or
          service is refused unless the hostname matches the allowlist
          (exact or DNS-suffix match). Intended for SCIF-style deployments —
          doesn't touch inbound traffic.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Enable air-gap mode</Label>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div>
          <Label>Allowlist (one host per line, or space/comma separated)</Label>
          <textarea
            className="w-full mt-1 rounded border border-border bg-background p-2 text-sm font-mono min-h-[96px]"
            placeholder="internal.heimdall.local&#10;cve.mitre.org"
            value={allowlist}
            onChange={(e) => setAllowlist(e.target.value)}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            <code className="font-mono">example.com</code> matches{' '}
            <code className="font-mono">example.com</code> and{' '}
            <code className="font-mono">*.example.com</code>. Leave empty for
            a hard cut-off (nothing at all leaves the host).
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {savedAt ? <><Check className="h-4 w-4 mr-2" />Applied</> : 'Save & apply'}
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * Panic-wipe — Theme 10.7. Irreversibly destroys the local working set.
 * Renderer enforces a double confirmation (type the exact token, then
 * type DESTROY in a second field) before sending IPC. The service itself
 * also requires the token — defence in depth.
 */
function PanicWipeCard() {
  const TOKEN = 'WIPE-HEIMDALL'
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<string[]>([])
  const [token, setToken] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ removed_paths: string[]; failed_paths: Array<{ path: string; error: string }>; total_bytes_removed: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      void window.heimdall.invoke('safety:panic_wipe_targets').then((t) => setTargets(t as string[]))
    }
  }, [open])

  const wipe = async () => {
    setError(null)
    if (token !== TOKEN || confirm !== 'DESTROY') {
      setError('Exact token required and the second field must read "DESTROY".')
      return
    }
    setBusy(true)
    try {
      const r = await window.heimdall.invoke('safety:panic_wipe', { confirmation: token })
      setResult(r as { removed_paths: string[]; failed_paths: Array<{ path: string; error: string }>; total_bytes_removed: number })
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Flame className="h-5 w-5 text-red-400" />
          <CardTitle className="text-base">Panic-wipe</CardTitle>
        </div>
        <CardDescription>
          Irreversibly destroys the local database, migration backups,
          vector index, encryption marker, and browser caches. The process
          exits after the wipe — there is no recovery path.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open ? (
          <Button variant="destructive" onClick={() => { setOpen(true); setResult(null); setError(null); setToken(''); setConfirm('') }}>
            <Flame className="h-4 w-4 mr-2" />Start panic-wipe
          </Button>
        ) : result ? (
          <div className="p-3 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs space-y-2">
            <div className="flex items-center gap-2 font-semibold text-emerald-300">
              <Check className="h-3.5 w-3.5" />Wipe complete
            </div>
            <div>Removed {result.removed_paths.length} path{result.removed_paths.length === 1 ? '' : 's'} ({(result.total_bytes_removed / 1024 / 1024).toFixed(1)} MB).</div>
            {result.failed_paths.length > 0 && (
              <div className="text-red-300">
                {result.failed_paths.length} failure{result.failed_paths.length === 1 ? '' : 's'}:
                <ul className="list-disc list-inside mt-1">
                  {result.failed_paths.map((f) => (
                    <li key={f.path} className="font-mono text-[10px]">{f.path}: {f.error}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="italic text-muted-foreground">The app will quit in a few seconds.</div>
          </div>
        ) : (
          <div className="p-3 rounded border border-red-500/30 bg-red-500/5 space-y-3">
            <div className="flex items-start gap-2 text-xs text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">This operation is irreversible.</p>
                <p className="mt-1">
                  {targets.length} file/directory path{targets.length === 1 ? '' : 's'} will be destroyed.
                </p>
              </div>
            </div>
            <details className="text-[10px] text-muted-foreground">
              <summary className="cursor-pointer">What will be wiped ({targets.length} paths)</summary>
              <ul className="mt-1 font-mono text-[10px] max-h-32 overflow-auto pl-2">
                {targets.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </details>
            <div>
              <Label>Type exactly <code className="font-mono text-[10px]">{TOKEN}</code></Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
            </div>
            <div>
              <Label>Then type <code className="font-mono text-[10px]">DESTROY</code></Label>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="font-mono" />
            </div>
            {error && <p className="text-xs text-red-300">{error}</p>}
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="destructive" size="sm" onClick={wipe}
                disabled={busy || token !== TOKEN || confirm !== 'DESTROY'}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Flame className="h-3.5 w-3.5 mr-1.5" />}
                I understand — wipe everything
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
