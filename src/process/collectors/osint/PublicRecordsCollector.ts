import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// CourtListener API — free, no auth required
// Docs: https://www.courtlistener.com/api/rest-info/
const COURTLISTENER_API = 'https://www.courtlistener.com/api/rest/v4'

interface CourtListenerOpinion {
  id: number
  absolute_url: string
  case_name: string
  date_filed: string
  court: string
  snippet: string
  citation_count: number
}

export class PublicRecordsCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'public-records'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const searchTerms = this.getSearchTerms()

      for (const term of searchTerms) {
        try {
          const data = await this.fetchJson<{
            count: number
            results: CourtListenerOpinion[]
          }>(`${COURTLISTENER_API}/search/?q=${encodeURIComponent(term)}&type=o&order_by=dateFiled+desc&page_size=10`)

          for (const result of data.results) {
            reports.push(
              this.createReport({
                title: result.case_name || `Court Opinion #${result.id}`,
                content: `**Court**: ${result.court}\n**Filed**: ${result.date_filed}\n**Citations**: ${result.citation_count}\n\n${result.snippet || 'No snippet available'}`,
                severity: 'info',
                sourceUrl: `https://www.courtlistener.com${result.absolute_url}`,
                sourceName: 'CourtListener',
                verificationScore: 90 // Official court records
              })
            )
          }

          log.debug(`CourtListener: "${term}" — ${data.results.length} results`)
        } catch (err) {
          log.warn(`CourtListener search failed for "${term}": ${err}`)
        }
      }
    } catch (err) {
      log.error('PublicRecordsCollector failed:', err)
    }

    return reports
  }

  private getSearchTerms(): string[] {
    const custom = this.sourceConfig?.config?.searchTerms as string[] | undefined
    return custom && custom.length > 0
      ? custom
      : ['terrorism', 'national security', 'cybercrime', 'sanctions violation']
  }
}
