import { useState, useEffect, useCallback } from 'react'
import {
  Radio, RefreshCw, Wifi, Battery, Signal, MapPin, Clock,
  MessageSquare, Loader2, AlertTriangle, Zap
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { formatRelativeTime } from '@renderer/lib/utils'
import { cn } from '@renderer/lib/utils'

interface MeshNode {
  node_id: string
  long_name: string | null
  short_name: string | null
  hardware_model: string | null
  last_heard: number | null
  latitude: number | null
  longitude: number | null
  battery_level: number | null
  snr: number | null
  channel: number | null
  first_seen: number
  last_seen: number
  seen_count: number
}

interface MeshMessage {
  id: string
  title: string
  content: string
  source_name: string
  severity: string
  created_at: number
}

interface ModeRecommendation {
  mode: string
  reason: string
}

export function MeshtasticPage() {
  const [nodes, setNodes] = useState<MeshNode[]>([])
  const [messages, setMessages] = useState<MeshMessage[]>([])
  const [recommendation, setRecommendation] = useState<ModeRecommendation | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'nodes' | 'messages'>('nodes')

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [n, m, r] = await Promise.all([
        invoke('meshtastic:getNodes') as Promise<MeshNode[]>,
        invoke('meshtastic:getMessages', { limit: 100 }) as Promise<MeshMessage[]>,
        invoke('meshtastic:getRecommendedMode') as Promise<ModeRecommendation>
      ])
      setNodes(n || [])
      setMessages(m || [])
      setRecommendation(r)
    } catch {}
    setLoading(false)
  }

  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState<string | null>(null)
  const [cliStatus, setCliStatus] = useState<{ installed: boolean; version?: string; message?: string } | null>(null)

  useEffect(() => {
    invoke('meshtastic:checkCli').then((r: any) => setCliStatus(r)).catch(() => {})
  }, [])

  const pullDeviceData = async () => {
    setPulling(true)
    setPullResult(null)
    try {
      const result = await invoke('meshtastic:pullDeviceData') as { success: boolean; message: string; bytesReceived?: number }
      setPullResult(result.message)
      if (result.success) loadData()
    } catch (err) {
      setPullResult(`Error: ${err}`)
    }
    setPulling(false)
  }

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 15000)
    return () => clearInterval(interval)
  }, [])

  const onlineNodes = nodes.filter((n) => n.last_seen > Date.now() - 3600000)
  const offlineNodes = nodes.filter((n) => n.last_seen <= Date.now() - 3600000)

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Radio className="h-6 w-6 text-green-500" />
            Meshtastic Network
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            LoRa mesh node discovery, telemetry, and SIGINT monitoring
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pullResult && <Badge variant={pullResult.includes('Error') ? 'error' : 'success'} className="text-[9px]">{pullResult.slice(0, 60)}</Badge>}
          <Button variant="default" size="sm" onClick={pullDeviceData} disabled={pulling}>
            {pulling ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Radio className="h-4 w-4 mr-2" />}
            {pulling ? 'Pulling...' : 'Pull Device Data'}
          </Button>
          <Button variant="outline" size="sm" onClick={async () => {
            setPullResult('Scanning network...')
            const result = await invoke('meshtastic:discover') as { found: string[]; message: string }
            setPullResult(result.message)
          }}>
            <Wifi className="h-4 w-4 mr-2" /> Discover
          </Button>
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {/* Stats + Mode Recommendation */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Wifi className="h-8 w-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold">{nodes.length}</p>
                <p className="text-xs text-muted-foreground">Total Nodes</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Signal className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{onlineNodes.length}</p>
                <p className="text-xs text-muted-foreground">Online (1h)</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <MessageSquare className="h-8 w-8 text-violet-500" />
              <div>
                <p className="text-2xl font-bold">{messages.length}</p>
                <p className="text-xs text-muted-foreground">Messages</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/20 bg-green-500/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-green-500" />
              <span className="text-xs font-semibold text-green-500">Recommended Mode</span>
            </div>
            <p className="text-lg font-bold font-mono">{recommendation?.mode || 'LONG_FAST'}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">{recommendation?.reason || 'Default for low traffic'}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <Button variant={activeTab === 'nodes' ? 'default' : 'outline'} size="sm" onClick={() => setActiveTab('nodes')}>
          <Wifi className="h-3.5 w-3.5 mr-1.5" /> Nodes ({nodes.length})
        </Button>
        <Button variant={activeTab === 'messages' ? 'default' : 'outline'} size="sm" onClick={() => setActiveTab('messages')}>
          <MessageSquare className="h-3.5 w-3.5 mr-1.5" /> Messages ({messages.length})
        </Button>
      </div>

      {/* Nodes Table */}
      {activeTab === 'nodes' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Discovered Nodes</CardTitle>
            <CardDescription>All Meshtastic nodes seen on the mesh network across all channels</CardDescription>
          </CardHeader>
          <CardContent>
            {nodes.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-2 font-semibold">Status</th>
                      <th className="text-left py-2 px-2 font-semibold">Node ID</th>
                      <th className="text-left py-2 px-2 font-semibold">Name</th>
                      <th className="text-left py-2 px-2 font-semibold">Hardware</th>
                      <th className="text-left py-2 px-2 font-semibold">Position</th>
                      <th className="text-right py-2 px-2 font-semibold">Battery</th>
                      <th className="text-right py-2 px-2 font-semibold">SNR</th>
                      <th className="text-right py-2 px-2 font-semibold">Seen</th>
                      <th className="text-right py-2 px-2 font-semibold">Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((node) => {
                      const isOnline = node.last_seen > Date.now() - 3600000
                      return (
                        <tr key={node.node_id} className="border-b border-border/50 hover:bg-accent/30">
                          <td className="py-1.5 px-2">
                            <span className={cn('inline-block h-2 w-2 rounded-full', isOnline ? 'bg-green-500' : 'bg-gray-500')} />
                          </td>
                          <td className="py-1.5 px-2 font-mono">{node.node_id}</td>
                          <td className="py-1.5 px-2">{node.long_name || node.short_name || '—'}</td>
                          <td className="py-1.5 px-2 text-muted-foreground">{node.hardware_model || '—'}</td>
                          <td className="py-1.5 px-2">
                            {node.latitude && node.longitude ? (
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3 w-3 text-muted-foreground" />
                                {node.latitude.toFixed(4)}, {node.longitude.toFixed(4)}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            {node.battery_level !== null ? (
                              <span className={cn('flex items-center justify-end gap-1',
                                node.battery_level > 50 ? 'text-green-500' : node.battery_level > 20 ? 'text-yellow-500' : 'text-red-500'
                              )}>
                                <Battery className="h-3 w-3" />
                                {node.battery_level}%
                              </span>
                            ) : '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono">
                            {node.snr !== null ? `${(node.snr * 100).toFixed(0)}%` : '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right">{node.seen_count}x</td>
                          <td className="py-1.5 px-2 text-right text-muted-foreground">
                            {formatRelativeTime(node.last_seen)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <Radio className="mx-auto h-10 w-10 opacity-30 mb-3" />
                <p className="text-sm">No nodes discovered yet</p>
                <p className="text-xs mt-1">Connect a Meshtastic device in Settings to start monitoring</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Messages */}
      {activeTab === 'messages' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Mesh Messages</CardTitle>
            <CardDescription>Messages captured from all monitored channels (0-7)</CardDescription>
          </CardHeader>
          <CardContent>
            {messages.length > 0 ? (
              <div className="space-y-1 max-h-[60vh] overflow-auto">
                {messages.map((msg) => (
                  <div key={msg.id} className="flex items-start gap-2 py-2 border-b border-border/50 last:border-0 text-xs">
                    <Radio className="h-3.5 w-3.5 mt-0.5 text-green-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{msg.title}</div>
                      <div className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{msg.content.slice(0, 200)}</div>
                    </div>
                    <span className="text-muted-foreground shrink-0">{formatRelativeTime(msg.created_at)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <MessageSquare className="mx-auto h-10 w-10 opacity-30 mb-3" />
                <p className="text-sm">No mesh messages captured yet</p>
                <p className="text-xs mt-1">Messages will appear when a Meshtastic device is connected and active</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* CLI Status */}
      {cliStatus && !cliStatus.installed && (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <span className="text-xs font-semibold text-red-500">Meshtastic CLI Not Found</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Install the Meshtastic CLI to pull node data from your device:
            </p>
            <code className="block mt-2 bg-muted/50 px-3 py-1.5 rounded text-xs font-mono">pip3 install --user meshtastic</code>
          </CardContent>
        </Card>
      )}
      {cliStatus?.installed && (
        <Badge variant="success" className="text-[9px]">CLI: {cliStatus.version}</Badge>
      )}

      {/* Monitoring info */}
      <Card className="border-blue-500/20 bg-blue-500/5">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-blue-500" />
            <span className="text-xs font-semibold text-blue-500">SIGINT Monitoring</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Heimdall uses the <strong>meshtastic CLI</strong> to pull node databases from your device.
            Click "Pull Device Data" to fetch all discovered nodes including positions, battery, and SNR.
            Set your device to <strong>CLIENT_MUTE</strong> mode for maximum SIGINT capture.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
