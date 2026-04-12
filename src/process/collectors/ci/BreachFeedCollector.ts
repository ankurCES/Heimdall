import RssParser from 'rss-parser'
import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

const parser = new RssParser({
  timeout: 15000,
  headers: { 'User-Agent': 'Heimdall/0.1.0 (Public Safety Intelligence Monitor)' }
})

const DEFAULT_FEEDS = [
  { url: 'https://www.databreaches.net/feed/', name: 'DataBreaches.net' },
  { url: 'https://krebsonsecurity.com/feed/', name: 'Krebs on Security' },
  { url: 'https://www.bleepingcomputer.com/feed/', name: 'BleepingComputer' },
  { url: 'https://therecord.media/feed', name: 'The Record' }
]

export class BreachFeedCollector extends BaseCollector {
  readonly discipline = 'ci' as const
  readonly type = 'breach-feed'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const feeds = this.getFeeds()

    for (const feed of feeds) {
      try {
        const parsed = await parser.parseURL(feed.url)

        for (const item of parsed.items.slice(0, 15)) {
          if (!item.title) continue

          const content = item.contentSnippet || item.content || item.title
          const isBreach = this.isBreachRelated(item.title + ' ' + content)

          if (!isBreach) continue

          reports.push(
            this.createReport({
              title: item.title,
              content: `**Source**: ${feed.name}\n**Published**: ${item.pubDate || 'Unknown'}\n\n${this.cleanContent(content)}`,
              severity: 'medium',
              sourceUrl: item.link,
              sourceName: feed.name,
              verificationScore: 75
            })
          )
        }

        log.debug(`BreachFeed: ${feed.name} — ${parsed.items.length} items`)
      } catch (err) {
        log.warn(`Breach feed failed: ${feed.name}: ${err}`)
      }
    }

    return reports
  }

  private getFeeds(): Array<{ url: string; name: string }> {
    const custom = this.sourceConfig?.config?.feeds as Array<{ url: string; name: string }> | undefined
    return custom && custom.length > 0 ? custom : DEFAULT_FEEDS
  }

  private isBreachRelated(text: string): boolean {
    const lower = text.toLowerCase()
    const keywords = ['breach', 'leak', 'hack', 'compromised', 'ransomware', 'data exposure', 'credential', 'vulnerability', 'exploit', 'malware']
    return keywords.some((kw) => lower.includes(kw))
  }

  private cleanContent(content: string): string {
    return content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  }
}
