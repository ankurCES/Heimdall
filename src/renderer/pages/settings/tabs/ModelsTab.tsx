// ModelsTab — v1.4.4 surface for the local-model auto-download manager.
//
// Shows every asset Heimdall manages locally (Whisper models,
// Tesseract data, future entries) with live progress, state badges,
// and per-row Download / Reinstall / Cancel controls. Subscribes to
// `models:status_update` so progress moves in real time without
// polling.
//
// Below the model list, a "Helper Binaries" panel shows whether the
// CLI tools we integrate with (whisper-cli, ffmpeg) are detected on
// PATH. On macOS the panel offers a one-click "Install via Homebrew"
// button (no sudo needed); on Linux/Windows it provides
// copy-pasteable install commands.

import { useEffect, useState, useCallback } from 'react'
import {
  Download,
  RefreshCw,
  X as XIcon,
  Check,
  AlertCircle,
  HardDrive,
  Cpu,
  Terminal,
  Copy,
  Loader2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Switch } from '@renderer/components/ui/switch'
import { Label } from '@renderer/components/ui/label'
import { useSetting } from '@renderer/hooks/useSettings'

interface AssetStatus {
  id: string
  description: string
  state: 'missing' | 'queued' | 'downloading' | 'verifying' | 'ready' | 'error' | 'unsupported_platform' | 'disabled'
  destPath: string
  bytesDone: number
  bytesTotal: number | null
  progress: number
  rateBps: number
  error: string | null
  installedAt: number | null
  sha256?: string
  optional: boolean
  requiredBy: string[]
}

