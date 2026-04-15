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
    // Fetch all configured feeds in parallel — one slow feed used to block
    // every subsequent one (sequential await), pushing the collector cycle
    // past 60 s when any single feed timed out at 15 s. Promise.allSettled
    // lets fast feeds complete in their own time and isolates failures.
    const feeds = this.getFeeds()
    if (feeds.length === 0) return []

    const settled = await Promise.allSettled(
      feeds.map((feed) => parser.parseURL(feed.url).then((parsed) => ({ feed, parsed })))
    )

    const reports: IntelReport[] = []
    for (const result of settled) {
      if (result.status === 'rejected') {
        const reason = result.reason as { message?: string }
        log.warn(`Forum feed failed: ${reason?.message || result.reason}`)
        continue
      }
      const { feed, parsed } = result.value
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
