import { useState, useEffect } from 'react'
import { BookOpen, Check, Loader2, Link2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting, useTestConnection } from '@renderer/hooks/useSettings'
import type { ObsidianConfig } from '@common/types/settings'

const DEFAULT_OBSIDIAN: ObsidianConfig = {
  apiKey: '',
  baseUrl: 'https://127.0.0.1:27124',
  vaultPath: '',
  syncEnabled: false,
  syncFolder: 'Heimdall'
}

export function ObsidianTab() {
  const { value: saved, save, saving } = useSetting<ObsidianConfig>('obsidian', DEFAULT_OBSIDIAN)
  const [config, setConfig] = useState<ObsidianConfig>(DEFAULT_OBSIDIAN)
  const [didSave, setDidSave] = useState(false)
  const { testing, result, test } = useTestConnection()

  useEffect(() => {
    if (saved && saved.baseUrl !== undefined) {
      setConfig(saved)
    }
  }, [saved])

  // Sync API key from API Keys tab if obsidian config is empty
  useEffect(() => {
    if (config.apiKey) return
    window.heimdall.invoke('settings:get', { key: 'apikeys.obsidian' }).then((key) => {
      if (key && typeof key === 'string') setConfig((prev) => ({ ...prev, apiKey: key }))
    }).catch(() => {})
  }, [config.apiKey])

  const update = (field: keyof ObsidianConfig, value: unknown) => {
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
            <BookOpen className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Obsidian Local REST API</CardTitle>
          </div>
          <CardDescription>
            Connect to your Obsidian vault to view and search intelligence reports.
            Requires the <a href="https://github.com/coddingtonbear/obsidian-local-rest-api" className="text-primary underline" target="_blank" rel="noreferrer">Local REST API plugin</a> installed in Obsidian.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              value={config.apiKey}
              onChange={(e) => update('apiKey', e.target.value)}
              placeholder="Found in Obsidian Settings → Local REST API"
            />
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input
              value={config.baseUrl}
              onChange={(e) => update('baseUrl', e.target.value)}
              placeholder="https://127.0.0.1:27124"
            />
            <p className="text-xs text-muted-foreground">
              Default: https://127.0.0.1:27124. Uses self-signed certificate.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-Sync to Obsidian</CardTitle>
          <CardDescription>
            Automatically push collected intelligence reports to your Obsidian vault as markdown files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Auto-Sync</Label>
              <p className="text-xs text-muted-foreground">
                Push new reports to Obsidian vault in real-time
              </p>
            </div>
            <Switch
              checked={config.syncEnabled}
              onCheckedChange={(v) => update('syncEnabled', v)}
            />
          </div>

          {config.syncEnabled && (
            <div className="space-y-2 pl-4 border-l-2 border-primary/30">
              <Label>Vault Folder</Label>
              <Input
                value={config.syncFolder}
                onChange={(e) => update('syncFolder', e.target.value)}
                placeholder="Heimdall"
              />
              <p className="text-xs text-muted-foreground">
                Reports will be organized as: {config.syncFolder || 'Heimdall'}/[discipline]/[date]/[report].md
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || didSave}>
          {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save Obsidian Settings'}
        </Button>
        <Button
          variant="outline"
          onClick={() => test('Obsidian')}
          disabled={testing || !config.apiKey}
        >
          {testing ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing...</>
          ) : (
            <><Link2 className="h-4 w-4 mr-2" /> Test Connection</>
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
