// TranscriptionTab — v1.4.9 settings UI for the transcription pipeline.
//
// Surfaces every transcription.* setting that previously was only
// settable via raw IPC, plus a one-click engine preflight and the
// auto-detected paths so the analyst can see what Heimdall is using
// without diving into logs.
//
// Sections:
//   1. Engine status            — green/amber/red banner + Re-check button
//   2. Local engine overrides   — manual binary path + model path
//   3. Audio quality            — denoise toggle (gated on ffmpeg presence)
//   4. Default language hint    — "auto" / ISO codes for whisper
//   5. Cloud fallback           — opt-in OpenAI-compatible endpoint + URL
//                                 + model name + allowCloud master switch
//
// Everything writes through the standard settings:set IPC so changes
// hot-reload into TranscriptionService.getConfig() without restart.

import { useEffect, useState, useCallback } from 'react'
import {
  Mic, Cpu, Server, Volume2, Languages, Cloud, RefreshCw,
  CheckCircle2, AlertCircle, Save, Loader2, Folder, HardDrive
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting } from '@renderer/hooks/useSettings'
import { cn } from '@renderer/lib/utils'

interface EngineStatus {
  ok: boolean
  engine: string | null
  message: string
}

interface BinaryStatus {
  whisper: string | null
  ffmpeg: string | null
}

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect (recommended)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'fa', label: 'Persian / Farsi' },
  { value: 'tr', label: 'Turkish' },
  { value: 'ko', label: 'Korean' }
]

