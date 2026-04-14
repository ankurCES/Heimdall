import { useState, useEffect, useCallback } from 'react'
import { Radio, Check, Loader2, Wifi, Usb, Cloud, RefreshCw, Send } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSetting, useTestConnection } from '@renderer/hooks/useSettings'
import type { MeshtasticConfig } from '@common/types/settings'

const DEFAULT_MESHTASTIC: MeshtasticConfig = {
  connectionType: 'tcp',
  address: '',
  port: 4403,
  serialPath: '',
  mqttBroker: '',
  mqttTopic: 'msh/#',
  channelIndex: 0,
  enableDispatch: false,
  enableCollection: false,
  targetNodeIds: []
}

const CONNECTION_INFO = {
  tcp: { icon: Wifi, label: 'TCP/WiFi', desc: 'Connect to a WiFi-enabled Meshtastic node on your LAN' },
  serial: { icon: Usb, label: 'USB Serial', desc: 'Connect via USB to a directly attached radio (MeshStick, ESP32)' },
  mqtt: { icon: Cloud, label: 'MQTT Broker', desc: 'Monitor mesh traffic remotely via an MQTT broker' }
}

export function MeshtasticTab() {
  const { value: saved, save, saving } = useSetting<MeshtasticConfig>('meshtastic', DEFAULT_MESHTASTIC)
  const [config, setConfig] = useState<MeshtasticConfig>(DEFAULT_MESHTASTIC)
  const [nodeIdInput, setNodeIdInput] = useState('')
  const [didSave, setDidSave] = useState(false)
  const { testing, result, test } = useTestConnection()

  const [serialPorts, setSerialPorts] = useState<Array<{ path: string; label: string }>>([])
  const [loadingPorts, setLoadingPorts] = useState(false)

  const loadSerialPorts = useCallback(async () => {
    setLoadingPorts(true)
    try {
      const ports = await window.heimdall.invoke('settings:listSerialPorts') as Array<{ path: string; label: string }>
      setSerialPorts(ports || [])
    } catch {}
    setLoadingPorts(false)
  }, [])

  useEffect(() => {
    if (saved && saved.connectionType !== undefined) {
      setConfig(saved)
    }
  }, [saved])

  useEffect(() => {
    if (config.connectionType === 'serial') loadSerialPorts()
  }, [config.connectionType, loadSerialPorts])

  const update = (field: keyof MeshtasticConfig, value: unknown) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setDidSave(false)
  }

  const handleSave = async () => {
    await save(config)
    setDidSave(true)
    setTimeout(() => setDidSave(false), 2000)
  }

  const addNodeId = () => {
    const id = nodeIdInput.trim()
    if (id && !config.targetNodeIds.includes(id)) {
      update('targetNodeIds', [...config.targetNodeIds, id])
      setNodeIdInput('')
    }
  }

  const connInfo = CONNECTION_INFO[config.connectionType]

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Meshtastic LoRa Configuration</CardTitle>
          </div>
          <CardDescription>
            Connect to a Meshtastic mesh network for SIGINT collection and off-grid alert dispatch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Connection Type</Label>
            <Select
              value={config.connectionType}
              onValueChange={(v) => update('connectionType', v as MeshtasticConfig['connectionType'])}
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CONNECTION_INFO).map(([key, info]) => (
                  <SelectItem key={key} value={key}>
                    <span className="flex items-center gap-2">
                      <info.icon className="h-3.5 w-3.5" />
                      {info.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{connInfo.desc}</p>
          </div>

          {config.connectionType === 'tcp' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Node IP Address</Label>
                <Input
                  value={config.address}
                  onChange={(e) => update('address', e.target.value)}
                  placeholder="192.168.1.100"
                />
              </div>
              <div className="space-y-2">
                <Label>Port</Label>
                <Input
                  type="number"
                  value={config.port}
                  onChange={(e) => update('port', parseInt(e.target.value) || 4403)}
                />
              </div>
            </div>
          )}

          {config.connectionType === 'serial' && (
            <div className="space-y-2">
              <Label>Serial Port</Label>
              <div className="flex gap-2">
                {serialPorts.length > 0 ? (
                  <Select value={config.serialPath} onValueChange={(v) => update('serialPath', v)}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select device..." />
                    </SelectTrigger>
                    <SelectContent>
                      {serialPorts.map((p) => (
                        <SelectItem key={p.path} value={p.path}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={config.serialPath}
                    onChange={(e) => update('serialPath', e.target.value)}
                    placeholder="/dev/tty.usbserial-0001 or COM3"
                    className="flex-1"
                  />
                )}
                <Button variant="outline" size="sm" onClick={loadSerialPorts} disabled={loadingPorts}>
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingPorts ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              {serialPorts.length === 0 && !loadingPorts && (
                <p className="text-xs text-muted-foreground">No devices found. Connect a USB radio and click refresh.</p>
              )}
            </div>
          )}

          {config.connectionType === 'mqtt' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>MQTT Broker URL</Label>
                <Input
                  value={config.mqttBroker}
                  onChange={(e) => update('mqttBroker', e.target.value)}
                  placeholder="mqtt://broker.example.com:1883"
                />
              </div>
              <div className="space-y-2">
                <Label>MQTT Topic</Label>
                <Input
                  value={config.mqttTopic}
                  onChange={(e) => update('mqttTopic', e.target.value)}
                  placeholder="msh/#"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Channel Index</Label>
            <Input
              type="number"
              value={config.channelIndex}
              onChange={(e) => update('channelIndex', parseInt(e.target.value) || 0)}
              className="w-24"
              min={0}
              max={7}
            />
            <p className="text-xs text-muted-foreground">
              Meshtastic channel to monitor/send on (0-7). Only channels the node has access to.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Features</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Collection (SIGINT)</Label>
              <p className="text-xs text-muted-foreground">
                Monitor mesh messages, node positions, and telemetry
              </p>
            </div>
            <Switch checked={config.enableCollection} onCheckedChange={(v) => update('enableCollection', v)} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Alert Dispatch</Label>
              <p className="text-xs text-muted-foreground">
                Send compressed alerts over LoRa as fallback channel
              </p>
            </div>
            <Switch checked={config.enableDispatch} onCheckedChange={(v) => update('enableDispatch', v)} />
          </div>

          {config.enableDispatch && (
            <div className="space-y-3 pl-4 border-l-2 border-primary/30">
              <Label>Target Node IDs</Label>
              <div className="flex gap-2">
                <Input
                  value={nodeIdInput}
                  onChange={(e) => setNodeIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addNodeId()}
                  placeholder="!a1b2c3d4"
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={addNodeId}>
                  Add
                </Button>
              </div>
              {config.targetNodeIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {config.targetNodeIds.map((id) => (
                    <Badge key={id} variant="secondary" className="gap-1 font-mono text-xs">
                      {id}
                      <button
                        onClick={() => update('targetNodeIds', config.targetNodeIds.filter((n) => n !== id))}
                        className="hover:text-destructive"
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Leave empty to broadcast on the configured channel.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 flex-wrap">
        <Button onClick={handleSave} disabled={saving || didSave}>
          {didSave ? <><Check className="h-4 w-4 mr-2" /> Saved</> : 'Save Meshtastic Settings'}
        </Button>
        <Button
          variant="outline"
          onClick={() => test('Meshtastic', { ...config, sendTestMessage: false })}
          disabled={testing || (!config.address && config.connectionType === 'tcp')}
        >
          {testing ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testing...</>
          ) : (
            <><Radio className="h-4 w-4 mr-2" /> Test Connection</>
          )}
        </Button>
        <Button
          variant="outline"
          onClick={() => test('Meshtastic', { ...config, sendTestMessage: true })}
          disabled={testing || (!config.address && config.connectionType === 'tcp')}
        >
          <Send className="h-4 w-4 mr-2" /> Send Test Message
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
