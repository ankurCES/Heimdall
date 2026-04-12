import { useState, useEffect } from 'react'
import { Brain, Check } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting } from '@renderer/hooks/useSettings'
import type { LlmConfig } from '@common/types/settings'

const DEFAULT_LLM: LlmConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4o-mini',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2'
}

const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
  ollama: []
}

export function LlmTab() {
  const { value: saved, save, saving } = useSetting<LlmConfig>('llm', DEFAULT_LLM)
  const [config, setConfig] = useState<LlmConfig>(DEFAULT_LLM)
  const [didSave, setDidSave] = useState(false)

  useEffect(() => {
    if (saved && saved.provider !== undefined) {
      setConfig(saved)
    }
  }, [saved])

  const update = (field: keyof LlmConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  const models = PROVIDER_MODELS[config.provider] || []

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">LLM Provider</CardTitle>
          </div>
          <CardDescription>
            Configure the AI model used for intel analysis, chat, and agent orchestration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={config.provider} onValueChange={(v) => update('provider', v)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="ollama">Ollama (Local)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {config.provider !== 'ollama' && (
            <>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={config.apiKey}
                  onChange={(e) => update('apiKey', e.target.value)}
                  placeholder={config.provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                />
                <p className="text-xs text-muted-foreground">
                  This can also be configured in the API Keys tab.
                </p>
              </div>
              {models.length > 0 && (
                <div className="space-y-2">
                  <Label>Model</Label>
                  <Select value={config.model} onValueChange={(v) => update('model', v)}>
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          {config.provider === 'ollama' && (
            <>
              <div className="space-y-2">
                <Label>Ollama Server URL</Label>
                <Input
                  value={config.ollamaUrl}
                  onChange={(e) => update('ollamaUrl', e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
              <div className="space-y-2">
                <Label>Model Name</Label>
                <Input
                  value={config.ollamaModel}
                  onChange={(e) => update('ollamaModel', e.target.value)}
                  placeholder="llama3.2"
                />
                <p className="text-xs text-muted-foreground">
                  Run `ollama pull modelname` to download models first.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Button onClick={handleSave} disabled={saving || didSave}>
        {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save LLM Settings'}
      </Button>
    </div>
  )
}
