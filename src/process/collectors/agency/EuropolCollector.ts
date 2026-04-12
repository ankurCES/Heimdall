import RssParser from 'rss-parser'
import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Europol public information via RSS/news feeds
const parser = new RssParser({
  timeout: 15000,
  headers: { 'User-Agent': 'Heimdall/0.1.0 (Public Safety Intelligence Monitor)' }
})

const EUROPOL_FEEDS = [
  { url: 'https://www.europol.europa.eu/rss.xml', name: 'Europol News' },
  { url: 'https://www.europol.europa.eu/publications-events/rss.xml', name: 'Europol Publications' }
]

export class EuropolCollector extends BaseCollector {
  readonly discipline = 'agency' as const
  readonly type = 'europol'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    for (const feed of EUROPOL_FEEDS) {
      try {
        const parsed = await parser.parseURL(feed.url)

        for (const item of parsed.items.slice(0, 15)) {
          if (!item.title) continue

          const content = item.contentSnippet || item.content || item.title
          const severity = this.classifySeverity(item.title + ' ' + content)

          reports.push(
            this.createReport({
              title: `Europol: ${item.title}`,
              content: `**Source**: ${feed.name}\n**Published**: ${item.pubDate || 'Unknown'}\n\n${this.cleanContent(content)}`,
              severity,
              sourceUrl: item.link,
              sourceName: feed.name,
              verificationScore: 95
            })
          )
        }

        log.debug(`Europol: ${feed.name} — ${parsed.items.length} items`)
      } catch (err) {
        log.warn(`Europol feed failed: ${feed.name}: ${err}`)
      }
    }

    return reports
  }

  private classifySeverity(text: string): IntelReport['severity'] {
    const lower = text.toLowerCase()
    if (lower.includes('arrest') || lower.includes('dismantled') || lower.includes('operation')) return 'high'
    if (lower.includes('warning') || lower.includes('threat') || lower.includes('fraud')) return 'medium'
    return 'low'
  }

  private cleanContent(content: string): string {
    return content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  }
}
