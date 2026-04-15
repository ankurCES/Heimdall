import { useState } from 'react'
import { Eye, EyeOff, Save, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting } from '@renderer/hooks/useSettings'

interface ApiKeyConfig {
  service: string
  label: string
  description: string
  category: string
}

const API_KEY_CONFIGS: ApiKeyConfig[] = [
  { service: 'openai', label: 'OpenAI API Key', description: 'For LLM analysis (GPT-4o)', category: 'LLM Providers' },
  { service: 'anthropic', label: 'Anthropic API Key', description: 'For LLM analysis (Claude)', category: 'LLM Providers' },
  { service: 'ollama_cloud', label: 'Ollama Cloud API Key', description: 'For LLM analysis via Ollama Cloud', category: 'LLM Providers' },
  { service: 'openrouter', label: 'OpenRouter API Key', description: 'Multi-model LLM gateway', category: 'LLM Providers' },
  { service: 'groq', label: 'Groq API Key', description: 'Fast inference (Llama, Mixtral)', category: 'LLM Providers' },
  { service: 'twitter', label: 'Twitter/X Bearer Token', description: 'SOCMINT — public tweet search', category: 'Social Media' },
  { service: 'reddit_client_id', label: 'Reddit Client ID', description: 'SOCMINT — subreddit monitoring', category: 'Social Media' },
  { service: 'reddit_client_secret', label: 'Reddit Client Secret', description: 'SOCMINT — OAuth2 auth', category: 'Social Media' },
  { service: 'otx', label: 'AlienVault OTX API Key', description: 'CYBINT — threat intelligence feeds', category: 'Threat Intel' },
  { service: 'shodan', label: 'Shodan API Key', description: 'CYBINT — device/network scanning', category: 'Threat Intel' },
  { service: 'hibp', label: 'HaveIBeenPwned API Key', description: 'CI — breach monitoring', category: 'Threat Intel' },
  { service: 'virustotal', label: 'VirusTotal API Key', description: 'CYBINT — malware analysis', category: 'Threat Intel' },
  { service: 'gnews', label: 'GNews API Key', description: 'OSINT — global news search (100 req/day free)', category: 'News & Data' },
  { service: 'datagov', label: 'Data.gov API Key', description: 'FBI Crime Data Explorer (free at api.data.gov/signup)', category: 'Government Data' },
  { service: 'obsidian', label: 'Obsidian Local REST API Key', description: 'Connect to Obsidian vault for intel visualization', category: 'Integrations' },
  { service: 'alpaca_key_id', label: 'Alpaca API Key ID', description: 'US stock market data (free at alpaca.markets/signup)', category: 'Markets' },
  { service: 'alpaca_secret', label: 'Alpaca API Secret', description: 'US stock market data — paired with Key ID', category: 'Markets' },
  { service: 'finnhub', label: 'Finnhub API Key', description: 'Stock quotes, fundamentals, news (free tier 60 calls/min)', category: 'Markets' },
  { service: 'polygon', label: 'Polygon.io API Key', description: 'Stocks, options, crypto data (free tier available)', category: 'Markets' }
]

function ApiKeyRow({ config }: { config: ApiKeyConfig }) {
  const { value, save, saving } = useSetting<string>(`apikeys.${config.service}`, '')
  const [localValue, setLocalValue] = useState('')
  const [visible, setVisible] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [saved, setSaved] = useState(false)

  if (!initialized && value) {
    setLocalValue(value)
    setInitialized(true)
  }

  const handleSave = async () => {
    await save(localValue)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const isConfigured = value !== '' && value !== undefined

  return (
    <div className="flex items-center gap-3 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">{config.label}</Label>
          {isConfigured && <Badge variant="success" className="text-[10px]">Configured</Badge>}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{config.description}</p>
      </div>
      <div className="flex items-center gap-2 w-80">
        <div className="relative flex-1">
          <Input
            type={visible ? 'text' : 'password'}
            value={localValue}
            onChange={(e) => { setLocalValue(e.target.value); setSaved(false) }}
            placeholder="Enter API key..."
            className="pr-8"
          />
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving || saved} variant={saved ? 'outline' : 'default'}>
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export function ApiKeysTab() {
  const categories = [...new Set(API_KEY_CONFIGS.map((c) => c.category))]

  return (
    <div className="space-y-6">
      {categories.map((category) => (
        <Card key={category}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{category}</CardTitle>
            <CardDescription>Configure API keys for {category.toLowerCase()} integrations</CardDescription>
          </CardHeader>
          <CardContent>
            {API_KEY_CONFIGS.filter((c) => c.category === category).map((config) => (
              <ApiKeyRow key={config.service} config={config} />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
