import { useState, useEffect } from 'react'
import {
  Brain, Check, Loader2, Link2, RefreshCw, Plus, Trash2, Power
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Switch } from '@renderer/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting } from '@renderer/hooks/useSettings'
import type { LlmConfig, LlmConnection } from '@common/types/settings'
import { cn } from '@renderer/lib/utils'

const DEFAULT_CONFIG: LlmConfig = { connections: [], defaultConnectionId: '' }

const PRESETS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { label: 'Anthropic', url: 'https://api.anthropic.com/v1' },
  { label: 'Ollama (Local)', url: 'http://localhost:11434/v1' },
  { label: 'Ollama Cloud', url: 'https://api.ollama.com/v1' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
  { label: 'Together AI', url: 'https://api.together.xyz/v1' },
  { label: 'xAI (Grok)', url: 'https://api.x.ai/v1' },
  { label: 'Mistral', url: 'https://api.mistral.ai/v1' }
]

export function LlmTab() {
  const { value: saved, save, saving } = useSetting<LlmConfig>('llm', DEFAULT_CONFIG)
  const [config, setConfig] = useState<LlmConfig>(DEFAULT_CONFIG)
  const [didSave, setDidSave] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({})
  const [modelLists, setModelLists] = useState<Record<string, string[]>>({})
  const [loadingModels, setLoadingModels] = useState<string | null>(null)

  useEffect(() => {
    if (saved) {
      // Migrate from old single-connection format
      if ((saved as any).baseUrl && !(saved as any).connections) {
        const legacy = saved as any
        const migrated: LlmConfig = {
          connections: [{
            id: crypto.randomUUID(),
            name: 'Default',
            baseUrl: legacy.baseUrl,
            apiKey: legacy.apiKey || '',
            model: legacy.model || '',
            customModel: legacy.customModel || '',
            enabled: true
          }],
          defaultConnectionId: ''
        }
        migrated.defaultConnectionId = migrated.connections[0].id
        setConfig(migrated)
      } else if (saved.connections) {
        setConfig(saved)
      }
    }
  }, [saved])

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  const addConnection = (preset?: typeof PRESETS[number]) => {
    const conn: LlmConnection = {
      id: crypto.randomUUID(),
      name: preset?.label || 'New Connection',
      baseUrl: preset?.url || '',
      apiKey: '',
      model: '',
      customModel: '',
      enabled: true
    }
    const updated = { ...config, connections: [...config.connections, conn] }
    if (!updated.defaultConnectionId) updated.defaultConnectionId = conn.id
    setConfig(updated)
    setDidSave(false)
  }

  const updateConnection = (id: string, updates: Partial<LlmConnection>) => {
    setConfig({
      ...config,
      connections: config.connections.map((c) => c.id === id ? { ...c, ...updates } : c)
    })
    setDidSave(false)
  }

  const removeConnection = (id: string) => {
    const updated = {
      ...config,
      connections: config.connections.filter((c) => c.id !== id)
    }
    if (updated.defaultConnectionId === id) {
      updated.defaultConnectionId = updated.connections[0]?.id || ''
    }
    setConfig(updated)
    setDidSave(false)
  }

  const testConnection = async (conn: LlmConnection) => {
    setTestingId(conn.id)
    try {
      const result = await window.heimdall.invoke('settings:testLlm', conn) as { success: boolean; message: string }
      setTestResults({ ...testResults, [conn.id]: result })
      if (result.success) fetchModels(conn)
    } catch (err) {
      setTestResults({ ...testResults, [conn.id]: { success: false, message: String(err) } })
    } finally {
      setTestingId(null)
    }
  }

  const fetchModels = async (conn: LlmConnection) => {
    setLoadingModels(conn.id)
    try {
      const result = await window.heimdall.invoke('settings:listLlmModels', conn) as string[]
      setModelLists({ ...modelLists, [conn.id]: result || [] })
    } catch {
      setModelLists({ ...modelLists, [conn.id]: [] })
    } finally {
      setLoadingModels(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Brain className="h-5 w-5 text-muted-foreground" />
            LLM Connections
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Add multiple providers. Enable/disable and select which to use for chat and agents.
          </p>
        </div>
      </div>

      {/* Quick add presets */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Quick Add Provider</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <Button key={p.label} variant="outline" size="sm" className="text-xs h-7" onClick={() => addConnection(p)}>
                <Plus className="h-3 w-3 mr-1" />{p.label}
              </Button>
            ))}
            <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => addConnection()}>
              <Plus className="h-3 w-3 mr-1" />Custom
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Connection list */}
      {config.connections.map((conn) => {
        const models = modelLists[conn.id] || []
        const testResult = testResults[conn.id]
        const isTesting = testingId === conn.id
        const isDefault = config.defaultConnectionId === conn.id

        return (
          <Card key={conn.id} className={cn(!conn.enabled && 'opacity-60')}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Switch checked={conn.enabled} onCheckedChange={(v) => updateConnection(conn.id, { enabled: v })} />
                  <Input
                    value={conn.name}
                    onChange={(e) => updateConnection(conn.id, { name: e.target.value })}
                    className="h-7 w-40 text-sm font-medium"
                  />
                  {isDefault && <Badge variant="default" className="text-[9px]">Default</Badge>}
                  {testResult && (
                    <Badge variant={testResult.success ? 'success' : 'error'} className="text-[9px]">
                      {testResult.message.slice(0, 30)}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {!isDefault && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setConfig({ ...config, defaultConnectionId: conn.id })}>
                      Set Default
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeConnection(conn.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    value={conn.baseUrl}
                    onChange={(e) => updateConnection(conn.id, { baseUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">API Key</Label>
                  <Input
                    type="password"
                    value={conn.apiKey}
                    onChange={(e) => updateConnection(conn.id, { apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Model</Label>
                {models.length > 0 ? (
                  <div className="flex gap-2">
                    <Select value={conn.model} onValueChange={(v) => updateConnection(conn.id, { model: v })}>
                      <SelectTrigger className="h-8 text-xs flex-1"><SelectValue placeholder="Select model..." /></SelectTrigger>
                      <SelectContent>
                        {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => fetchModels(conn)}>
                      <RefreshCw className={cn('h-3 w-3', loadingModels === conn.id && 'animate-spin')} />
                    </Button>
                  </div>
                ) : (
                  <Input
                    value={conn.customModel || conn.model}
                    onChange={(e) => updateConnection(conn.id, { model: e.target.value, customModel: e.target.value })}
                    placeholder="gpt-4o-mini, claude-sonnet-4-20250514, llama3.2..."
                    className="h-8 text-xs"
                  />
                )}
              </div>

              <Button
                variant="outline" size="sm" className="text-xs h-7"
                onClick={() => testConnection(conn)}
                disabled={isTesting || !conn.baseUrl}
              >
                {isTesting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2 className="h-3 w-3 mr-1" />}
                Test & Load Models
              </Button>
            </CardContent>
          </Card>
        )
      })}

      {config.connections.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Brain className="mx-auto h-10 w-10 opacity-30 mb-3" />
            <p className="text-sm">No LLM connections configured</p>
            <p className="text-xs mt-1">Add a provider above to enable chat and agent analysis</p>
          </CardContent>
        </Card>
      )}

      <Button onClick={handleSave} disabled={saving || didSave}>
        {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save LLM Settings'}
      </Button>
    </div>
  )
}
