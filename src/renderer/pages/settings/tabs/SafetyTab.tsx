import { useState, useEffect } from 'react'
import { ShieldCheck, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { useSetting } from '@renderer/hooks/useSettings'
import type { SafetyConfig } from '@common/types/settings'

const DEFAULT_SAFETY: SafetyConfig = {
  rateLimitPerDomain: 30,
  respectRobotsTxt: true,
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
    </div>
  )
}
