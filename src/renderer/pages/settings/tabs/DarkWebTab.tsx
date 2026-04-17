import { useState, useEffect } from 'react'
import { Globe2, AlertTriangle, Plus, X, Check, Loader2, Power, PowerOff, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting } from '@renderer/hooks/useSettings'
import type { DarkWebConfig } from '@common/types/settings'

interface TorState {
  status: 'stopped' | 'probing' | 'starting' | 'connected_external' | 'connected_managed' | 'error'
  socksHost: string
  socksPort: number
  managed: boolean
  bootstrapPercent: number | null
  lastError: string | null
  binaryPath: string | null
}

const DEFAULT: DarkWebConfig = {
  enabled: false,
  socks5Host: '127.0.0.1',
  socks5Port: 9050,
  ahmiaEnabled: true,
  darkSearchEnabled: false,
  watchTerms: ['ransomware', 'data leak', 'credentials', 'vulnerability']
}

/**
 * Dark Web settings — Theme 7.5.
 *
 * Three modes, configurable independently:
 *   1. Ahmia (clearnet, no Tor required) — always-safe to enable
 *   2. DarkSearch.io (clearnet REST API, ~30 req/day) — opt-in
 *   3. Direct .onion fetch (requires Tor SOCKS5) — opt-in, OPSEC warning
 *
 * Watch terms drive Ahmia + DarkSearch search queries. Custom .onion
 * sources are added via the Sources page using the `onion-feed` collector
 * type (link below).
 */
