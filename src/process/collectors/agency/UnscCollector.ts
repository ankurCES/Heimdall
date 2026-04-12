import RssParser from 'rss-parser'
import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// UN Security Council — free, no auth
const parser = new RssParser({
  timeout: 15000,
  headers: { 'User-Agent': 'Heimdall/0.1.0 (Public Safety Intelligence Monitor)' }
})

const UNSC_FEEDS = [
  { url: 'https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml', name: 'UN Peace & Security' },
  { url: 'https://press.un.org/en/rss.xml', name: 'UN Press Releases' }
]

export class UnscCollector extends BaseCollector {
  readonly discipline = 'agency' as const
  readonly type = 'unsc'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    for (const feed of UNSC_FEEDS) {
      try {
        const parsed = await parser.parseURL(feed.url)

        for (const item of parsed.items.slice(0, 15)) {
          if (!item.title) continue

          const content = item.contentSnippet || item.content || item.title
          const severity = this.classifySeverity(item.title + ' ' + content)

          reports.push(
            this.createReport({
              title: `UN: ${item.title}`,
              content: `**Source**: ${feed.name}\n**Published**: ${item.pubDate || 'Unknown'}\n\n${this.cleanContent(content)}`,
              severity,
              sourceUrl: item.link,
              sourceName: feed.name,
              verificationScore: 95
            })
          )
        }

        log.debug(`UNSC: ${feed.name} — ${parsed.items.length} items`)
      } catch (err) {
        log.warn(`UNSC feed failed: ${feed.name}: ${err}`)
      }
    }

    return reports
  }

  private classifySeverity(text: string): IntelReport['severity'] {
    const lower = text.toLowerCase()
    if (lower.includes('conflict') || lower.includes('crisis') || lower.includes('emergency')) return 'high'
    if (lower.includes('resolution') || lower.includes('sanctions') || lower.includes('ceasefire')) return 'medium'
    return 'low'
  }

  private cleanContent(content: string): string {
    return content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  }
}
