import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../settings/SettingsService'
import type { MeshtasticConfig } from '@common/types/settings'
import log from 'electron-log'

const SEVERITY_PREFIX: Record<string, string> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO'
}

export class MeshtasticDispatcher {
  async send(report: IntelReport): Promise<void> {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.enableDispatch) throw new Error('Meshtastic dispatch not enabled')
    if (!config.address && config.connectionType === 'tcp') throw new Error('Meshtastic node address not configured')

    // Compact message for LoRa (~230 byte payload limit)
    const message = this.formatCompact(report)

    // For now, log the dispatch — actual @meshtastic/js client integration
    // will be added when the package is installed in a future phase
    log.info(`Meshtastic dispatch (${message.length} bytes): ${message}`)

    // TODO: When @meshtastic/js is available:
    // const client = getMeshtasticClient()
    // if (config.targetNodeIds.length > 0) {
    //   for (const nodeId of config.targetNodeIds) {
    //     await client.sendText(message, nodeId, { wantAck: true })
    //   }
    // } else {
    //   await client.sendText(message, undefined, { channelIndex: config.channelIndex })
    // }

    log.info(`Meshtastic alert queued: ${report.title.slice(0, 40)} → ${config.targetNodeIds.length || 'broadcast'}`)
  }

  /** Send a free-form text alert (used by AlertEscalationService). */
  async sendCustom(text: string): Promise<void> {
    const config = settingsService.get<MeshtasticConfig>('meshtastic')
    if (!config?.enableDispatch) throw new Error('Meshtastic dispatch not enabled')
    log.info(`Meshtastic custom dispatch (${text.length} bytes): ${text.slice(0, 100)}…`)
    // Same TODO as send() — wire to @meshtastic/js when available.
  }

  private formatCompact(report: IntelReport): string {
    const prefix = SEVERITY_PREFIX[report.severity] || 'INFO'
    const disc = report.discipline.toUpperCase().slice(0, 4)
    const title = report.title.slice(0, 80)
    const summary = report.content.slice(0, 100).replace(/\n/g, ' ')

    // Target: under 230 bytes
    const msg = `[${prefix}|${disc}] ${title}\n${summary}`
    return msg.slice(0, 228)
  }
}
