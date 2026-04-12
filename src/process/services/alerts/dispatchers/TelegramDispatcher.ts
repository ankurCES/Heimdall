import { Bot } from 'grammy'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../settings/SettingsService'
import type { TelegramConfig } from '@common/types/settings'
import log from 'electron-log'

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪'
}

export class TelegramDispatcher {
  async send(report: IntelReport, chatIds?: string[]): Promise<void> {
    const config = settingsService.get<TelegramConfig>('telegram')
    if (!config?.botToken) throw new Error('Telegram bot not configured')

    const targetIds = chatIds || config.chatIds
    if (!targetIds || targetIds.length === 0) throw new Error('No Telegram chat IDs configured')

    const bot = new Bot(config.botToken)
    const message = this.formatMessage(report, config.messageFormat)

    for (const chatId of targetIds) {
      try {
        // Split long messages (Telegram limit: 4096 chars)
        const chunks = this.splitMessage(message, 4000)
        for (const chunk of chunks) {
          await bot.api.sendMessage(chatId, chunk, {
            parse_mode: config.messageFormat === 'html' ? 'HTML' : 'MarkdownV2'
          })
        }
      } catch (err) {
        log.warn(`Telegram send failed for chat ${chatId}: ${err}`)
        throw err
      }
    }

    log.info(`Telegram alert sent: ${report.title.slice(0, 50)} → ${targetIds.length} chats`)
  }

  private formatMessage(report: IntelReport, format: string): string {
    const emoji = SEVERITY_EMOJI[report.severity] || '⚪'

    if (format === 'html') {
      return `${emoji} <b>HEIMDALL ${report.severity.toUpperCase()} ALERT</b>

<b>${this.escapeHtml(report.title)}</b>

<b>Discipline:</b> ${report.discipline.toUpperCase()}
<b>Source:</b> ${this.escapeHtml(report.sourceName)}
<b>Verification:</b> ${report.verificationScore}/100
<b>Time:</b> ${new Date(report.createdAt).toISOString()}

${this.escapeHtml(report.content.slice(0, 1500))}
${report.sourceUrl ? `\n<a href="${this.escapeHtml(report.sourceUrl)}">View Source</a>` : ''}`
    }

    // MarkdownV2 format
    const escape = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
    return `${emoji} *HEIMDALL ${report.severity.toUpperCase()} ALERT*

*${escape(report.title)}*

*Discipline:* ${report.discipline.toUpperCase()}
*Source:* ${escape(report.sourceName)}
*Verification:* ${report.verificationScore}/100

${escape(report.content.slice(0, 1500))}
${report.sourceUrl ? `\n[View Source](${report.sourceUrl})` : ''}`
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }
      const cutAt = remaining.lastIndexOf('\n', maxLen)
      const splitAt = cutAt > maxLen * 0.5 ? cutAt : maxLen
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt)
    }
    return chunks
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}
