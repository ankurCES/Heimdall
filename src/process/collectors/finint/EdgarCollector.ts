import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// SEC EDGAR Full-Text Search API — free, no auth
// Docs: https://efts.sec.gov/LATEST/search-index?q=...
const EDGAR_API = 'https://efts.sec.gov/LATEST/search-index'
const EDGAR_FILINGS = 'https://efts.sec.gov/LATEST/search-index'

interface EdgarResult {
  file_date: string
  file_type: string
  display_names: string[]
  entity_name: string
  file_description: string
  file_url: string
  period_of_report: string
}

export class EdgarCollector extends BaseCollector {
  readonly discipline = 'finint' as const
  readonly type = 'edgar'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const searchTerms = this.getSearchTerms()

    for (const term of searchTerms) {
      try {
        const params = new URLSearchParams({
          q: `"${term}"`,
          dateRange: 'custom',
          startdt: this.getYesterdayDate(),
          enddt: this.getTodayDate(),
          forms: '8-K,10-K,10-Q,SC 13D',
          from: '0',
          size: '20'
        })

        const data = await this.fetchJson<{ hits: { hits: Array<{ _source: EdgarResult }> } }>(
          `https://efts.sec.gov/LATEST/search-index?${params.toString()}`,
          {
            headers: {
              'User-Agent': 'Heimdall/0.1.0 (Public Safety Monitor; ankurCES)',
              Accept: 'application/json'
            }
          }
        )

        const hits = data.hits?.hits || []
        for (const hit of hits) {
          const src = hit._source
          reports.push(
            this.createReport({
              title: `SEC Filing: ${src.entity_name} — ${src.file_type}`,
              content: `**Entity**: ${src.entity_name}\n**Filing Type**: ${src.file_type}\n**Filed**: ${src.file_date}\n**Period**: ${src.period_of_report || 'N/A'}\n**Description**: ${src.file_description || 'N/A'}\n\nSearch term match: "${term}"`,
              severity: 'low',
              sourceUrl: src.file_url ? `https://www.sec.gov${src.file_url}` : undefined,
              sourceName: 'SEC EDGAR',
              verificationScore: 95
            })
          )
        }

        log.debug(`EDGAR: "${term}" — ${hits.length} filings`)
      } catch (err) {
        log.warn(`EDGAR search failed for "${term}": ${err}`)
      }
    }

    return reports
  }

  private getSearchTerms(): string[] {
    const custom = this.sourceConfig?.config?.searchTerms as string[] | undefined
    return custom && custom.length > 0
      ? custom
      : ['sanctions', 'money laundering', 'fraud', 'investigation']
  }

  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0]
  }

  private getYesterdayDate(): string {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().split('T')[0]
  }
}
