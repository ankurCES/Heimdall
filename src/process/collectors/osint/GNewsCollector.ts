import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

// GNews API — free tier: 100 requests/day, no auth for search
// Docs: https://gnews.io/docs/v4
const GNEWS_API = 'https://gnews.io/api/v4'

interface GNewsArticle {
  title: string
  description: string
  content: string
  url: string
  image: string
  publishedAt: string
  source: { name: string; url: string }
}

export class GNewsCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'gnews'

  async collect(): Promise<IntelReport[]> {
    const apiKey = settingsService.get<string>('apikeys.gnews')
    if (!apiKey) {
      log.warn('GNewsCollector: no API key configured')
      return []
    }

    const reports: IntelReport[] = []
    const queries = this.getQueries()

    for (const query of queries) {
      try {
        const params = new URLSearchParams({
          q: query.q,
          lang: 'en',
          max: '10',
          apikey: apiKey,
          sortby: 'publishedAt'
        })

        if (query.country) params.set('country', query.country)
        if (query.topic) params.set('topic', query.topic)

        const data = await this.fetchJson<{
          totalArticles: number
          articles: GNewsArticle[]
        }>(`${GNEWS_API}/search?${params.toString()}`)

        for (const article of data.articles || []) {
          if (!article.title?.trim()) continue

          reports.push(
            this.createReport({
              title: article.title,
              content: `**Source**: ${article.source.name}\n**Published**: ${article.publishedAt}\n**Query**: "${query.q}"\n\n${article.description || ''}\n\n${article.content?.slice(0, 2000) || ''}`,
              severity: this.classifySeverity(article.title + ' ' + article.description),
              sourceUrl: article.url,
              sourceName: `GNews (${article.source.name})`,
              verificationScore: 65
            })
          )
        }

        log.debug(`GNews: "${query.q}" — ${data.articles?.length || 0} articles`)
      } catch (err) {
        log.warn(`GNews query failed for "${query.q}": ${err}`)
      }
    }

    return reports
  }

  private getQueries(): Array<{ q: string; country?: string; topic?: string }> {
    const custom = this.sourceConfig?.config?.queries as Array<{ q: string; country?: string; topic?: string }> | undefined
    return custom && custom.length > 0 ? custom : [
      { q: 'terrorism attack security threat' },
      { q: 'cyber attack data breach' },
      { q: 'military conflict escalation' },
      { q: 'sanctions enforcement' },
      { q: 'natural disaster emergency' }
    ]
  }

  private classifySeverity(text: string): ThreatLevel {
    const lower = text.toLowerCase()
    if (/attack|explosion|killed|shooting|bombing/.test(lower)) return 'critical'
    if (/conflict|military|emergency|breach|threat/.test(lower)) return 'high'
    if (/warning|sanctions|unrest|protest/.test(lower)) return 'medium'
    return 'low'
  }
}
