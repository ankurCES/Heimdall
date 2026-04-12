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

        reports.push(
          this.createReport({
            title: `Telegram [${post.chat.title}]: ${text.slice(0, 80)}...`,
            content: `**Channel**: ${post.chat.title}\n**Chat ID**: ${post.chat.id}\n**Posted**: ${new Date(post.date * 1000).toISOString()}\n\n${text}`,
            severity: 'low',
            sourceName: `Telegram: ${post.chat.title}`,
            verificationScore: 20
          })
        )
      }

      log.debug(`Telegram: ${data.result.length} updates, ${reports.length} channel posts`)
    } catch (err) {
      log.warn(`TelegramChannelCollector failed: ${err}`)
    }

    return reports
  }
}
