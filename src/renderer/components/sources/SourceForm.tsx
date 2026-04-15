import { useState } from 'react'
import { Loader2, Save, FlaskConical, AlertCircle, CheckCircle, Plus, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { ipc } from '@renderer/lib/ipc'
import { DISCIPLINE_LABELS } from '@common/types/intel'

const SOURCE_TYPES = [
  { value: 'api-endpoint', label: 'Generic API (JSON)', desc: 'Any REST API returning JSON' },
  { value: 'telegram-subscriber', label: 'Telegram Channel', desc: 'Public Telegram channel by username' },
  { value: 'github-repo', label: 'GitHub Repository', desc: 'Watch releases, security advisories, commits, issues, or files' },
  { value: 'rss', label: 'RSS / Atom Feed', desc: 'Any RSS or Atom feed URL' }
]

const SCHEDULE_PRESETS = [
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '*/30 * * * *', label: 'Every 30 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 */2 * * *', label: 'Every 2 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 0 * * *', label: 'Daily (midnight)' }
]

interface TestResult {
  success: boolean
  message: string
  sampleReports?: Array<{
    title: string
    severity: string
    discipline: string
    contentSnippet: string
  }>
}

interface CustomSourceFormProps {
  onSaved: () => void
}

export function CustomSourceForm({ onSaved }: CustomSourceFormProps) {
  const [name, setName] = useState('')
  const [type, setType] = useState('api-endpoint')
  const [discipline, setDiscipline] = useState('osint')
  const [schedule, setSchedule] = useState('0 */2 * * *')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const updateConfig = (key: string, value: unknown) => {
    setConfig((c) => ({ ...c, [key]: value }))
    setResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      const res = await window.heimdall.invoke('sources:test', { type, config, name }) as TestResult
      setResult(res)
    } catch (err) {
      setResult({ success: false, message: String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Please enter a source name')
      return
    }
    setSaving(true)
    try {
      await ipc.sources.create({
        name: name.trim(),
        discipline: discipline as never,
        type,
        config,
        schedule,
        enabled: true
      })
      onSaved()
    } catch (err) {
      alert(`Save failed: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  const selectedType = SOURCE_TYPES.find((t) => t.value === type)

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Common fields */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Source Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Custom Source" />
        </div>
        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select value={type} onValueChange={(v) => { setType(v); setConfig({}); setResult(null) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {SOURCE_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {selectedType && <p className="text-xs text-muted-foreground">{selectedType.desc}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>Discipline</Label>
          <Select value={discipline} onValueChange={setDiscipline}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Schedule (cron)</Label>
          <Select value={schedule} onValueChange={setSchedule}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <h4 className="text-sm font-medium mb-3">Type-Specific Configuration</h4>
        {type === 'api-endpoint' && <ApiConfigForm config={config} update={updateConfig} />}
        {type === 'telegram-subscriber' && <TelegramConfigForm config={config} update={updateConfig} />}
        {type === 'github-repo' && <GitHubConfigForm config={config} update={updateConfig} />}
        {type === 'rss' && <RssConfigForm config={config} update={updateConfig} />}
      </div>

      {/* Test result */}
      {result && (
        <div className={`border rounded-md p-3 ${result.success ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
          <div className="flex items-center gap-2 mb-2">
            {result.success ? <CheckCircle className="h-4 w-4 text-green-500" /> : <AlertCircle className="h-4 w-4 text-red-500" />}
            <span className="text-sm font-medium">{result.message}</span>
          </div>
          {result.sampleReports && result.sampleReports.length > 0 && (
            <div className="mt-2 space-y-1.5 max-h-48 overflow-auto">
              <p className="text-xs text-muted-foreground">Sample reports:</p>
              {result.sampleReports.map((r, i) => (
                <div key={i} className="text-xs border border-border rounded p-2 bg-card/50">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px]">{r.severity}</Badge>
                    <span className="font-medium truncate">{r.title}</span>
                  </div>
                  <p className="text-muted-foreground line-clamp-2">{r.contentSnippet}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-border">
        <Button onClick={handleTest} disabled={testing} variant="outline">
          {testing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Testing...</> : <><FlaskConical className="h-4 w-4 mr-2" />Test Source</>}
        </Button>
        <Button onClick={handleSave} disabled={saving || !name.trim()}>
          {saving ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : <><Save className="h-4 w-4 mr-2" />Save Source</>}
        </Button>
      </div>
    </div>
  )
}

// ── Type-specific form components ─────────────────────────────────────

function ApiConfigForm({ config, update }: { config: Record<string, unknown>; update: (k: string, v: unknown) => void }) {
  const fieldMap = (config.fieldMap as Record<string, unknown>) || {}
  const updateMap = (k: string, v: unknown) => update('fieldMap', { ...fieldMap, [k]: v })

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">URL <span className="text-red-500">*</span></Label>
        <Input value={String(config.url || '')} onChange={(e) => update('url', e.target.value)} placeholder="https://api.example.com/threats" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Method</Label>
          <Select value={String(config.method || 'GET')} onValueChange={(v) => update('method', v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="POST">POST</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">JSONPath (records)</Label>
          <Input value={String(config.jsonPath || '')} onChange={(e) => update('jsonPath', e.target.value)} placeholder="$.data.items[*]" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Headers (JSON)</Label>
        <Input value={typeof config.headers === 'object' ? JSON.stringify(config.headers) : String(config.headers || '')}
          onChange={(e) => { try { update('headers', JSON.parse(e.target.value)) } catch { update('headers', e.target.value) } }}
          placeholder='{"X-API-Key": "abc"}' />
      </div>
      <div className="border-t border-border pt-3">
        <p className="text-xs font-medium mb-2">Field Mapping (path within each record)</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Title field <span className="text-red-500">*</span></Label>
            <Input value={String(fieldMap.title || '')} onChange={(e) => updateMap('title', e.target.value)} placeholder="title or name" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Content field</Label>
            <Input value={String(fieldMap.content || '')} onChange={(e) => updateMap('content', e.target.value)} placeholder="description" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Source URL field</Label>
            <Input value={String(fieldMap.sourceUrl || '')} onChange={(e) => updateMap('sourceUrl', e.target.value)} placeholder="url or link" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Severity field</Label>
            <Input value={String(fieldMap.severity || '')} onChange={(e) => updateMap('severity', e.target.value)} placeholder="severity or level" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Latitude field</Label>
            <Input value={String(fieldMap.latitude || '')} onChange={(e) => updateMap('latitude', e.target.value)} placeholder="lat or location.lat" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Longitude field</Label>
            <Input value={String(fieldMap.longitude || '')} onChange={(e) => updateMap('longitude', e.target.value)} placeholder="lon or location.lon" />
          </div>
        </div>
      </div>
    </div>
  )
}

function TelegramConfigForm({ config, update }: { config: Record<string, unknown>; update: (k: string, v: unknown) => void }) {
  const channels = (config.channels as Array<{ username: string; topic?: string }>) || []
  const [input, setInput] = useState('')

  const addChannel = () => {
    const u = input.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').replace(/\/$/, '')
    if (u && !channels.find((c) => c.username === u)) {
      update('channels', [...channels, { username: u }])
      setInput('')
    }
  }

  const removeChannel = (u: string) => update('channels', channels.filter((c) => c.username !== u))

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Channel usernames (without @)</Label>
        <div className="flex gap-2">
          <Input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addChannel()}
            placeholder="bellingcat" className="flex-1" />
          <Button variant="outline" size="sm" onClick={addChannel}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {channels.map((c) => (
          <Badge key={c.username} variant="secondary" className="gap-1">
            @{c.username}
            <button onClick={() => removeChannel(c.username)} className="hover:text-destructive ml-1">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {channels.length === 0 && <p className="text-xs text-muted-foreground">No channels added yet</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Max posts per channel</Label>
          <Input type="number" value={Number(config.maxPostsPerChannel || 10)}
            onChange={(e) => update('maxPostsPerChannel', parseInt(e.target.value) || 10)} />
        </div>
      </div>
    </div>
  )
}

function GitHubConfigForm({ config, update }: { config: Record<string, unknown>; update: (k: string, v: unknown) => void }) {
  const watchTypes = (config.watchTypes as string[]) || ['releases']
  const toggleWatch = (t: string) => {
    if (watchTypes.includes(t)) update('watchTypes', watchTypes.filter((w) => w !== t))
    else update('watchTypes', [...watchTypes, t])
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Owner <span className="text-red-500">*</span></Label>
          <Input value={String(config.owner || '')} onChange={(e) => update('owner', e.target.value)} placeholder="CriticalPathSecurity" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Repository <span className="text-red-500">*</span></Label>
          <Input value={String(config.repo || '')} onChange={(e) => update('repo', e.target.value)} placeholder="Public-Intelligence-Feeds" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Watch types</Label>
        <div className="flex flex-wrap gap-2">
          {['releases', 'security', 'commits', 'issues', 'file'].map((t) => (
            <button key={t}
              onClick={() => toggleWatch(t)}
              className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                watchTypes.includes(t) ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'
              }`}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {watchTypes.includes('file') && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">File path</Label>
            <Input value={String(config.filePath || '')} onChange={(e) => update('filePath', e.target.value)} placeholder="feeds/threats.json" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Branch (optional)</Label>
            <Input value={String(config.branch || '')} onChange={(e) => update('branch', e.target.value)} placeholder="main" />
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <Label className="text-xs">GitHub PAT (optional, for higher rate limits)</Label>
        <Input type="password" value={String(config.apiToken || '')} onChange={(e) => update('apiToken', e.target.value)} placeholder="ghp_..." />
      </div>
    </div>
  )
}

function RssConfigForm({ config, update }: { config: Record<string, unknown>; update: (k: string, v: unknown) => void }) {
  const feeds = (config.feeds as Array<{ url: string; name: string }>) || []
  const [urlInput, setUrlInput] = useState('')
  const [nameInput, setNameInput] = useState('')

  const addFeed = () => {
    const url = urlInput.trim()
    const name = nameInput.trim() || new URL(url).hostname
    if (url && !feeds.find((f) => f.url === url)) {
      update('feeds', [...feeds, { url, name }])
      setUrlInput('')
      setNameInput('')
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">RSS / Atom feed URLs</Label>
        <div className="grid grid-cols-[1fr_140px_auto] gap-2">
          <Input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://example.com/feed.xml" />
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Feed name" />
          <Button variant="outline" size="sm" onClick={addFeed}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="space-y-1.5">
        {feeds.map((f) => (
          <div key={f.url} className="flex items-center justify-between gap-2 p-2 border border-border rounded text-xs">
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{f.name}</div>
              <div className="text-muted-foreground truncate font-mono">{f.url}</div>
            </div>
            <button onClick={() => update('feeds', feeds.filter((x) => x.url !== f.url))} className="text-muted-foreground hover:text-destructive shrink-0">
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {feeds.length === 0 && <p className="text-xs text-muted-foreground">No feeds added yet</p>}
      </div>
    </div>
  )
}
