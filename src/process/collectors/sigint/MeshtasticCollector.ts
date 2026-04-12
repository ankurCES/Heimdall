import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import type { MeshtasticConfig } from '@common/types/settings'
import log from 'electron-log'

// Meshtastic integration via @meshtastic/js
// This collector monitors mesh network traffic for SIGINT
// Connection is established when collection is enabled in settings

export class MeshtasticCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'meshtastic'

  private messageBuffer: Array<{
    from: number
    text: string
    channel: number
    timestamp: number
  }> = []

  private nodePositions: Map<number, {
    latitude: number
    longitude: number
    altitude: number
    lastSeen: number
  }> = new Map()

  private telemetry: Map<number, {
    batteryLevel: number
    voltage: number
    channelUtilization: number
    airUtilTx: number
    lastSeen: number
  }> = new Map()

  async collect(): Promise<IntelReport[]> {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.enableCollection) {
      return []
    }

    const reports: IntelReport[] = []

    // Process buffered messages
    const messages = this.messageBuffer.splice(0, this.messageBuffer.length)
    for (const msg of messages) {
      reports.push(
        this.createReport({
          title: `Mesh Message from node ${msg.from.toString(16)}`,
          content: `**From Node**: 0x${msg.from.toString(16)}\n**Channel**: ${msg.channel}\n**Time**: ${new Date(msg.timestamp).toISOString()}\n\n${msg.text}`,
          severity: 'info',
          sourceName: 'Meshtastic Mesh',
          verificationScore: 40
        })
      )
    }

    // Report node positions
    for (const [nodeId, pos] of this.nodePositions) {
      reports.push(
        this.createReport({
          title: `Mesh Node Position: 0x${nodeId.toString(16)}`,
          content: `**Node**: 0x${nodeId.toString(16)}\n**Position**: ${pos.latitude}, ${pos.longitude}\n**Altitude**: ${pos.altitude} m\n**Last Seen**: ${new Date(pos.lastSeen).toISOString()}`,
          severity: 'info',
          sourceName: 'Meshtastic Position',
          latitude: pos.latitude,
          longitude: pos.longitude,
          verificationScore: 70
        })
      )
    }

    // Report telemetry summaries
    if (this.telemetry.size > 0) {
      const telLines = Array.from(this.telemetry.entries())
        .map(([id, t]) => `- **0x${id.toString(16)}**: Battery ${t.batteryLevel}%, Voltage ${t.voltage}V, Channel ${(t.channelUtilization * 100).toFixed(1)}%, AirTx ${(t.airUtilTx * 100).toFixed(1)}%`)
        .join('\n')

      reports.push(
        this.createReport({
          title: `Mesh Network Telemetry (${this.telemetry.size} nodes)`,
          content: `**Nodes Reporting**: ${this.telemetry.size}\n\n${telLines}`,
          severity: 'info',
          sourceName: 'Meshtastic Telemetry',
          verificationScore: 80
        })
      )
    }

    log.debug(`Meshtastic: ${messages.length} messages, ${this.nodePositions.size} positions, ${this.telemetry.size} telemetry`)

    // Clear position/telemetry after reporting
    this.nodePositions.clear()
    this.telemetry.clear()

    return reports
  }

  // These methods will be called by the MeshtasticService (Phase 4+)
  // when @meshtastic/js client receives events

  onMessage(from: number, text: string, channel: number): void {
    this.messageBuffer.push({
      from,
      text,
      channel,
      timestamp: Date.now()
    })
  }

  onPosition(nodeId: number, latitude: number, longitude: number, altitude: number): void {
    this.nodePositions.set(nodeId, {
      latitude,
      longitude,
      altitude,
      lastSeen: Date.now()
    })
  }

  onTelemetry(nodeId: number, batteryLevel: number, voltage: number, channelUtilization: number, airUtilTx: number): void {
    this.telemetry.set(nodeId, {
      batteryLevel,
      voltage,
      channelUtilization,
      airUtilTx,
      lastSeen: Date.now()
    })
  }
}
