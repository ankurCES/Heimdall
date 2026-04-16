import { useEffect, useState } from 'react'
import { Plug, RefreshCw, Loader2, Plus, Trash2, Check, X, Play, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'

/**
 * MCP server management — Cross-cutting (Model Context Protocol).
 *
 * Lists each configured MCP server with health (connected/disconnected/
 * error/starting), tool count, and per-server controls (enable toggle,
 * restart, expand to see tool list, delete). Add a custom server via
 * the bottom form.
 *
 * Tools registered by these servers appear to the chat agent as
 * `mcp:<server-id>:<tool-name>` and flow into HUMINT reports
 * automatically via the existing tool-call harvesting.
 */

interface ServerHealth {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  builtin: boolean
  status: 'connected' | 'disconnected' | 'error' | 'starting'
  last_error: string | null
  tool_count: number
  connected_at: number | null
}

interface ToolMeta { name: string; description: string }

const STATUS_COLOR: Record<ServerHealth['status'], string> = {
  connected: 'bg-emerald-500',
  disconnected: 'bg-slate-500',
  error: 'bg-red-500',
  starting: 'bg-amber-500 animate-pulse'
}

export function McpServersTab() {
  const [servers, setServers] = useState<ServerHealth[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tools, setTools] = useState<Record<string, ToolMeta[]>>({})
  const [showAdd, setShowAdd] = useState(false)
  const [draft, setDraft] = useState({ id: '', name: '', command: '', args: '', env: '' })
  const [testResult, setTestResult] = useState<{ ok: boolean; tool_count?: number; error?: string } | null>(null)

  const load = async () => {
    setError(null)
    try {
      setServers(await window.heimdall.invoke('mcp:list_servers') as ServerHealth[])
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }
  useEffect(() => { void load() }, [])

  const toggleExpand = async (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
      if (!tools[id]) {
        try {
          const list = await window.heimdall.invoke('mcp:list_tools', id) as ToolMeta[]
          setTools((prev) => ({ ...prev, [id]: list }))
        } catch { /* noop */ }
      }
    }
    setExpanded(next)
  }

  const toggleEnabled = async (s: ServerHealth) => {
    setBusy(true)
    try {
      await window.heimdall.invoke('mcp:update_server', { id: s.id, patch: { enabled: !s.enabled } })
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const restartOne = async (id: string) => {
    setBusy(true)
    try {
      await window.heimdall.invoke('mcp:restart_server', id)
      await new Promise((r) => setTimeout(r, 500))
      await load()
      setTools((prev) => { const next = { ...prev }; delete next[id]; return next })
    } finally { setBusy(false) }
  }

  const restartAll = async () => {
    setBusy(true)
    try {
      await window.heimdall.invoke('mcp:restart_server', undefined)
      await new Promise((r) => setTimeout(r, 1000))
      await load()
      setTools({})
    } finally { setBusy(false) }
  }

  const removeOne = async (s: ServerHealth) => {
    if (!confirm(`Remove MCP server "${s.name}"?`)) return
    try {
      await window.heimdall.invoke('mcp:remove_server', s.id)
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const buildDraftConfig = () => {
    const args = draft.args.split(',').map((s) => s.trim()).filter(Boolean)
    const envEntries = draft.env.split(',').map((s) => s.trim()).filter(Boolean)
    const env: Record<string, string> = {}
    for (const e of envEntries) {
      const [k, v] = e.split('=')
      if (k && v !== undefined) env[k.trim()] = v.trim()
    }
    return { id: draft.id.trim(), name: draft.name.trim() || draft.id, command: draft.command.trim(), args, env, enabled: true, builtin: false }
  }

  const testDraft = async () => {
    if (!draft.id || !draft.command) return
    setTestResult(null); setBusy(true)
    try {
      const r = await window.heimdall.invoke('mcp:test_server', buildDraftConfig()) as { ok: boolean; tool_count?: number; error?: string }
      setTestResult(r)
    } finally { setBusy(false) }
  }

  const addServer = async () => {
    if (!draft.id || !draft.command) return
    setBusy(true); setError(null)
    try {
      await window.heimdall.invoke('mcp:add_server', buildDraftConfig())
      setShowAdd(false); setDraft({ id: '', name: '', command: '', args: '', env: '' }); setTestResult(null)
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const totalTools = servers.reduce((n, s) => n + s.tool_count, 0)
  const connected = servers.filter((s) => s.status === 'connected').length

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Plug className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">MCP Servers</CardTitle>
              <Badge variant="outline" className="text-[10px] font-mono">
                {connected}/{servers.length} connected · {totalTools} tools
              </Badge>
            </div>
            <Button size="sm" variant="outline" onClick={restartAll} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Restart all
            </Button>
          </div>
          <CardDescription>
            Model Context Protocol servers extend the chat agent with additional tools (web fetch, Wikipedia, arXiv, whois,
            persistent KG, etc). Tools register as <code className="font-mono text-[10px]">mcp:&lt;server&gt;:&lt;tool&gt;</code> and
            appear to the agent like any built-in tool. Some servers need <code className="font-mono">uv</code> or <code className="font-mono">npx</code> on PATH.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {error && <div className="text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300">{error}</div>}
          {servers.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No MCP servers configured. Defaults seed on first run.</p>
          ) : servers.map((s) => (
            <div key={s.id} className="rounded border border-border bg-card/30">
              <div className="flex items-center gap-2 p-3">
                <button onClick={() => void toggleExpand(s.id)} className="text-muted-foreground hover:text-foreground">
                  {expanded.has(s.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_COLOR[s.status])} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">mcp:{s.id}</span>
                    {s.builtin && <Badge variant="outline" className="text-[9px] py-0 px-1">builtin</Badge>}
                    <span className="ml-auto text-[10px] text-muted-foreground">{s.tool_count} tool{s.tool_count === 1 ? '' : 's'}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">{s.command} {s.args.join(' ')}</div>
                  {s.last_error && s.status === 'error' && (
                    <div className="text-[10px] text-red-400 mt-0.5 truncate" title={s.last_error}>{s.last_error}</div>
                  )}
                </div>
                <Switch checked={s.enabled} onCheckedChange={() => void toggleEnabled(s)} />
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => void restartOne(s.id)} title="Restart">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
                {!s.builtin && (
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => void removeOne(s)} title="Remove">
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </Button>
                )}
              </div>
              {expanded.has(s.id) && tools[s.id] && (
                <div className="px-4 pb-3 border-t border-border/50 bg-background/30">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2 mb-1">Tools</div>
                  {tools[s.id].length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No tools available.</p>
                  ) : (
                    <ul className="space-y-1">
                      {tools[s.id].map((t) => (
                        <li key={t.name} className="text-[11px]">
                          <code className="font-mono text-primary">{t.name}</code>
                          <span className="text-muted-foreground"> — {t.description.slice(0, 200)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Add custom server</CardTitle>
            {!showAdd && <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />New</Button>}
          </div>
        </CardHeader>
        {showAdd && (
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>ID (unique)</Label>
                <Input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value.replace(/[^a-z0-9_-]/gi, '') })} placeholder="my-server" />
              </div>
              <div>
                <Label>Name</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="My Server" />
              </div>
            </div>
            <div>
              <Label>Command</Label>
              <Input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" className="font-mono" />
            </div>
            <div>
              <Label>Args (comma-separated)</Label>
              <Input value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} placeholder="-y, my-mcp-server" className="font-mono text-xs" />
            </div>
            <div>
              <Label>Env vars (comma-separated key=value)</Label>
              <Input value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} placeholder="API_KEY=abc, FOO=bar" className="font-mono text-xs" />
            </div>
            {testResult && (
              <div className={cn('text-xs p-2 rounded border', testResult.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300')}>
                {testResult.ok ? <><Check className="inline h-3 w-3 mr-1" />Connected — {testResult.tool_count} tool(s) detected</> : <>Failed: {testResult.error}</>}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setShowAdd(false); setTestResult(null); setDraft({ id: '', name: '', command: '', args: '', env: '' }) }}>Cancel</Button>
              <Button size="sm" variant="outline" onClick={testDraft} disabled={busy || !draft.id || !draft.command}>
                {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}Test
              </Button>
              <Button size="sm" onClick={addServer} disabled={busy || !draft.id || !draft.command}>
                {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}Add
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
