import { useState, useEffect } from 'react'
import { Mail, Send, Check, X, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting, useTestConnection } from '@renderer/hooks/useSettings'
import type { SmtpConfig } from '@common/types/settings'

const DEFAULT_SMTP: SmtpConfig = {
  host: '',
  port: 587,
  username: '',
  password: '',
  tls: true,
  fromAddress: '',
  defaultRecipients: []
}

export function SmtpTab() {
  const { value: saved, save, saving } = useSetting<SmtpConfig>('smtp', DEFAULT_SMTP)
  const [config, setConfig] = useState<SmtpConfig>(DEFAULT_SMTP)
  const [recipientInput, setRecipientInput] = useState('')
  const [didSave, setDidSave] = useState(false)
  const { testing, result, test } = useTestConnection()

  useEffect(() => {
    if (saved && saved.host !== undefined) {
      setConfig(saved)
    }
  }, [saved])

  const update = (field: keyof SmtpConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  const addRecipient = () => {
    const email = recipientInput.trim()
    if (email && !config.defaultRecipients.includes(email)) {
      update('defaultRecipients', [...config.defaultRecipients, email])
      setRecipientInput('')
    }
  }

  const removeRecipient = (email: string) => {
    update('defaultRecipients', config.defaultRecipients.filter((r) => r !== email))
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">SMTP Configuration</CardTitle>
          </div>
          <CardDescription>
            Configure outgoing email for dispatching intelligence alerts to authorities.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>SMTP Host</Label>
              <Input
                value={config.host}
                onChange={(e) => update('host', e.target.value)}
                placeholder="smtp.gmail.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Port</Label>
              <Input
                type="number"
                value={config.port}
                onChange={(e) => update('port', parseInt(e.target.value) || 587)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input
                value={config.username}
                onChange={(e) => update('username', e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                type="password"
                value={config.password}
                onChange={(e) => update('password', e.target.value)}
                placeholder="App password or SMTP password"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>From Address</Label>
            <Input
              value={config.fromAddress}
              onChange={(e) => update('fromAddress', e.target.value)}
              placeholder="heimdall-alerts@example.com"
            />
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={config.tls} onCheckedChange={(v) => update('tls', v)} />
            <Label>Use TLS/STARTTLS</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Default Recipients</CardTitle>
          <CardDescription>Email addresses that receive all dispatched alerts by default.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRecipient()}
              placeholder="authority@example.com"
              className="flex-1"
            />
            <Button variant="outline" size="sm" onClick={addRecipient}>
              Add
            </Button>
          </div>
          {config.defaultRecipients.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {config.defaultRecipients.map((email) => (
                <Badge key={email} variant="secondary" className="gap-1">
                  {email}
                  <button onClick={() => removeRecipient(email)} className="hover:text-destructive">
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
          {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save SMTP Settings'}
        </Button>
        <Button
          variant="outline"
          onClick={() => test('Smtp', config)}
          disabled={testing || !config.host}
        >
          {testing ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing...</>
          ) : (
            <><Send className="h-4 w-4 mr-2" /> Send Test Email</>
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
