import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// GDELT Project — free, no auth, updates every 15 minutes
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc'
const GDELT_GEO_API = 'https://api.gdeltproject.org/api/v2/geo/geo'

interface GdeltArticle {
  url: string
  url_mobile: string
  title: string
  seendate: string
  socialimage: string
  domain: string
  language: string
  sourcecountry: string
}

export class GdeltCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'gdelt'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const queries = this.getQueries()

    for (const query of queries) {
      try {
        const params = new URLSearchParams({
          query: query.q,
          mode: 'ArtList',
          maxrecords: '25',
          format: 'json',
          timespan: query.timespan || '24h',
          sort: 'DateDesc'
        })

        const data = await this.fetchJson<{ articles?: GdeltArticle[] }>(
          `${GDELT_DOC_API}?${params.toString()}`
        )

        for (const article of data.articles || []) {
          if (!article.title?.trim()) continue

          const severity = this.classifySeverity(article.title, query.category)

          reports.push(
            this.createReport({
              title: article.title,
              content: `**Source Domain**: ${article.domain}\n**Country**: ${article.sourcecountry}\n**Language**: ${article.language}\n**Seen**: ${article.seendate}\n**GDELT Query**: "${query.q}"\n**Category**: ${query.category}`,
              severity,
              sourceUrl: article.url,
              sourceName: `GDELT (${query.category})`,
              verificationScore: 60
            })
          )
        }

        log.debug(`GDELT: "${query.q}" — ${data.articles?.length || 0} articles`)
      } catch (err) {
        log.warn(`GDELT query failed for "${query.q}": ${err}`)
      }
    }

    return reports
  }

  private getQueries(): Array<{ q: string; category: string; timespan?: string }> {
    const custom = this.sourceConfig?.config?.queries as Array<{ q: string; category: string; timespan?: string }> | undefined
    return custom && custom.length > 0 ? custom : [
      { q: 'terrorism attack', category: 'Terrorism', timespan: '24h' },
      { q: 'military conflict armed', category: 'Conflict', timespan: '24h' },
      { q: 'cyber attack breach hacking', category: 'Cyber', timespan: '24h' },
      { q: 'natural disaster earthquake flood hurricane', category: 'Disaster', timespan: '24h' },
      { q: 'sanctions embargo trade war', category: 'Sanctions', timespan: '24h' },
      { q: 'nuclear weapons proliferation', category: 'WMD', timespan: '48h' },
      { q: 'refugee crisis humanitarian', category: 'Humanitarian', timespan: '48h' },
      { q: 'election unrest protest coup', category: 'Political', timespan: '24h' }
    ]
  }

  private classifySeverity(title: string, category: string): ThreatLevel {
    const lower = title.toLowerCase()
    if (category === 'Terrorism' || category === 'WMD') {
      if (lower.includes('attack') || lower.includes('killed') || lower.includes('bomb')) return 'critical'
      return 'high'
    }
    if (category === 'Conflict') {
      if (lower.includes('war') || lower.includes('invasion')) return 'critical'
      return 'high'
    }
    if (category === 'Cyber') return 'high'
    if (category === 'Disaster') return 'medium'
    return 'medium'
  }
}