function StatusBanner({ status, recheck, busy }: {
  status: EngineStatus | null
  recheck: () => void
  busy: boolean
}) {
  if (!status) {
    return (
      <div className="border border-border rounded-md p-3 bg-muted/30 flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Checking transcription engine…</span>
      </div>
    )
  }
  return (
    <div className={cn(
      'border rounded-md p-3 flex items-center justify-between gap-2',
      status.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
    )}>
      <div className="flex items-center gap-2 min-w-0">
        {status.ok
          ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          : <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />}
        <div className="min-w-0">
          <div className={cn('text-sm font-medium', status.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
            {status.ok ? 'Transcription engine ready' : 'Transcription engine not configured'}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {status.engine ? `${status.engine} · ` : ''}{status.message}
          </div>
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={recheck} disabled={busy} className="h-8 shrink-0">
        <RefreshCw className={cn('h-3.5 w-3.5 mr-1', busy && 'animate-spin')} /> Re-check
      </Button>
    </div>
  )
}

/** Generic "save on blur / on toggle" text input with visible Save state. */
function SettingTextInput({ id, label, hint, placeholder, settingKey }: {
  id: string
  label: string
  hint?: string
  placeholder?: string
  settingKey: string
}) {
  const { value, save, saving } = useSetting<string>(settingKey, '')
  const [local, setLocal] = useState('')
  const [initialised, setInitialised] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  if (!initialised && value !== undefined) {
    setLocal(value || '')
    setInitialised(true)
  }
  const commit = async () => {
    if ((local || '') === (value || '')) return
    await save(local)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-sm">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
          placeholder={placeholder}
          className="font-mono text-xs"
        />
        <Button size="sm" variant={savedFlash ? 'outline' : 'default'} onClick={commit} disabled={saving} className="h-9 shrink-0">
          {savedFlash ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function TranscriptionTab() {
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [bin, setBin] = useState<BinaryStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const { value: language, save: saveLanguage } = useSetting<string>('transcription.language', 'auto')
  const { value: denoise, save: saveDenoise } = useSetting<boolean>('transcription.denoise', false)
  const { value: allowCloud, save: saveAllowCloud } = useSetting<boolean>('transcription.allowCloud', false)

  const checkEngine = useCallback(async () => {
    setBusy(true)
    try {
      const r = await window.heimdall.invoke('transcription:test_engine') as EngineStatus
      setEngine(r)
      const b = await window.heimdall.invoke('models:locate_binary') as BinaryStatus
      setBin({ whisper: b.whisper, ffmpeg: b.ffmpeg })
    } catch (err) {
      setEngine({ ok: false, engine: null, message: String(err) })
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { void checkEngine() }, [checkEngine])

  const ffmpegMissing = bin && !bin.ffmpeg

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mic className="h-4 w-4" /> Transcription Engine
          </CardTitle>
          <CardDescription>
            Heimdall transcribes audio &amp; video locally via whisper.cpp by default. The
            engine status below reflects what's actually wired up right now.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <StatusBanner status={engine} recheck={checkEngine} busy={busy} />
          {bin && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="border border-border rounded-md p-2.5 space-y-1">
                <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Cpu className="h-3 w-3" /> whisper-cli
                </div>
                <div className="text-xs font-mono break-all">
                  {bin.whisper ?? <span className="text-amber-600 dark:text-amber-400">not detected</span>}
                </div>
              </div>
              <div className="border border-border rounded-md p-2.5 space-y-1">
                <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Cpu className="h-3 w-3" /> ffmpeg
                </div>
                <div className="text-xs font-mono break-all">
                  {bin.ffmpeg ?? <span className="text-amber-600 dark:text-amber-400">not detected</span>}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Folder className="h-4 w-4" /> Manual overrides
          </CardTitle>
          <CardDescription>
            Leave blank to use Heimdall's auto-detected paths (recommended).
            Override only if you need a specific whisper.cpp build or model file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SettingTextInput
            id="transcription-binary"
            label="whisper-cli binary path"
            hint="Auto-detected from PATH and Homebrew prefixes when blank."
            placeholder="/opt/homebrew/bin/whisper-cli"
            settingKey="transcription.binaryPath"
          />
          <SettingTextInput
            id="transcription-model"
            label="ggml model file (.bin)"
            hint="Auto-resolved from Settings → Local Models when blank (multilingual base preferred)."
            placeholder="~/Library/Application Support/Heimdall/models/whisper/ggml-base.bin"
            settingKey="transcription.modelPath"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Languages className="h-4 w-4" /> Language &amp; quality
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="transcription-language" className="text-sm">Default language hint</Label>
            <select
              id="transcription-language"
              value={language ?? 'auto'}
              onChange={(e) => void saveLanguage(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Passed to whisper.cpp as <code className="text-[11px]">-l</code>. "Auto-detect" uses the model's
              built-in language ID; choose a specific code only when the audio is consistently in one language
              and the model is misclassifying it.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <div className="space-y-0.5 flex-1">
              <div className="flex items-center gap-2">
                <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
                <Label htmlFor="transcription-denoise" className="text-sm cursor-pointer">
                  Denoise audio before transcription
                </Label>
                {ffmpegMissing && <Badge variant="outline" className="text-[10px]">requires ffmpeg</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                Adds an FFT denoiser pass (<code className="text-[11px]">highpass + afftdn</code>) during
                ffmpeg transcode. Helps with noisy phone or field recordings; can clip sibilants on clean
                studio audio.
              </p>
            </div>
            <Switch
              id="transcription-denoise"
              checked={!!denoise}
              onCheckedChange={(v) => void saveDenoise(v)}
              disabled={!!ffmpegMissing}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Cloud className="h-4 w-4" /> Cloud fallback
          </CardTitle>
          <CardDescription>
            Optional. When enabled, Heimdall falls back to an OpenAI-compatible
            <code className="text-[11px] mx-1">/v1/audio/transcriptions</code>
            endpoint if the local engine fails or isn't configured. Off by default — never used unless
            you flip the master switch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="transcription-cloud" className="text-sm cursor-pointer">
                Allow cloud Whisper fallback
              </Label>
              <p className="text-xs text-muted-foreground">
                When OFF, all transcription stays on this machine. Recommended for sensitive material.
              </p>
            </div>
            <Switch
              id="transcription-cloud"
              checked={!!allowCloud}
              onCheckedChange={(v) => void saveAllowCloud(v)}
            />
          </div>

          <SettingTextInput
            id="transcription-cloud-endpoint"
            label="Self-hosted endpoint URL"
            hint="e.g. http://localhost:8000 (faster-whisper-server, whisperX). Leave blank to use api.openai.com."
            placeholder="https://api.openai.com"
            settingKey="transcription.cloudEndpoint"
          />
          <SettingTextInput
            id="transcription-cloud-model"
            label="Cloud model name"
            hint='Defaults to "whisper-1". Override if your endpoint exposes a different model id.'
            placeholder="whisper-1"
            settingKey="transcription.cloudModel"
          />
          <SettingTextInput
            id="transcription-cloud-key"
            label="Cloud API key (overrides apikeys.openai)"
            hint="Leave blank to reuse the OpenAI API key from the API Keys tab."
            placeholder="sk-…"
            settingKey="transcription.cloudApiKey"
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Server className="h-3 w-3" />
        <span>Local-first. All transcription is offline-safe unless cloud fallback is explicitly enabled.</span>
      </div>
    </div>
  )
}
