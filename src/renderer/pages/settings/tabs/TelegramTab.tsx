import { useState, useEffect, useCallback } from 'react'
import { Send, Check, X, Loader2, Power, PowerOff, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting, useTestConnection } from '@renderer/hooks/useSettings'
import { toast } from 'sonner'
import { cn } from '@renderer/lib/utils'
import type { TelegramConfig } from '@common/types/settings'

const DEFAULT_TELEGRAM: TelegramConfig = {
  botToken: '',
  chatIds: [],
  messageFormat: 'markdown'
}

export function TelegramTab() {
  const { value: saved, save, saving } = useSetting<TelegramConfig>('telegram', DEFAULT_TELEGRAM)
  const [config, setConfig] = useState<TelegramConfig>(DEFAULT_TELEGRAM)
  const [chatIdInput, setChatIdInput] = useState('')
  const [didSave, setDidSave] = useState(false)
  const { testing, result, test } = useTestConnection()

  useEffect(() => {
    if (saved && saved.botToken !== undefined) {
      setConfig(saved)
    }
  }, [saved])

  const update = (field: keyof TelegramConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  const addChatId = () => {
    const id = chatIdInput.trim()
    if (id && !config.chatIds.includes(id)) {
      update('chatIds', [...config.chatIds, id])
      setChatIdInput('')
    }
  }

  const removeChatId = (id: string) => {
    update('chatIds', config.chatIds.filter((c) => c !== id))
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Telegram Bot Configuration</CardTitle>
          </div>
          <CardDescription>
            Configure a Telegram bot for dispatching intelligence alerts as a fallback channel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Bot Token</Label>
            <Input
              type="password"
              value={config.botToken}
              onChange={(e) => update('botToken', e.target.value)}
              placeholder="123456789:ABCdefGhIjKlMnOpQrStUvWxYz"
            />
            <p className="text-xs text-muted-foreground">
              Create a bot via @BotFather on Telegram to get a token.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Message Format</Label>
            <Select
              value={config.messageFormat}
              onValueChange={(v) => update('messageFormat', v)}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">Markdown</SelectItem>
                <SelectItem value="html">HTML</SelectItem>
                <SelectItem value="plain">Plain Text</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Target Chat IDs</CardTitle>
          <CardDescription>
            Chat or group IDs where alerts will be sent. Use @userinfobot to find your chat ID.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={chatIdInput}
              onChange={(e) => setChatIdInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addChatId()}
              placeholder="-1001234567890"
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={addChatId}>
              Add
            </Button>
          </div>
          {config.chatIds.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {config.chatIds.map((id) => (
                <Badge key={id} variant="secondary" className="gap-1">
                  {id}
                  <button onClick={() => removeChatId(id)} className="hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || didSave}>
          {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save Telegram Settings'}
        </Button>
        <Button
          variant="outline"
          onClick={() => test('Telegram', config)}
          disabled={testing || !config.botToken}
        >
          {testing ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing...</>
          ) : (
            <><Send className="h-4 w-4 mr-2" /> Send Test Message</>
          )}
        </Button>
        {result && (
          <Badge variant={result.success ? 'success' : 'error'}>
            {result.message}
          </Badge>
        )}
      </div>

      {/* ── Telegram Intel Receiver Bot ── */}
      <TelegramIntelReceiverConfig />
    </div>
  )
}

/**
 * Configuration section for the Telegram Intel Receiver bot — a separate
 * bot token that listens for incoming DMs + group messages and queues them
 * for analyst review on the Telegram Intel page.
 */
function TelegramIntelReceiverConfig() {
  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])
  const [token, setToken] = useState('')
  const [pollInterval, setPollInterval] = useState(5000)
  const [autoStart, setAutoStart] = useState(true)
  const [status, setStatus] = useState<{
    running: boolean; botUsername: string | null; lastPollAt: number | null
    totalReceived: number; pendingCount: number; lastError: string | null
  } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; username?: string; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [didSave, setDidSave] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke('telegram-intel:get_config') as { botToken: string; pollInterval: number; autoStart: boolean }
      setToken(cfg.botToken || '')
      setPollInterval(cfg.pollInterval)
      setAutoStart(cfg.autoStart)
    } catch { /* */ }
  }, [invoke])

  const loadStatus = useCallback(async () => {
    try {
      const s = await invoke('telegram-intel:status')
      setStatus(s as typeof status)
    } catch { /* */ }
  }, [invoke])

  useEffect(() => { void loadConfig(); void loadStatus() }, [loadConfig, loadStatus])

  // Live status updates.
  useEffect(() => {
    const unsub = window.heimdall.on('telegram-intel:status_update', (s: unknown) => {
      setStatus(s as typeof status)
    })
    return () => { unsub() }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await invoke('telegram-intel:set_config', { botToken: token, pollInterval, autoStart })
      setDidSave(true)
      toast.success('Telegram Intel config saved')
      setTimeout(() => setDidSave(false), 2000)
    } finally { setSaving(false) }
  }

  const handleTest = async () => {
    if (!token.trim()) return
    setTesting(true); setTestResult(null)
    try {
      const r = await invoke('telegram-intel:test_token', { token: token.trim() }) as { ok: boolean; username?: string; error?: string }
      setTestResult(r)
      if (r.ok) toast.success(`Bot verified: @${r.username}`)
      else toast.error('Token invalid', { description: r.error })
    } finally { setTesting(false) }
  }

  const handleStartStop = async () => {
    setBusy(true)
    try {
      if (status?.running) {
        await invoke('telegram-intel:stop')
        toast.message('Receiver stopped')
      } else {
        const r = await invoke('telegram-intel:start') as { ok: boolean; error?: string }
        if (r.ok) toast.success('Receiver started')
        else toast.error('Start failed', { description: r.error })
      }
      void loadStatus()
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="border-t border-border my-4" />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Send className="h-5 w-5 text-blue-400" />
                Telegram Intel Receiver Bot
                {status && (
                  <Badge className={cn('text-[10px] border', status.running
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-muted text-muted-foreground border-border'
                  )}>
                    {status.running ? `@${status.botUsername || 'running'}` : 'stopped'}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                A <strong>separate bot</strong> that listens for incoming DMs and group messages.
                Every message lands in a review queue (Telegram Intel page in the sidebar).
                Approved messages go through the full intel ingestion pipeline — URL fetching,
                .onion deep-crawl, IMINT vision analysis, enrichment, and relationship graph building.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => void loadStatus()} title="Refresh status">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant={status?.running ? 'outline' : 'default'}
                onClick={handleStartStop} disabled={busy || !token.trim()}
                className={status?.running ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : ''}>
                {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> :
                  status?.running ? <PowerOff className="h-3.5 w-3.5 mr-1.5" /> : <Power className="h-3.5 w-3.5 mr-1.5" />}
                {status?.running ? 'Stop' : 'Start'} Receiver
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Bot token */}
          <div className="space-y-2">
            <Label>Receiver Bot Token</Label>
            <div className="flex gap-2">
              <Input
                type="password"
                value={token}
                onChange={(e) => { setToken(e.target.value); setDidSave(false); setTestResult(null) }}
                placeholder="987654321:ZyXwVuTsRqPoNmLkJiHgFeDcBa"
                className="flex-1"
              />
              <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || !token.trim()}>
                {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                Test
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Create a <strong>separate</strong> bot via @BotFather for the receiver — don't reuse the alert bot.
              This bot only reads incoming messages; it never sends anything.
            </p>
            {testResult && (
              <Badge variant={testResult.ok ? 'default' : 'destructive'} className="text-xs">
                {testResult.ok ? `✓ @${testResult.username}` : `✗ ${testResult.error}`}
              </Badge>
            )}
          </div>

          {/* Poll interval */}
          <div className="space-y-2">
            <Label>Poll interval</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                value={pollInterval / 1000}
                onChange={(e) => { setPollInterval(Math.max(2, Math.min(60, Number(e.target.value) || 5)) * 1000); setDidSave(false) }}
                className="w-24"
                min={2} max={60}
              />
              <span className="text-xs text-muted-foreground">seconds (2–60)</span>
            </div>
          </div>

          {/* Auto-start */}
          <div className="flex items-center gap-3">
            <Switch checked={autoStart} onCheckedChange={(v) => { setAutoStart(v); setDidSave(false) }} />
            <div>
              <Label>Auto-start on boot</Label>
              <p className="text-xs text-muted-foreground">Begin polling automatically when Heimdall starts.</p>
            </div>
          </div>

          {/* Status details */}
          {status && status.running && (
            <div className="rounded border border-border bg-muted/30 p-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total received:</span>
                <span>{status.totalReceived}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pending review:</span>
                <span className="text-amber-300">{status.pendingCount}</span>
              </div>
              {status.lastPollAt && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last poll:</span>
                  <span>{new Date(status.lastPollAt).toLocaleTimeString()}</span>
                </div>
              )}
              {status.lastError && (
                <div className="text-red-300 text-[10px] mt-1 break-words">Error: {status.lastError}</div>
              )}
            </div>
          )}

          <Button onClick={handleSave} disabled={saving || didSave}>
            {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save Receiver Settings'}
          </Button>
        </CardContent>
      </Card>
    </>
  )
}
