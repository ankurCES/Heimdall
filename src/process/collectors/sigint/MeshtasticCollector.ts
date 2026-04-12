import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import { getDatabase } from '../../services/database'
import { timestamp } from '@common/utils/id'
import type { MeshtasticConfig } from '@common/types/settings'
import log from 'electron-log'

export class MeshtasticCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'meshtastic'

  private messageBuffer: Array<{
    from: number; text: string; channel: number; timestamp: number
  }> = []

  private nodePositions: Map<number, {
    latitude: number; longitude: number; altitude: number; lastSeen: number
  }> = new Map()

  private telemetry: Map<number, {
    batteryLevel: number; voltage: number; channelUtilization: number; airUtilTx: number; lastSeen: number
  }> = new Map()

  // Track all channels with activity
  private channelActivity: Map<number, number> = new Map() // channel → message count

  async collect(): Promise<IntelReport[]> {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.enableCollection) return []

    const reports: IntelReport[] = []

    // Process buffered messages from ALL channels
    const messages = this.messageBuffer.splice(0, this.messageBuffer.length)
    for (const msg of messages) {
      this.channelActivity.set(msg.channel, (this.channelActivity.get(msg.channel) || 0) + 1)

      reports.push(
        this.createReport({
          title: `Mesh Message from 0x${msg.from.toString(16)} [CH${msg.channel}]`,
          content: `**From Node**: 0x${msg.from.toString(16)}\n**Channel**: ${msg.channel}\n**Time**: ${new Date(msg.timestamp).toISOString()}\n\n${msg.text}`,
          severity: 'info',
          sourceName: `Meshtastic CH${msg.channel}`,
          verificationScore: 40
        })
      )
    }

    // Persist node positions to DB
    for (const [nodeId, pos] of this.nodePositions) {
      this.persistNode(nodeId, pos)

      reports.push(
        this.createReport({
          title: `Mesh Node: 0x${nodeId.toString(16)}`,
          content: `**Node**: 0x${nodeId.toString(16)}\n**Position**: ${pos.latitude}, ${pos.longitude}\n**Altitude**: ${pos.altitude} m\n**Last Seen**: ${new Date(pos.lastSeen).toISOString()}`,
          severity: 'info',
          sourceName: 'Meshtastic Node',
          latitude: pos.latitude,
          longitude: pos.longitude,
          verificationScore: 70
        })
      )
    }

    // Telemetry summary + persist
    if (this.telemetry.size > 0) {
      const telLines = Array.from(this.telemetry.entries())
        .map(([id, t]) => {
          this.persistNodeTelemetry(id, t)
          return `- **0x${id.toString(16)}**: Battery ${t.batteryLevel}%, Ch Util ${(t.channelUtilization * 100).toFixed(1)}%, SNR ${(t.airUtilTx * 100).toFixed(1)}%`
        })
        .join('\n')

      reports.push(
        this.createReport({
          title: `Mesh Telemetry (${this.telemetry.size} nodes)`,
          content: `**Nodes**: ${this.telemetry.size}\n\n${telLines}\n\n## Channel Activity\n${this.getChannelReport()}\n\n## Recommended Mode\n${this.getRecommendedMode()}`,
          severity: 'info',
          sourceName: 'Meshtastic Telemetry',
          verificationScore: 80
        })
      )
    }

    log.debug(`Meshtastic: ${messages.length} msgs, ${this.nodePositions.size} nodes, ${this.telemetry.size} telemetry, ${this.channelActivity.size} active channels`)

    this.nodePositions.clear()
    this.telemetry.clear()

    return reports
  }

  // Monitor all 8 channels
  getMonitoredChannels(): number[] {
    return [0, 1, 2, 3, 4, 5, 6, 7]
  }

  // Persist node to meshtastic_nodes table
  private persistNode(nodeId: number, pos: { latitude: number; longitude: number; altitude: number; lastSeen: number }): void {
    try {
      const db = getDatabase()
      const nodeIdStr = `0x${nodeId.toString(16)}`
      const now = timestamp()

      db.prepare(`
        INSERT INTO meshtastic_nodes (node_id, latitude, longitude, last_heard, first_seen, last_seen, seen_count)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(node_id) DO UPDATE SET
          latitude = ?, longitude = ?, last_heard = ?, last_seen = ?, seen_count = seen_count + 1
      `).run(nodeIdStr, pos.latitude, pos.longitude, pos.lastSeen, now, now,
        pos.latitude, pos.longitude, pos.lastSeen, now)
    } catch (err) {
      log.debug(`Mesh node persist failed: ${err}`)
    }
  }

  private persistNodeTelemetry(nodeId: number, tel: { batteryLevel: number; voltage: number; channelUtilization: number; airUtilTx: number }): void {
    try {
      const db = getDatabase()
      const nodeIdStr = `0x${nodeId.toString(16)}`

      db.prepare(`
        UPDATE meshtastic_nodes SET battery_level = ?, snr = ?, last_seen = ? WHERE node_id = ?
      `).run(tel.batteryLevel, tel.airUtilTx, timestamp(), nodeIdStr)
    } catch {}
  }

  private getChannelReport(): string {
    if (this.channelActivity.size === 0) return 'No channel activity detected'
    return Array.from(this.channelActivity.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ch, count]) => `- **Channel ${ch}**: ${count} messages`)
      .join('\n')
  }

  // Suggest optimal LoRa mode based on traffic analysis
  getRecommendedMode(): string {
    const totalMessages = Array.from(this.channelActivity.values()).reduce((s, c) => s + c, 0)
    const avgChannelUtil = this.telemetry.size > 0
      ? Array.from(this.telemetry.values()).reduce((s, t) => s + t.channelUtilization, 0) / this.telemetry.size
      : 0

    if (avgChannelUtil > 0.5) {
      return '**SHORT_FAST** — High channel utilization detected. Use short range / fast mode to reduce airtime and congestion.'
    }
    if (totalMessages > 50) {
      return '**MEDIUM_SLOW** — Moderate traffic. Medium range with slower data rate for reliability.'
    }
    if (this.nodePositions.size > 10) {
      return '**LONG_MODERATE** — Many nodes detected. Long range with moderate speed for maximum coverage.'
    }
    return '**LONG_FAST** — Low traffic. Use long range / fast mode for maximum SIGINT coverage.'
  }

  // Event handlers
  onMessage(from: number, text: string, channel: number): void {
    this.messageBuffer.push({ from, text, channel, timestamp: Date.now() })
  }

  onPosition(nodeId: number, latitude: number, longitude: number, altitude: number): void {
    this.nodePositions.set(nodeId, { latitude, longitude, altitude, lastSeen: Date.now() })
  }

  onTelemetry(nodeId: number, batteryLevel: number, voltage: number, channelUtilization: number, airUtilTx: number): void {
    this.telemetry.set(nodeId, { batteryLevel, voltage, channelUtilization, airUtilTx, lastSeen: Date.now() })
  }
}
