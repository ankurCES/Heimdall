import { useEffect, useState } from 'react'
import { Lock, Shield, Save, Loader2, AlertTriangle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Switch } from '@renderer/components/ui/switch'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { toast } from 'sonner'

/**
 * Operational-Security configuration. Defaults to "paranoid" mode for
 * fresh installs (most restrictive).
 */

type OpSecMode = 'paranoid' | 'strict' | 'standard' | 'permissive'

interface OpSecConfig {
  mode: OpSecMode
  allowExternalTelemetry: boolean
  allowCloudLlm: boolean
  scrubLlmLogs: boolean
  airGapEnforced: boolean
  allowOutboundHostnames: string[]
  warnOnExternalCalls: boolean
  updatedAt: number
}

interface PostureResult {
  enforced: boolean
  suspectedViolations: Array<{ host: string; lastSeen: number; count: number }>
}

const MODE_LABELS: Record<OpSecMode, { label: string; desc: string; color: string }> = {
  paranoid:   { label: 'Paranoid',   desc: 'Air-gap enforced, no cloud LLM, scrub all logs, no telemetry. Most restrictive.', color: 'bg-red-500/10 text-red-300 border-red-500/30' },
  strict:     { label: 'Strict',     desc: 'Cloud LLM allowed but warns on every external call; logs scrubbed; no telemetry.', color: 'bg-orange-500/10 text-orange-300 border-orange-500/30' },
  standard:   { label: 'Standard',   desc: 'Cloud LLM allowed, logs scrubbed, no telemetry. Recommended for most deployments.', color: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  permissive: { label: 'Permissive', desc: 'All restrictions off. Development only — not for sensitive deployments.', color: 'bg-blue-500/10 text-blue-300 border-blue-500/30' }
}

export function OpSecTab() {
  const [config, setConfig] = useState<OpSecConfig | null>(null)
  const [posture, setPosture] = useState<PostureResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [allowList, setAllowList] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const r = await window.heimdall.invoke('opsec:config') as { ok: boolean; config?: OpSecConfig }
        if (r.ok && r.config) {
          setConfig(r.config)
          setAllowList(r.config.allowOutboundHostnames.join('\n'))
        }
        const p = await window.heimdall.invoke('opsec:posture') as { ok: boolean } & PostureResult
        if (p.ok) setPosture({ enforced: p.enforced, suspectedViolations: p.suspectedViolations })
      } catch (err) { toast.error(String(err)) }
      setLoading(false)
    })()
  }, [])

  const save = async () => {
    if (!config) return
    setSaving(true)
    try {
      const updated = {
        ...config,
        allowOutboundHostnames: allowList.split('\n').map((s) => s.trim()).filter(Boolean)
      }
      const r = await window.heimdall.invoke('opsec:update', updated) as { ok: boolean; config?: OpSecConfig }
      if (r.ok && r.config) {
        toast.success(`OPSEC mode: ${r.config.mode}`)
        setConfig(r.config)
        // Refresh posture after a save
        const p = await window.heimdall.invoke('opsec:posture') as { ok: boolean } & PostureResult
        if (p.ok) setPosture({ enforced: p.enforced, suspectedViolations: p.suspectedViolations })
      }
    } catch (err) { toast.error(String(err)) }
    setSaving(false)
  }

  const setMode = (mode: OpSecMode) => {
    if (!config) return
    setConfig({ ...config, mode })
  }

  if (loading || !config) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="space-y-6 p-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-emerald-400" />
        <div>
          <h2 className="text-xl font-semibold">Operational Security</h2>
          <p className="text-sm text-muted-foreground">
            Defaults to paranoid mode on fresh installs — relaxes only with a deliberate analyst choice.
          </p>
        </div>
      </div>

      {/* Mode picker */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Lock className="w-4 h-4" /> Mode preset</CardTitle>
          <CardDescription>Picking a mode applies the relevant toggles below. Individual toggles can be customized after.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2">
            {(['paranoid', 'strict', 'standard', 'permissive'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setMode(mode)}
                className={`text-left border rounded-md p-3 transition-colors ${
                  config.mode === mode ? MODE_LABELS[mode].color + ' ring-2 ring-current' : 'border-border hover:bg-accent'
                }`}
              >
                <div className="font-semibold text-sm capitalize mb-1">{MODE_LABELS[mode].label}</div>
                <div className="text-[10px] text-muted-foreground">{MODE_LABELS[mode].desc}</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Toggles */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Restrictions</CardTitle>
          <CardDescription>Customize individual restrictions. Changes take effect immediately on save.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            { key: 'airGapEnforced', label: 'Air-gap enforced', desc: 'Block all outbound HTTP except to listed allow-hosts.' },
            { key: 'allowCloudLlm', label: 'Allow cloud LLM connections', desc: 'When OFF, only locally-hosted Ollama / vLLM / etc. are usable.' },
            { key: 'scrubLlmLogs', label: 'Scrub LLM call logs', desc: 'Mask IPs, emails, classification markings, SSNs, BTC, hashes from app logs.' },
            { key: 'warnOnExternalCalls', label: 'Warn on external calls', desc: 'Toast a warning whenever a service makes a non-local network call.' },
            { key: 'allowExternalTelemetry', label: 'Allow external telemetry', desc: 'Should always be OFF in agency deployments. There is no Heimdall telemetry endpoint — this is a guard against future regressions.' }
          ].map((toggle) => (
            <div key={toggle.key} className="flex items-start gap-3">
              <Switch
                checked={config[toggle.key as keyof OpSecConfig] as boolean}
                onCheckedChange={(v) => setConfig({ ...config, [toggle.key]: v })}
              />
              <div className="flex-1">
                <Label className="cursor-pointer" onClick={() => setConfig({ ...config, [toggle.key]: !config[toggle.key as keyof OpSecConfig] })}>
                  {toggle.label}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">{toggle.desc}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Allow list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outbound allow-list</CardTitle>
          <CardDescription>
            One host per line. Wildcards: <code className="text-cyan-300">*.example.gov</code> matches any subdomain.
            Local addresses (RFC1918, loopback) are always allowed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            value={allowList}
            onChange={(e) => setAllowList(e.target.value)}
            rows={5}
            placeholder="proxy.agency.gov&#10;*.intel.gov&#10;192.168.1.50"
            className="w-full text-sm font-mono bg-card border border-border rounded p-2"
            disabled={!config.airGapEnforced}
          />
          {!config.airGapEnforced && (
            <p className="text-[10px] text-muted-foreground mt-1 italic">
              Allow-list is only consulted when air-gap is enforced.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Posture report */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className={`w-4 h-4 ${posture?.suspectedViolations.length ? 'text-amber-400' : 'text-emerald-400'}`} />
                Air-gap posture
              </CardTitle>
              <CardDescription>Last 6 hours of intel-report URLs scanned for non-local hosts.</CardDescription>
            </div>
            <Button onClick={async () => {
              const p = await window.heimdall.invoke('opsec:posture') as { ok: boolean } & PostureResult
              if (p.ok) setPosture({ enforced: p.enforced, suspectedViolations: p.suspectedViolations })
            }} size="sm" variant="outline">
              <RefreshCw className="w-4 h-4 mr-1" /> Re-scan
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!posture?.enforced ? (
            <p className="text-xs text-muted-foreground italic">Air-gap enforcement is off — posture scan is informational only when active.</p>
          ) : posture.suspectedViolations.length === 0 ? (
            <p className="text-xs text-emerald-300">✓ No suspected violations in the last 6 hours.</p>
          ) : (
            <div className="space-y-1">
              <p className="text-xs text-amber-300 mb-2">{posture.suspectedViolations.length} suspected violation(s):</p>
              {posture.suspectedViolations.map((v) => (
                <div key={v.host} className="text-xs flex items-center gap-2 px-3 py-1.5 border border-amber-500/30 rounded bg-amber-500/5">
                  <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-300 border-amber-500/30">{v.count}x</Badge>
                  <span className="font-mono">{v.host}</span>
                  <span className="ml-auto text-muted-foreground text-[10px]">{new Date(v.lastSeen).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 sticky bottom-0 bg-background py-2 border-t border-border -mx-6 px-6">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save OPSEC config
        </Button>
        <span className="text-[10px] text-muted-foreground ml-3">Last updated: {config.updatedAt ? new Date(config.updatedAt).toLocaleString() : 'never'}</span>
      </div>
    </div>
  )
}
