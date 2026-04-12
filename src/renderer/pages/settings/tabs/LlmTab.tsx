import { useState, useEffect } from 'react'
import { Brain, Check, Loader2, Link2, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting } from '@renderer/hooks/useSettings'
import type { LlmConfig } from '@common/types/settings'

const DEFAULT_LLM: LlmConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  customModel: '',
  connected: false
}

const PRESETS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { label: 'Anthropic', url: 'https://api.anthropic.com/v1' },
  { label: 'Ollama (local)', url: 'http://localhost:11434/v1' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { label: 'Together AI', url: 'https://api.together.xyz/v1' },
  { label: 'Custom', url: '' }
]

export function LlmTab() {
  const { value: saved, save, saving } = useSetting<LlmConfig>('llm', DEFAULT_LLM)
  const [config, setConfig] = useState<LlmConfig>(DEFAULT_LLM)
  const [didSave, setDidSave] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [useCustomModel, setUseCustomModel] = useState(false)

  useEffect(() => {
    if (saved && saved.baseUrl !== undefined) {
      setConfig(saved)
      if (saved.customModel && !saved.model) setUseCustomModel(true)
    }
  }, [saved])

  const update = (field: keyof LlmConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const handleSave = async () => {
    const toSave = { ...config }
    if (useCustomModel) {
      toSave.model = toSave.customModel
    }
    await save(toSave)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.heimdall.invoke('settings:testLlm', config) as { success: boolean; message: string }
      setTestResult(result)
      if (result.success) {
        update('connected', true)
        fetchModels()
      }
    } catch (err) {
      setTestResult({ success: false, message: String(err) })
    } finally {
      setTesting(false)
    }
  }

  const fetchModels = async () => {
    setLoadingModels(true)
    try {
      const result = await window.heimdall.invoke('settings:listLlmModels', config) as string[]
      setModels(result || [])
      if (result.length === 0) {
        setUseCustomModel(true)
      } else {
        setUseCustomModel(false)
        // Auto-select first model if none selected
        if (!config.model && result.length > 0) {
          update('model', result[0])
        }
      }
    } catch {
      setModels([])
      setUseCustomModel(true)
    } finally {
      setLoadingModels(false)
    }
  }

  const selectedPreset = PRESETS.find((p) => p.url === config.baseUrl)

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">LLM Provider</CardTitle>
          </div>
          <CardDescription>
            Connect to any OpenAI-compatible API. Works with OpenAI, Anthropic, Ollama, OpenRouter, Groq, Together AI, and any compatible endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preset selector */}
          <div className="space-y-2">
            <Label>Provider Preset</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => {
                    if (preset.url) update('baseUrl', preset.url)
                    setModels([])
                    setTestResult(null)
                  }}
                  className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                    config.baseUrl === preset.url
                      ? 'bg-primary/10 border-primary text-primary'
                      : 'border-border text-muted-foreground hover:border-foreground'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input
              value={config.baseUrl}
              onChange={(e) => { update('baseUrl', e.target.value); setModels([]); setTestResult(null) }}
              placeholder="https://api.openai.com/v1"
            />
            <p className="text-xs text-muted-foreground">
              OpenAI-compatible endpoint. Must support /chat/completions and optionally /models.
            </p>
          </div>

          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              value={config.apiKey}
              onChange={(e) => update('apiKey', e.target.value)}
              placeholder="sk-... or leave empty for local endpoints"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Model Selection</CardTitle>
            {config.connected && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={fetchModels} disabled={loadingModels}>
                <RefreshCw className={`h-3 w-3 mr-1 ${loadingModels ? 'animate-spin' : ''}`} />
                Refresh Models
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {models.length > 0 && !useCustomModel ? (
            <div className="space-y-2">
              <Label>Available Models</Label>
              <Select value={config.model} onValueChange={(v) => update('model', v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a model..." />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                onClick={() => setUseCustomModel(true)}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                Or enter a custom model name
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Model Name</Label>
              <Input
                value={useCustomModel ? config.customModel : config.model}
                onChange={(e) => {
                  if (useCustomModel) {
                    update('customModel', e.target.value)
                    update('model', e.target.value)
                  } else {
                    update('model', e.target.value)
                  }
                }}
                placeholder="gpt-4o-mini, claude-sonnet-4-20250514, llama3.2, etc."
              />
              {models.length > 0 && (
                <button
                  onClick={() => setUseCustomModel(false)}
                  className="text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  Select from available models instead
                </button>
              )}
              {models.length === 0 && config.connected && (
                <p className="text-xs text-yellow-500">
                  Models list unavailable from this endpoint. Enter the model name manually.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || didSave}>
          {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save LLM Settings'}
        </Button>
        <Button
          variant="outline"
          onClick={testConnection}
          disabled={testing || !config.baseUrl}
        >
          {testing ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing...</>
          ) : (
            <><Link2 className="h-4 w-4 mr-2" /> Test Connection</>
          )}
        </Button>
        {testResult && (
          <Badge variant={testResult.success ? 'success' : 'error'}>
            {testResult.message}
          </Badge>
        )}
      </div>
    </div>
  )
}
