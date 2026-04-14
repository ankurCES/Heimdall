import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import type { TelegramConfig } from '@common/types/settings'
import log from 'electron-log'

// Telegram Bot API — monitors public channels the bot is added to
// The bot must be added to the public channel as an admin to receive messages

interface TelegramUpdate {
  update_id: number
  channel_post?: {
    message_id: number
    chat: { id: number; title: string; type: string }
    date: number
    text?: string
    caption?: string
  }
}

export class TelegramChannelCollector extends BaseCollector {
  readonly discipline = 'socmint' as const
  readonly type = 'telegram-channel'

  private lastUpdateId = 0

  async collect(): Promise<IntelReport[]> {
    const telegramConfig = settingsService.get<TelegramConfig>('telegram')
    if (!telegramConfig?.botToken) {
      log.warn('TelegramChannelCollector: no bot token configured')
      return []
    }

    const reports: IntelReport[] = []

    try {
      const params = new URLSearchParams({
        offset: String(this.lastUpdateId + 1),
        limit: '50',
        allowed_updates: JSON.stringify(['channel_post'])
      })

      const data = await this.fetchJson<{ ok: boolean; result: TelegramUpdate[] }>(
        `https://api.telegram.org/bot${telegramConfig.botToken}/getUpdates?${params.toString()}`
      )

      if (!data.ok || !data.result) return []

      for (const update of data.result) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id)

        const post = update.channel_post
        if (!post) continue

        const text = post.text || post.caption || ''
        if (!text) continue

        const topic = this.classifyTopic(text, post.chat.title)
        const severity = topic.severity

        reports.push(
          this.createReport({
            title: `Telegram [${post.chat.title}]: ${text.slice(0, 80)}...`,
            content: `**Channel**: ${post.chat.title}\n**Chat ID**: ${post.chat.id}\n**Topic**: ${topic.label}\n**Posted**: ${new Date(post.date * 1000).toISOString()}\n\n${text}`,
            severity,
            sourceName: `Telegram: ${post.chat.title}`,
            verificationScore: topic.verified ? 60 : 20
          })
        )
      }

      log.debug(`Telegram: ${data.result.length} updates, ${reports.length} channel posts`)
    } catch (err) {
      log.warn(`TelegramChannelCollector failed: ${err}`)
    }

    return reports
  }

  // Topic classification based on World Monitor's curated Telegram channel taxonomy
  private classifyTopic(text: string, channelTitle: string): { label: string; severity: import('@common/types/intel').ThreatLevel; verified: boolean } {
    const t = (text + ' ' + channelTitle).toLowerCase()

    // Verified OSINT channels (higher trust)
    const verifiedChannels = ['bellingcat', 'aurora intel', 'bno news', 'liveuamap', 'osintdefender', 'war monitor', 'nexta', 'deepstate']
    const isVerified = verifiedChannels.some((ch) => channelTitle.toLowerCase().includes(ch))

    // Breaking news detection
    if (/\b(breaking|urgent|alert|just in|confirmed)\b/i.test(text)) {
      return { label: 'Breaking', severity: 'high', verified: isVerified }
    }

    // Conflict/military
    if (/\b(attack|strike|missile|drone|artillery|air raid|explosion|killed|casualties|wounded)\b/i.test(text)) {
      return { label: 'Conflict', severity: 'high', verified: isVerified }
    }

    // Air raid / sirens
    if (/\b(siren|air alert|air raid|alarm|shelter|intercept)\b/i.test(text)) {
      return { label: 'Alert', severity: 'critical', verified: isVerified }
    }

    // Political / sanctions
    if (/\b(sanction|diplomat|summit|treaty|ceasefire|negotiate|election|president|minister)\b/i.test(text)) {
      return { label: 'Politics', severity: 'medium', verified: isVerified }
    }

    // OSINT / intelligence
    if (/\b(osint|intel|satellite|imagery|geolocated|verified|footage|confirmed)\b/i.test(text)) {
      return { label: 'OSINT', severity: 'medium', verified: isVerified }
    }

    return { label: 'General', severity: 'low', verified: isVerified }
  }
}
