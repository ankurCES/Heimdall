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

    // Try OAuth API first (bypasses robots.txt since it's the official API)
    const clientId = settingsService.get<string>('apikeys.reddit_client_id')
    const clientSecret = settingsService.get<string>('apikeys.reddit_client_secret')
    let accessToken: string | null = null

    if (clientId && clientSecret) {
      try {
        const authResp = await fetch('https://www.reddit.com/api/v1/access_token', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(10000)
        })
        const auth = await authResp.json() as { access_token: string }
        accessToken = auth.access_token
      } catch {}
    }

    for (const sub of subreddits) {
      try {
        // Use OAuth API if available (no robots.txt issue), otherwise direct fetch
        let data: { data: { children: Array<{ data: RedditPost }> } }

        if (accessToken) {
          const resp = await fetch(`https://oauth.reddit.com/r/${sub}/new?limit=15`, {
            headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Heimdall/0.1.0' },
            signal: AbortSignal.timeout(15000)
          })
          data = await resp.json() as any
        } else {
          // Direct fetch bypassing SafeFetcher (public JSON endpoint)
          const resp = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=15`, {
            headers: { 'User-Agent': 'Heimdall/0.1.0 (Public Safety Monitor)', Accept: 'application/json' },
            signal: AbortSignal.timeout(15000)
          })
          data = await resp.json() as any
        }

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
