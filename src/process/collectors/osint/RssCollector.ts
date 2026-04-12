import RssParser from 'rss-parser'
import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

const parser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Heimdall/0.1.0 (Public Safety Intelligence Monitor)'
  }
})

const DEFAULT_FEEDS = [
  { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters World News' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'NYT World' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World News' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
  { url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', name: 'UN News' },
  { url: 'https://www.state.gov/rss-feed/press-releases/feed/', name: 'US State Dept' },
  { url: 'https://www.fema.gov/api/open/v1/DisasterDeclarationsSummaries.rss', name: 'FEMA Disasters' }
]

const THREAT_KEYWORDS: Record<ThreatLevel, string[]> = {
  critical: ['attack', 'explosion', 'mass shooting', 'terrorism', 'nuclear', 'chemical attack', 'hostage', 'assassination'],
  high: ['conflict', 'military', 'bombing', 'armed', 'emergency', 'evacuation', 'crisis', 'sanctions', 'missile'],
  medium: ['protest', 'unrest', 'cyber', 'breach', 'earthquake', 'hurricane', 'flood', 'wildfire', 'warning'],
  low: ['tension', 'dispute', 'investigation', 'arrest', 'surveillance', 'policy', 'regulation'],
  info: []
}

export class RssCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'rss'

  async collect(): Promise<IntelReport[]> {
    const feeds = this.getFeeds()
    const reports: IntelReport[] = []

    for (const feed of feeds) {
      try {
        const parsed = await parser.parseURL(feed.url)
        const items = parsed.items.slice(0, 20) // Latest 20 per feed

        for (const item of items) {
          if (!item.title) continue

          const content = item.contentSnippet || item.content || item.summary || item.title
          const severity = this.classifySeverity(item.title + ' ' + content)

          reports.push(
            this.createReport({
              title: item.title,
              content: this.cleanContent(content),
              severity,
              sourceUrl: item.link,
              sourceName: feed.name,
              verificationScore: 75 // Established news sources
            })
          )
        }

        log.debug(`RSS: ${feed.name} — ${items.length} items`)
      } catch (err) {
        log.warn(`RSS feed failed: ${feed.name} (${feed.url}): ${err}`)
      }
    }

    return reports
  }

  private getFeeds(): Array<{ url: string; name: string }> {
    const custom = this.sourceConfig?.config?.feeds as Array<{ url: string; name: string }> | undefined
    return custom && custom.length > 0 ? custom : DEFAULT_FEEDS
  }

  private classifySeverity(text: string): ThreatLevel {
    const lower = text.toLowerCase()
    for (const [level, keywords] of Object.entries(THREAT_KEYWORDS) as Array<[ThreatLevel, string[]]>) {
      if (level === 'info') continue
      for (const keyword of keywords) {
        if (lower.includes(keyword)) return level
      }
    }
    return 'info'
  }

  private cleanContent(content: string): string {
    // Strip HTML tags
    return content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 5000)
  }
}
