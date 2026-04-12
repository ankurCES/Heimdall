import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

// Twitter/X API v2 — requires Bearer Token
// Docs: https://developer.x.com/en/docs/twitter-api/tweets/search/api-reference/get-tweets-search-recent
const TWITTER_API = 'https://api.twitter.com/2'

interface Tweet {
  id: string
  text: string
  created_at: string
  author_id: string
  public_metrics?: {
    retweet_count: number
    reply_count: number
    like_count: number
  }
}

interface TwitterSearchResponse {
  data?: Tweet[]
  meta?: { result_count: number; next_token?: string }
  includes?: { users?: Array<{ id: string; name: string; username: string }> }
}

export class TwitterCollector extends BaseCollector {
  readonly discipline = 'socmint' as const
  readonly type = 'twitter'

  async collect(): Promise<IntelReport[]> {
    const bearerToken = settingsService.get<string>('apikeys.twitter')
    if (!bearerToken) {
      log.warn('Twitter collector: no bearer token configured')
      return []
    }

    const reports: IntelReport[] = []
    const queries = this.getQueries()

    for (const query of queries) {
      try {
        const params = new URLSearchParams({
          query: query + ' -is:retweet lang:en',
          max_results: '20',
          'tweet.fields': 'created_at,public_metrics,author_id',
          expansions: 'author_id',
          'user.fields': 'name,username'
        })

        const data = await this.fetchJson<TwitterSearchResponse>(
          `${TWITTER_API}/tweets/search/recent?${params.toString()}`,
          { headers: { Authorization: `Bearer ${bearerToken}` } }
        )

        if (!data.data) continue

        const userMap = new Map<string, string>()
        for (const user of data.includes?.users || []) {
          userMap.set(user.id, `@${user.username} (${user.name})`)
        }

        for (const tweet of data.data) {
          const author = userMap.get(tweet.author_id) || tweet.author_id
          const engagement = tweet.public_metrics
            ? tweet.public_metrics.retweet_count + tweet.public_metrics.like_count
            : 0
          const severity = this.classifySeverity(tweet.text, engagement)

          reports.push(
            this.createReport({
              title: `Twitter: ${tweet.text.slice(0, 80)}...`,
              content: `**Author**: ${author}\n**Posted**: ${tweet.created_at}\n**Engagement**: ${engagement} (RT: ${tweet.public_metrics?.retweet_count || 0}, Likes: ${tweet.public_metrics?.like_count || 0})\n**Query**: "${query}"\n\n${tweet.text}`,
              severity,
              sourceUrl: `https://twitter.com/i/web/status/${tweet.id}`,
              sourceName: 'Twitter/X',
              verificationScore: 30 // Social media — low verification
            })
          )
        }

        log.debug(`Twitter: "${query}" — ${data.data.length} tweets`)
      } catch (err) {
        log.warn(`Twitter search failed for "${query}": ${err}`)
      }
    }

    return reports
  }

  private getQueries(): string[] {
    const custom = this.sourceConfig?.config?.queries as string[] | undefined
    return custom && custom.length > 0
      ? custom
      : ['(terrorism OR attack OR explosion) -"fantasy football"', 'cyber attack critical infrastructure', 'breaking emergency evacuate']
  }

  private classifySeverity(text: string, engagement: number): ThreatLevel {
    const lower = text.toLowerCase()
    const critical = ['breaking', 'explosion', 'mass shooting', 'terrorist attack', 'active shooter']
    const high = ['emergency', 'attack', 'bombing', 'hostage', 'evacuate']

    for (const kw of critical) {
      if (lower.includes(kw)) return 'critical'
    }
    for (const kw of high) {
      if (lower.includes(kw)) return engagement > 1000 ? 'high' : 'medium'
    }
    return engagement > 5000 ? 'medium' : 'low'
  }
}