export function DarkWebTab() {
  const { value: saved, save, saving } = useSetting<DarkWebConfig>('darkWeb', DEFAULT)
  const [config, setConfig] = useState<DarkWebConfig>(DEFAULT)
  const [didSave, setDidSave] = useState(false)
  const [newTerm, setNewTerm] = useState('')

  // Tor on-demand state
  const [tor, setTor] = useState<TorState | null>(null)
  const [torBusy, setTorBusy] = useState(false)
  const [torMsg, setTorMsg] = useState<string | null>(null)

  const refreshTorStatus = async () => {
    try {
      const s = await window.heimdall.invoke('tor:status') as TorState
      setTor(s)
    } catch { /* ipc error ignored */ }
  }

  useEffect(() => { void refreshTorStatus() }, [])

  const torConnect = async () => {
    setTorBusy(true); setTorMsg(null)
    try {
      const r = await window.heimdall.invoke('tor:connect') as { ok: boolean; mode?: string; error?: string }
      if (!r.ok) setTorMsg(r.error || 'Tor connect failed')
      else setTorMsg(r.mode === 'external' ? 'Attached to existing Tor instance' : 'Managed Tor bootstrapped (100%)')
      await refreshTorStatus()
    } finally { setTorBusy(false) }
  }
  const torDisconnect = async () => {
    setTorBusy(true); setTorMsg(null)
    try {
      await window.heimdall.invoke('tor:disconnect')
      setTorMsg('Tor disconnected. .onion fetches will fail until reconnected.')
      await refreshTorStatus()
    } finally { setTorBusy(false) }
  }

  useEffect(() => {
    if (saved && typeof saved === 'object') setConfig({ ...DEFAULT, ...saved })
  }, [saved])

  const update = <K extends keyof DarkWebConfig>(field: K, value: DarkWebConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const addTerm = () => {
    if (!newTerm.trim()) return
    if (config.watchTerms.includes(newTerm.trim())) return
    update('watchTerms', [...config.watchTerms, newTerm.trim()])
    setNewTerm('')
  }
  const removeTerm = (t: string) => update('watchTerms', config.watchTerms.filter((x) => x !== t))

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  return (
    <div className="space-y-6">
      <div className="p-3 rounded border border-amber-500/40 bg-amber-500/5 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0 mt-0.5" />
        <div className="text-xs text-amber-200">
          <p className="font-semibold">OPSEC notice</p>
          <p className="mt-1">
            Dark-web scanning collects intelligence from .onion services. <strong>Ahmia and DarkSearch.io
            are clearnet</strong> — no Tor required, but the connections are still attributable to your IP.
            Direct .onion fetching requires Tor running locally; deployments must consider whether
            attribution to your egress IP is acceptable in your operational context.
          </p>
          <p className="mt-1">CSAM domain SHA-256 blocklist is always enforced in SafeFetcher.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Master switch</CardTitle>
            </div>
            <Switch checked={config.enabled} onCheckedChange={(v) => update('enabled', v)} />
          </div>
          <CardDescription>
            When off, all three dark-web collectors are disabled and SafeFetcher will not route
            through Tor even if SOCKS5 is configured.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Tor SOCKS5 proxy</CardTitle>
          <CardDescription>
            For direct .onion fetches via the <code className="font-mono">onion-feed</code> collector
            and (optionally) for routing chat-time dark-web queries. Default: 127.0.0.1:9050.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div>
            <Label>SOCKS5 host</Label>
            <Input value={config.socks5Host} onChange={(e) => update('socks5Host', e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label>SOCKS5 port</Label>
            <Input type="number" value={config.socks5Port} onChange={(e) => update('socks5Port', parseInt(e.target.value) || 9050)} className="font-mono" />
          </div>
        </CardContent>
      </Card>

      {/* On-demand Tor connection */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                On-demand Tor
                <TorStatusBadge state={tor} />
              </CardTitle>
              <CardDescription className="mt-1">
                Connect Heimdall to Tor only when you need it. We first probe the configured SOCKS5 port —
                if Tor is already running (e.g. from <code className="font-mono">brew services start tor</code> or the Tor Browser),
                we attach to that. Otherwise we spawn a managed <code className="font-mono">tor</code> child process if the binary
                is on PATH. While connected, all <code className="font-mono">.onion</code> fetches route through the proxy.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" variant="ghost" onClick={refreshTorStatus} disabled={torBusy} title="Refresh status">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              {tor && (tor.status === 'connected_external' || tor.status === 'connected_managed') ? (
                <Button size="sm" variant="outline" onClick={torDisconnect} disabled={torBusy}
                  className="border-red-500/30 text-red-400 hover:bg-red-500/10">
                  {torBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5 mr-1.5" />}
                  Disconnect
                </Button>
              ) : (
                <Button size="sm" onClick={torConnect} disabled={torBusy}>
                  {torBusy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Power className="h-3.5 w-3.5 mr-1.5" />}
                  Connect to Tor
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tor && tor.status === 'starting' && tor.bootstrapPercent !== null && (
            <div className="text-[11px] text-amber-300 mb-2">
              Bootstrapping Tor circuit… {tor.bootstrapPercent}%
              <div className="mt-1 h-1 bg-muted rounded overflow-hidden">
                <div className="h-full bg-amber-400 transition-all" style={{ width: `${tor.bootstrapPercent}%` }} />
              </div>
            </div>
          )}
          {tor && tor.status === 'error' && tor.lastError && (
            <div className="text-[11px] text-red-300 p-2 rounded bg-red-500/10 border border-red-500/30 break-words">
              <span className="font-semibold">Tor error:</span> {tor.lastError}
            </div>
          )}
          {torMsg && (
            <div className="text-[11px] text-muted-foreground mt-1">{torMsg}</div>
          )}
          {tor?.binaryPath && (
            <div className="text-[10px] text-muted-foreground mt-2">Managed binary: <code className="font-mono">{tor.binaryPath}</code></div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Ahmia (clearnet search)</CardTitle>
            <Switch checked={config.ahmiaEnabled} onCheckedChange={(v) => update('ahmiaEnabled', v)} />
          </div>
          <CardDescription>
            ahmia.fi is a clearnet search engine that indexes .onion sites. No auth, no API key, no Tor required.
            Default schedule: every 4 hours. Auto-seeded as a source on first run.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">DarkSearch.io</CardTitle>
            <Switch checked={config.darkSearchEnabled} onCheckedChange={(v) => update('darkSearchEnabled', v)} />
          </div>
          <CardDescription>
            Free REST API (~30 req/day, no auth). Disabled by default to preserve the rate budget.
            Add a manual source via the Sources page → type = <code className="font-mono">darksearch</code>.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Watch terms ({config.watchTerms.length})</CardTitle>
          <CardDescription>Default queries for Ahmia + DarkSearch. Per-source overrides supported.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {config.watchTerms.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border bg-card/30 text-xs">
                {t}
                <button onClick={() => removeTerm(t)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input value={newTerm} onChange={(e) => setNewTerm(e.target.value)}
              placeholder="Add a term…"
              onKeyDown={(e) => e.key === 'Enter' && addTerm()} />
            <Button size="sm" onClick={addTerm} disabled={!newTerm.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={saving || didSave}>
        {didSave ? <><Check className="h-4 w-4 mr-2" />Saved</> : saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving</> : 'Save settings'}
      </Button>

      <p className="text-[10px] text-muted-foreground italic">
        Changes take effect after the next collector run. Click "Connect to Tor" above to enable the SOCKS5 proxy immediately without restarting.
      </p>
    </div>
  )
}

/** Compact status pill for the on-demand Tor controls. */
function TorStatusBadge({ state }: { state: TorState | null }) {
  if (!state) return <Badge variant="outline" className="text-[10px]">unknown</Badge>
  switch (state.status) {
    case 'connected_external':
      return <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40 border">attached: {state.socksHost}:{state.socksPort}</Badge>
    case 'connected_managed':
      return <Badge className="text-[10px] bg-emerald-500/20 text-emerald-300 border-emerald-500/40 border">managed: {state.socksHost}:{state.socksPort}</Badge>
    case 'starting':
      return <Badge className="text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/40 border animate-pulse">starting {state.bootstrapPercent ?? 0}%</Badge>
    case 'probing':
      return <Badge className="text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/40 border animate-pulse">probing</Badge>
    case 'error':
      return <Badge className="text-[10px] bg-red-500/20 text-red-300 border-red-500/40 border">error</Badge>
    case 'stopped':
    default:
      return <Badge variant="outline" className="text-[10px]">disconnected</Badge>
  }
}
