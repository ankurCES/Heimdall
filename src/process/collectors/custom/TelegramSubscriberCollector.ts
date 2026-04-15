import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Telegram Channel Subscriber — public channel scraper (no Bot API needed)
// Scrapes the public preview pages at https://t.me/s/{username}
// Works for any public Telegram channel without authentication
//
// Example config:
// {
//   channels: [
//     { username: 'bellingcat', topic: 'OSINT' },
//     { username: 'osintdefender' }
//   ],
//   maxPostsPerChannel: 10
// }

interface TgConfig {
  channels?: Array<{ username: string; topic?: string }>
  maxPostsPerChannel?: number
}

export class TelegramSubscriberCollector extends BaseCollector {
  readonly discipline = 'socmint' as const
  readonly type = 'telegram-subscriber'

  async collect(): Promise<IntelReport[]> {
    const cfg = (this.sourceConfig?.config || {}) as TgConfig
    const channels = cfg.channels || []
    if (channels.length === 0) {
      log.warn(`TelegramSubscriber: no channels configured for ${this.sourceConfig?.name}`)
      return []
    }

    const reports: IntelReport[] = []
    const maxPosts = cfg.maxPostsPerChannel || 10

    for (const ch of channels) {
      try {
        // Direct fetch — t.me may block crawler UAs
        const resp = await fetch(`https://t.me/s/${encodeURIComponent(ch.username)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            Accept: 'text/html,application/xhtml+xml'
          },
          signal: AbortSignal.timeout(15000)
        })

        if (!resp.ok) {
          log.debug(`Telegram channel ${ch.username}: HTTP ${resp.status}`)
          continue
        }

        const html = await resp.text()
        const posts = this.parseChannelPage(html).slice(-maxPosts)

        for (const post of posts) {
          if (!post.text || post.text.length < 5) continue

          const topic = this.classifyTopic(post.text, ch.username)
          reports.push(this.createReport({
            title: `Telegram [@${ch.username}]: ${post.text.slice(0, 80)}`,
            content: `**Channel**: @${ch.username}\n**Topic**: ${topic.label}\n**Posted**: ${post.date || 'unknown'}\n${post.views ? `**Views**: ${post.views}\n` : ''}\n${post.text}`,
            severity: topic.severity,
            sourceUrl: post.url || `https://t.me/${ch.username}`,
            sourceName: `Telegram: @${ch.username}`,
            verificationScore: topic.verified ? 65 : 30
          }))
        }

        log.debug(`Telegram @${ch.username}: ${posts.length} posts`)
      } catch (err) {
        log.debug(`Telegram channel ${ch.username} failed: ${err}`)
      }
    }

    log.info(`TelegramSubscriber [${this.sourceConfig?.name}]: ${reports.length} posts from ${channels.length} channels`)
    return reports
  }

  // Parse Telegram public preview HTML — extract message blocks
  private parseChannelPage(html: string): Array<{ text: string; date?: string; views?: string; url?: string }> {
    const posts: Array<{ text: string; date?: string; views?: string; url?: string }> = []

    // Match each <div class="tgme_widget_message ...">...</div>
    const messageRegex = /<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="tgme_widget_message|<\/section)/g
    let match
    while ((match = messageRegex.exec(html)) !== null) {
      const dataPost = match[1] // e.g., 'bellingcat/12345'
      const block = match[2]

      // Extract text from <div class="tgme_widget_message_text...">
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)
      if (!textMatch) continue
      const text = textMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '$2 ($1)')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()

      // Extract date
      const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/)
      const date = dateMatch?.[1]

      // Extract view count
      const viewsMatch = block.match(/<span class="tgme_widget_message_views">([^<]+)<\/span>/)
      const views = viewsMatch?.[1]

      posts.push({ text, date, views, url: `https://t.me/${dataPost}` })
    }

    return posts
  }

  // Classify topic + severity (mirrors TelegramChannelCollector logic)
  private classifyTopic(text: string, channelName: string): { label: string; severity: ThreatLevel; verified: boolean } {
    const verifiedChannels = ['bellingcat', 'aurorasintl', 'bnonews', 'liveuamap', 'osintdefender', 'warmonitors', 'deepstateua', 'nexta_tv']
    const isVerified = verifiedChannels.some((v) => channelName.toLowerCase().includes(v))

    if (/\b(breaking|urgent|alert|just in|confirmed)\b/i.test(text)) return { label: 'Breaking', severity: 'high', verified: isVerified }
    if (/\b(siren|air alert|air raid|alarm|shelter|intercept)\b/i.test(text)) return { label: 'Alert', severity: 'critical', verified: isVerified }
    if (/\b(attack|strike|missile|drone|artillery|explosion|killed|casualties)\b/i.test(text)) return { label: 'Conflict', severity: 'high', verified: isVerified }
    if (/\b(sanction|diplomat|summit|treaty|ceasefire|election|president)\b/i.test(text)) return { label: 'Politics', severity: 'medium', verified: isVerified }
    if (/\b(osint|intel|satellite|imagery|geolocated|verified|footage)\b/i.test(text)) return { label: 'OSINT', severity: 'medium', verified: isVerified }
    return { label: 'General', severity: 'low', verified: isVerified }
  }
}
