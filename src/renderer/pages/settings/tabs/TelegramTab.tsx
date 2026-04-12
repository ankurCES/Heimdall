import { useState, useEffect } from 'react'
import { Send, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting, useTestConnection } from '@renderer/hooks/useSettings'
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
    </div>
  )
}
