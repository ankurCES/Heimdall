import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

// Reddit API — uses public JSON endpoints (no auth needed for reading)
// For higher rate limits, OAuth2 can be used with client_id/secret

interface RedditPost {
  title: string
  selftext: string
  url: string
  permalink: string
  subreddit: string
  author: string
  created_utc: number
  score: number
  num_comments: number
  link_flair_text: string | null
}

export class RedditCollector extends BaseCollector {
  readonly discipline = 'socmint' as const
  readonly type = 'reddit'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const subreddits = this.getSubreddits()

    for (const sub of subreddits) {
      try {
        // Use public JSON API (no auth required for reading)
        const data = await this.fetchJson<{
          data: { children: Array<{ data: RedditPost }> }
        }>(`https://www.reddit.com/r/${sub}/new.json?limit=15`, {
          headers: { Accept: 'application/json' }
        })

        for (const child of data.data.children) {
          const post = child.data
          const severity = this.classifySeverity(post)

          reports.push(
            this.createReport({
              title: `r/${post.subreddit}: ${post.title.slice(0, 100)}`,
              content: `**Subreddit**: r/${post.subreddit}\n**Author**: u/${post.author}\n**Score**: ${post.score} | **Comments**: ${post.num_comments}\n**Flair**: ${post.link_flair_text || 'None'}\n**Posted**: ${new Date(post.created_utc * 1000).toISOString()}\n\n${post.selftext?.slice(0, 3000) || post.url || 'Link post'}`,
              severity,
              sourceUrl: `https://reddit.com${post.permalink}`,
              sourceName: `Reddit r/${post.subreddit}`,
              verificationScore: 25 // Reddit — requires corroboration
            })
          )
        }

        log.debug(`Reddit: r/${sub} — ${data.data.children.length} posts`)
      } catch (err) {
        log.warn(`Reddit fetch failed for r/${sub}: ${err}`)
      }
    }

    return reports
  }

  private getSubreddits(): string[] {
    const custom = this.sourceConfig?.config?.subreddits as string[] | undefined
    return custom && custom.length > 0
      ? custom
      : ['worldnews', 'cybersecurity', 'netsec', 'geopolitics', 'intelligence']
  }

  private classifySeverity(post: RedditPost): ThreatLevel {
    const text = (post.title + ' ' + (post.selftext || '')).toLowerCase()
    const isHot = post.score > 1000

    if (text.includes('breaking') || text.includes('attack') || text.includes('explosion')) {
      return isHot ? 'critical' : 'high'
    }
    if (text.includes('breach') || text.includes('vulnerability') || text.includes('zero-day')) {
      return 'high'
    }
    if (text.includes('warning') || text.includes('threat') || text.includes('malware')) {
      return 'medium'
    }
    return 'low'
  }
}