interface BinaryStatus {
  whisper: string | null
  ffmpeg: string | null
  hints: {
    whisper: { platform: string; commands: string[] }[] | null
    ffmpeg: { platform: string; commands: string[] }[] | null
  }
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtRate(bps: number): string {
  if (!bps || bps < 1) return '—'
  return `${fmtBytes(bps)}/s`
}

function StateBadge({ state }: { state: AssetStatus['state'] }) {
  const variants: Record<AssetStatus['state'], { label: string; className: string }> = {
    ready: { label: 'Installed', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    missing: { label: 'Not installed', className: 'bg-muted text-muted-foreground' },
    queued: { label: 'Queued', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
    downloading: { label: 'Downloading', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
    verifying: { label: 'Verifying', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    error: { label: 'Error', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
    unsupported_platform: { label: 'Unsupported platform', className: 'bg-muted text-muted-foreground' },
    disabled: { label: 'Disabled', className: 'bg-muted text-muted-foreground' }
  }
  const v = variants[state]
  return <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${v.className}`}>{v.label}</span>
}

function ProgressBar({ progress, indeterminate = false }: { progress: number; indeterminate?: boolean }) {
  if (indeterminate) {
    return (
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div className="h-full w-1/3 bg-primary rounded-full animate-[slide_1.2s_ease-in-out_infinite]" />
      </div>
    )
  }
  return (
    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
      <div className="h-full bg-primary transition-all duration-300" style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }} />
    </div>
  )
}

function AssetRow({ asset, onAction }: { asset: AssetStatus; onAction: (action: 'download' | 'reinstall' | 'cancel', id: string) => void }) {
  const isActive = asset.state === 'downloading' || asset.state === 'verifying' || asset.state === 'queued'
  const showProgress = isActive || asset.state === 'ready'
  return (
    <div className="border border-border rounded-md p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{asset.description}</span>
            <StateBadge state={asset.state} />
            {asset.optional && <Badge variant="outline" className="text-[10px]">Optional</Badge>}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            <span className="font-mono">{asset.id}</span>
            {asset.requiredBy.length > 0 && (
              <span className="ml-2">· Used by: {asset.requiredBy.join('; ')}</span>
            )}
          </div>
          {asset.error && (
            <div className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {asset.error}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {asset.state === 'missing' || asset.state === 'error' ? (
            <Button size="sm" variant="default" onClick={() => onAction('download', asset.id)} className="h-7">
              <Download className="h-3.5 w-3.5 mr-1" /> Download
            </Button>
          ) : null}
          {isActive ? (
            <Button size="sm" variant="outline" onClick={() => onAction('cancel', asset.id)} className="h-7">
              <XIcon className="h-3.5 w-3.5 mr-1" /> Cancel
            </Button>
          ) : null}
          {asset.state === 'ready' ? (
            <Button size="sm" variant="ghost" onClick={() => onAction('reinstall', asset.id)} className="h-7">
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Reinstall
            </Button>
          ) : null}
        </div>
      </div>
      {showProgress && (
        <div className="space-y-1">
          <ProgressBar progress={asset.progress} indeterminate={isActive && (asset.bytesTotal == null)} />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>
              {fmtBytes(asset.bytesDone)} {asset.bytesTotal != null ? `/ ${fmtBytes(asset.bytesTotal)}` : ''}
              {asset.state === 'ready' && asset.installedAt && (
                <span className="ml-2">· installed {new Date(asset.installedAt).toLocaleString()}</span>
              )}
            </span>
            <span className="font-mono">
              {isActive ? fmtRate(asset.rateBps) : ''}
              {asset.state === 'ready' && asset.sha256 && <span title={asset.sha256}>sha256: {asset.sha256.slice(0, 8)}…</span>}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text)
}

function BinaryDetectionPanel() {
  const [bin, setBin] = useState<BinaryStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string>('')
  const [showLog, setShowLog] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await window.heimdall.invoke('models:locate_binary') as BinaryStatus
      setBin(r)
    } catch { /* */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

  const installViaBrew = async (formula: 'whisper-cpp' | 'ffmpeg') => {
    setBusy(formula)
    setShowLog(true)
    setInstallLog(`Running: brew install ${formula}\n`)
    try {
      const r = await window.heimdall.invoke('models:install_via_brew', { formula }) as { ok: boolean; output?: string; error?: string }
      setInstallLog((cur) => cur + (r.output || '') + '\n' + (r.ok ? `\n✓ ${formula} installed.` : `\n✗ ${r.error || 'Install failed'}`))
      if (r.ok) await refresh()
    } catch (err) {
      setInstallLog((cur) => cur + `\n✗ ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  if (!bin) return <div className="text-sm text-muted-foreground">Detecting…</div>

  return (
    <div className="space-y-3">
      {(['whisper', 'ffmpeg'] as const).map((tool) => {
        const detected = bin[tool]
        const hint = bin.hints[tool]
        const formula = tool === 'whisper' ? 'whisper-cpp' : 'ffmpeg'
        return (
          <div key={tool} className="border border-border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium capitalize">{tool}</span>
                {detected ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Check className="h-3 w-3" /> Detected
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400">Not found</span>
                )}
              </div>
              {!detected && isMac && (
                <Button size="sm" variant="default" onClick={() => installViaBrew(formula)} disabled={!!busy} className="h-7">
                  {busy === formula ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                  Install via brew
                </Button>
              )}
            </div>
            {detected ? (
              <div className="text-xs text-muted-foreground font-mono break-all">{detected}</div>
            ) : hint ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">
                  Heimdall couldn't find this on your PATH. Install with:
                </div>
                {hint.map((h) => (
                  <div key={h.platform} className="space-y-1">
                    <div className="text-[11px] font-medium text-muted-foreground">{h.platform}</div>
                    {h.commands.map((cmd) => (
                      <div key={cmd} className="flex items-center gap-1 bg-muted/40 rounded px-2 py-1">
                        <code className="text-[11px] font-mono flex-1 break-all">{cmd}</code>
                        <button
                          onClick={() => copyToClipboard(cmd)}
                          className="text-muted-foreground hover:text-foreground p-0.5"
                          title="Copy"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      {showLog && (
        <div className="border border-border rounded-md p-2 bg-black/90 text-emerald-300 max-h-64 overflow-auto">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[11px] text-muted-foreground">Install log</span>
            <button onClick={() => setShowLog(false)} className="text-muted-foreground hover:text-foreground"><XIcon className="h-3 w-3" /></button>
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words">{installLog}</pre>
        </div>
      )}
    </div>
  )
}

export function ModelsTab() {
  const [assets, setAssets] = useState<AssetStatus[]>([])
  const [showOptional, setShowOptional] = useState(false)
  const { value: autoDownload, save: saveAutoDownload } = useSetting<boolean>('models.autoDownload', true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const list = await window.heimdall.invoke('models:list') as AssetStatus[]
      setAssets(list)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // Subscribe to live status updates
    const off = window.heimdall.on('models:status_update', (...args: unknown[]) => {
      const update = args[0] as AssetStatus
      if (!update?.id || update.id.startsWith('brew:')) return  // brew progress doesn't replace asset rows
      setAssets((cur) => {
        const idx = cur.findIndex((a) => a.id === update.id)
        if (idx === -1) return [...cur, update]
        const next = cur.slice()
        next[idx] = update
        return next
      })
    })
    return () => { try { off() } catch { /* */ } }
  }, [load])

  const handleAction = async (action: 'download' | 'reinstall' | 'cancel', id: string) => {
    try {
      if (action === 'download') await window.heimdall.invoke('models:download_one', id)
      else if (action === 'reinstall') await window.heimdall.invoke('models:reinstall', id)
      else if (action === 'cancel') await window.heimdall.invoke('models:cancel', id)
    } catch (err) {
      // Status update will reflect the error; nothing else to do here
      console.warn(`models action ${action}/${id} failed:`, err)
    }
  }

  const runEnsureRequired = async () => {
    await window.heimdall.invoke('models:ensure_required')
    await load()
  }

  const visible = showOptional ? assets : assets.filter((a) => !a.optional)
  const totalReady = assets.filter((a) => a.state === 'ready').reduce((s, a) => s + (a.bytesTotal || a.bytesDone || 0), 0)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <HardDrive className="h-4 w-4" /> Local Models
              </CardTitle>
              <CardDescription>
                AI assets Heimdall downloads and manages locally.
                Total installed: {fmtBytes(totalReady)}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={runEnsureRequired} className="h-8">
                <Download className="h-3.5 w-3.5 mr-1" /> Fetch missing
              </Button>
              <Button size="sm" variant="ghost" onClick={load} disabled={refreshing} className="h-8">
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3 pb-2 border-b border-border">
            <div className="flex items-center gap-3">
              <Switch
                id="auto-download"
                checked={autoDownload ?? true}
                onCheckedChange={(v) => saveAutoDownload(v)}
              />
              <Label htmlFor="auto-download" className="text-sm cursor-pointer">
                Auto-download required models on startup
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="show-optional"
                checked={showOptional}
                onCheckedChange={setShowOptional}
              />
              <Label htmlFor="show-optional" className="text-sm cursor-pointer">
                Show optional models
              </Label>
            </div>
          </div>
          {visible.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">No models in this view.</div>
          ) : (
            visible.map((a) => <AssetRow key={a.id} asset={a} onAction={handleAction} />)
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4" /> Helper Binaries
          </CardTitle>
          <CardDescription>
            External CLI tools Heimdall integrates with but doesn't bundle.
            Required for whisper.cpp transcription and audio extraction from video.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BinaryDetectionPanel />
        </CardContent>
      </Card>
    </div>
  )
}
