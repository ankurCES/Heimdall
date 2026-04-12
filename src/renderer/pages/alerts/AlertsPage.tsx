import { useEffect, useState, useCallback } from 'react'
import {
  Bell, Plus, Trash2, Save, Check, Loader2,
  Mail, Send, Radio, AlertTriangle
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Switch } from '@renderer/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { DISCIPLINE_LABELS } from '@common/types/intel'
import type { AlertRule, AlertCondition } from '@common/types/alerts'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

const CHANNEL_ICONS = {
  email: Mail,
  telegram: Send,
  meshtastic: Radio
}

export function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [activeTab, setActiveTab] = useState<'rules' | 'history'>('rules')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    loadRules()
    loadHistory()
  }, [])

  const loadRules = async () => {
    const r = await invoke('alerts:getRules') as AlertRule[]
    setRules(r || [])
  }

  const loadHistory = async () => {
    const h = await invoke('alerts:getHistory', { offset: 0, limit: 50 }) as { alerts: Array<Record<string, unknown>>; total: number }
    setHistory(h.alerts || [])
    setHistoryTotal(h.total)
  }

  const saveRules = async () => {
    setSaving(true)
    await invoke('alerts:saveRules', { rules })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const addRule = () => {
    const newRule: AlertRule = {
      id: crypto.randomUUID(),
      name: 'New Rule',
      enabled: true,
      conditions: [{ type: 'severity', operator: 'eq', value: 'critical' }],
      channels: ['email'],
      createdAt: Date.now()
    }
    setRules([...rules, newRule])
  }

  const updateRule = (id: string, updates: Partial<AlertRule>) => {
    setRules(rules.map((r) => r.id === id ? { ...r, ...updates } : r))
    setSaved(false)
  }

  const deleteRule = (id: string) => {
    setRules(rules.filter((r) => r.id !== id))
    setSaved(false)
  }

  const addCondition = (ruleId: string) => {
    setRules(rules.map((r) => {
      if (r.id !== ruleId) return r
      return { ...r, conditions: [...r.conditions, { type: 'severity' as const, operator: 'eq' as const, value: 'high' }] }
    }))
    setSaved(false)
  }

  const updateCondition = (ruleId: string, idx: number, updates: Partial<AlertCondition>) => {
    setRules(rules.map((r) => {
      if (r.id !== ruleId) return r
      const conds = [...r.conditions]
      conds[idx] = { ...conds[idx], ...updates }
      return { ...r, conditions: conds }
    }))
    setSaved(false)
  }

  const removeCondition = (ruleId: string, idx: number) => {
    setRules(rules.map((r) => {
      if (r.id !== ruleId) return r
      return { ...r, conditions: r.conditions.filter((_, i) => i !== idx) }
    }))
    setSaved(false)
  }

  const toggleChannel = (ruleId: string, channel: string) => {
    setRules(rules.map((r) => {
      if (r.id !== ruleId) return r
      const channels = r.channels.includes(channel as any)
        ? r.channels.filter((c) => c !== channel)
        : [...r.channels, channel as any]
      return { ...r, channels }
    }))
    setSaved(false)
  }

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6 text-muted-foreground" />
            Alert Rules & Dispatch
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure automated alerts for critical intelligence findings
          </p>
        </div>
        <div className="flex gap-2">
          {(['rules', 'history'] as const).map((tab) => (
            <Button
              key={tab}
              variant={activeTab === tab ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'rules' ? 'Rules' : `History (${historyTotal})`}
            </Button>
          ))}
        </div>
      </div>

      {activeTab === 'rules' && (
        <>
          {/* Rules list */}
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(v) => updateRule(rule.id, { enabled: v })}
                    />
                    <Input
                      value={rule.name}
                      onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                      className="h-8 w-64 text-sm font-medium"
                    />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Conditions */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Conditions (all must match)</Label>
                  <div className="space-y-2">
                    {rule.conditions.map((cond, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Select value={cond.type} onValueChange={(v) => updateCondition(rule.id, idx, { type: v as AlertCondition['type'] })}>
                          <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="severity">Severity</SelectItem>
                            <SelectItem value="keyword">Keyword</SelectItem>
                            <SelectItem value="discipline">Discipline</SelectItem>
                            <SelectItem value="verification">Verification</SelectItem>
                            <SelectItem value="geofence">Geofence</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select value={cond.operator} onValueChange={(v) => updateCondition(rule.id, idx, { operator: v as AlertCondition['operator'] })}>
                          <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="eq">equals</SelectItem>
                            <SelectItem value="gte">at least</SelectItem>
                            <SelectItem value="lte">at most</SelectItem>
                            <SelectItem value="contains">contains</SelectItem>
                          </SelectContent>
                        </Select>
                        {cond.type === 'severity' ? (
                          <Select value={String(cond.value)} onValueChange={(v) => updateCondition(rule.id, idx, { value: v })}>
                            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="critical">Critical</SelectItem>
                              <SelectItem value="high">High</SelectItem>
                              <SelectItem value="medium">Medium</SelectItem>
                              <SelectItem value="low">Low</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : cond.type === 'discipline' ? (
                          <Select value={String(cond.value)} onValueChange={(v) => updateCondition(rule.id, idx, { value: v })}>
                            <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(DISCIPLINE_LABELS).map(([k, v]) => (
                                <SelectItem key={k} value={k}>{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            value={String(cond.value)}
                            onChange={(e) => updateCondition(rule.id, idx, { value: e.target.value })}
                            className="h-8 flex-1 text-xs"
                            placeholder={cond.type === 'geofence' ? 'lat,lon,radiusKm' : cond.type === 'keyword' ? 'regex pattern' : 'value'}
                          />
                        )}
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => removeCondition(rule.id, idx)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => addCondition(rule.id)}>
                      <Plus className="h-3 w-3 mr-1" /> Add Condition
                    </Button>
                  </div>
                </div>

                {/* Channels */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Dispatch Channels</Label>
                  <div className="flex gap-2">
                    {(['email', 'telegram', 'meshtastic'] as const).map((ch) => {
                      const Icon = CHANNEL_ICONS[ch]
                      const active = rule.channels.includes(ch)
                      return (
                        <button
                          key={ch}
                          onClick={() => toggleChannel(rule.id, ch)}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors',
                            active ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:border-foreground'
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {ch.charAt(0).toUpperCase() + ch.slice(1)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {rules.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <AlertTriangle className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">No alert rules configured</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Add a rule to start receiving automated alerts</p>
              </CardContent>
            </Card>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={addRule}>
              <Plus className="h-4 w-4 mr-2" /> Add Rule
            </Button>
            <Button onClick={saveRules} disabled={saving || saved}>
              {saved ? <><Check className="h-4 w-4 mr-2" /> Saved</> : saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {saved ? 'Saved' : 'Save Rules'}
            </Button>
          </div>
        </>
      )}

      {activeTab === 'history' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Alert History</CardTitle>
            <CardDescription>{historyTotal} alerts dispatched</CardDescription>
          </CardHeader>
          <CardContent>
            {history.length > 0 ? (
              <div className="space-y-1">
                {history.map((alert) => {
                  const ChIcon = CHANNEL_ICONS[(alert.channel as string) as keyof typeof CHANNEL_ICONS] || Bell
                  return (
                    <div key={alert.id as string} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn('h-2 w-2 rounded-full', alert.status === 'sent' ? 'bg-green-500' : 'bg-red-500')} />
                        <ChIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{alert.channel as string}</span>
                        {alert.error && <span className="text-red-400 truncate max-w-xs">{alert.error as string}</span>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant={alert.status === 'sent' ? 'success' : 'error'} className="text-[9px]">
                          {alert.status as string}
                        </Badge>
                        <span className="text-muted-foreground">{formatRelativeTime(alert.created_at as number)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No alerts dispatched yet</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
