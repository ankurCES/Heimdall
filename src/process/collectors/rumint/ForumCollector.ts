import RssParser from 'rss-parser'
import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { VerificationScorer } from './VerificationScorer'
import log from 'electron-log'

const parser = new RssParser({
  timeout: 15000,
  headers: { 'User-Agent': 'Heimdall/0.1.0 (Public Safety Intelligence Monitor)' }
})

export class ForumCollector extends BaseCollector {
  readonly discipline = 'rumint' as const
  readonly type = 'forum'

  private scorer = new VerificationScorer()

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // Collect from configured RSS feeds
    const feeds = this.getFeeds()
    for (const feed of feeds) {
      try {
        const parsed = await parser.parseURL(feed.url)
        for (const item of parsed.items.slice(0, 15)) {
          if (!item.title) continue

          const content = item.contentSnippet || item.content || item.title
          const score = this.scorer.score({
            sourceTier: feed.tier || 'unverified',
            hasCorroboration: false,
            specificity: this.assessSpecificity(content),
            age: item.pubDate ? (Date.now() - new Date(item.pubDate).getTime()) / 3600000 : 24
          })

          reports.push(
            this.createReport({
              title: `[RUMINT] ${feed.name}: ${item.title.slice(0, 80)}`,
              content: `**Source**: ${feed.name}\n**Verification Score**: ${score}/100 (UNVERIFIED)\n**Published**: ${item.pubDate || 'Unknown'}\n\n${this.cleanContent(content)}\n\n---\n*This is unverified rumor intelligence. Corroboration required before action.*`,
              severity: 'info',
              sourceUrl: item.link,
              sourceName: feed.name,
              verificationScore: score
            })
          )
        }

        log.debug(`Forum: ${feed.name} — ${parsed.items.length} items`)
      } catch (err) {
        log.warn(`Forum feed failed: ${feed.name}: ${err}`)
      }
    }

    return reports
  }

  private getFeeds(): Array<{ url: string; name: string; tier?: string }> {
    const custom = this.sourceConfig?.config?.feeds as Array<{ url: string; name: string; tier?: string }> | undefined
    return custom && custom.length > 0 ? custom : []
  }

  private assessSpecificity(content: string): 'high' | 'medium' | 'low' {
    const specifics = content.match(/\d{1,2}[\/\-]\d{1,2}|\d{4}|[A-Z]{2,}\d+|coordinates|latitude|longitude|address/gi)
    if (specifics && specifics.length >= 3) return 'high'
    if (specifics && specifics.length >= 1) return 'medium'
    return 'low'
  }

  private cleanContent(content: string): string {
    return content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  }
}
