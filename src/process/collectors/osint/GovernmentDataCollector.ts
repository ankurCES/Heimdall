import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Aggregates free government data APIs (no auth required)

interface GovSource {
  name: string
  fetchFn: (collector: GovernmentDataCollector) => Promise<IntelReport[]>
}

export class GovernmentDataCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'government-data'

  private sources: GovSource[] = [
    { name: 'World Bank Indicators', fetchFn: (c) => c.fetchWorldBank() },
    { name: 'WHO Disease Outbreaks', fetchFn: (c) => c.fetchWhoOutbreaks() },
    { name: 'US Federal Register', fetchFn: (c) => c.fetchFederalRegister() },
    { name: 'UK Gov Publications', fetchFn: (c) => c.fetchUkGov() },
    { name: 'Data.gov Datasets', fetchFn: (c) => c.fetchDataGov() },
    { name: 'EU Open Data', fetchFn: (c) => c.fetchEuOpenData() }
  ]

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    for (const source of this.sources) {
      try {
        const items = await source.fetchFn(this)
        reports.push(...items)
        log.debug(`GovData: ${source.name} — ${items.length} items`)
      } catch (err) {
        log.warn(`GovData ${source.name} failed: ${err}`)
      }
    }
    return reports
  }

  private async fetchWorldBank(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    // Key development indicators — latest values
    const indicators = [
      { code: 'SP.POP.TOTL', name: 'Population' },
      { code: 'NY.GDP.MKTP.CD', name: 'GDP (current US$)' },
      { code: 'SL.UEM.TOTL.ZS', name: 'Unemployment Rate' },
      { code: 'FP.CPI.TOTL.ZG', name: 'Inflation Rate' }
    ]

    for (const ind of indicators) {
      try {
        const data = await this.fetchJson<unknown[]>(
          `https://api.worldbank.org/v2/country/all/indicator/${ind.code}?format=json&date=2023&per_page=50&page=1`,
          { timeout: 15000 }
        )

        if (!Array.isArray(data) || data.length < 2) continue
        const records = data[1] as Array<{
          country: { value: string }
          value: number | null
          date: string
        }>

        const significantRecords = (records || [])
          .filter((r) => r.value !== null)
          .slice(0, 20)

        if (significantRecords.length === 0) continue

        const table = significantRecords
          .map((r) => `- **${r.country.value}**: ${r.value?.toLocaleString() ?? 'N/A'} (${r.date})`)
          .join('\n')

        reports.push(
          this.createReport({
            title: `World Bank: ${ind.name} — Global Overview`,
            content: `**Indicator**: ${ind.name} (${ind.code})\n**Period**: Latest available\n\n${table}`,
            severity: 'info',
            sourceUrl: `https://data.worldbank.org/indicator/${ind.code}`,
            sourceName: 'World Bank',
            verificationScore: 95
          })
        )
      } catch (err) {
        log.debug(`World Bank ${ind.code} failed: ${err}`)
      }
    }
    return reports
  }

  private async fetchWhoOutbreaks(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    try {
      // WHO Disease Outbreak News RSS
      const RssParser = (await import('rss-parser')).default
      const parser = new RssParser({ timeout: 15000 })
      const feed = await parser.parseURL('https://www.who.int/feeds/entity/don/en/rss.xml')

      for (const item of feed.items.slice(0, 15)) {
        if (!item.title) continue
        reports.push(
          this.createReport({
            title: `WHO: ${item.title}`,
            content: `**Published**: ${item.pubDate || 'Unknown'}\n\n${(item.contentSnippet || item.content || '').replace(/<[^>]*>/g, '').slice(0, 3000)}`,
            severity: item.title.toLowerCase().includes('outbreak') ? 'high' : 'medium',
            sourceUrl: item.link,
            sourceName: 'WHO Disease Outbreaks',
            verificationScore: 95
          })
        )
      }
    } catch (err) {
      log.debug(`WHO outbreaks failed: ${err}`)
    }
    return reports
  }

  private async fetchFederalRegister(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    try {
      const today = new Date().toISOString().split('T')[0]
      const data = await this.fetchJson<{
        count: number
        results: Array<{
          title: string
          abstract: string
          document_number: string
          type: string
          agencies: Array<{ name: string }>
          publication_date: string
          html_url: string
        }>
      }>(
        `https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest&conditions[term]=security+OR+terrorism+OR+sanctions+OR+emergency&conditions[type][]=RULE&conditions[type][]=NOTICE`,
        { timeout: 15000 }
      )

      for (const doc of data.results || []) {
        const agencies = doc.agencies?.map((a) => a.name).join(', ') || 'Unknown'
        reports.push(
          this.createReport({
            title: `Federal Register: ${doc.title.slice(0, 100)}`,
            content: `**Document**: ${doc.document_number}\n**Type**: ${doc.type}\n**Agencies**: ${agencies}\n**Published**: ${doc.publication_date}\n\n${doc.abstract?.slice(0, 2000) || 'No abstract'}`,
            severity: 'low',
            sourceUrl: doc.html_url,
            sourceName: 'US Federal Register',
            verificationScore: 98
          })
        )
      }
    } catch (err) {
      log.debug(`Federal Register failed: ${err}`)
    }
    return reports
  }

  private async fetchUkGov(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    try {
      // UK Gov news and communications related to security
      const data = await this.fetchJson<{
        results: Array<{
          title: string
          description: string
          link: string
          public_timestamp: string
          organisations: Array<{ title: string }>
        }>
      }>(
        'https://www.gov.uk/api/search.json?filter_content_purpose_supergroup=news_and_communications&filter_organisations=home-office|ministry-of-defence|foreign-commonwealth-development-office&count=15&order=-public_timestamp',
        { timeout: 15000 }
      )

      for (const item of data.results || []) {
        const orgs = item.organisations?.map((o) => o.title).join(', ') || ''
        reports.push(
          this.createReport({
            title: `UK Gov: ${item.title}`,
            content: `**Organisations**: ${orgs}\n**Published**: ${item.public_timestamp}\n\n${item.description || 'No description'}`,
            severity: 'info',
            sourceUrl: `https://www.gov.uk${item.link}`,
            sourceName: 'UK Government',
            verificationScore: 95
          })
        )
      }
    } catch (err) {
      log.debug(`UK Gov failed: ${err}`)
    }
    return reports
  }

  private async fetchDataGov(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    try {
      // Data.gov CKAN API — search for recently updated security/safety datasets
      const data = await this.fetchJson<{
        result: { results: Array<{ title: string; notes: string; url: string; metadata_modified: string; organization: { title: string } }> }
      }>(
        'https://catalog.data.gov/api/3/action/package_search?q=crime+OR+safety+OR+emergency+OR+security&sort=metadata_modified+desc&rows=15',
        { timeout: 15000 }
      )

      for (const ds of data.result?.results || []) {
        reports.push(
          this.createReport({
            title: `Data.gov: ${ds.title?.slice(0, 80)}`,
            content: `**Organization**: ${ds.organization?.title || 'Unknown'}\n**Updated**: ${ds.metadata_modified}\n\n${(ds.notes || '').replace(/<[^>]*>/g, '').slice(0, 1500)}`,
            severity: 'info',
            sourceUrl: ds.url || `https://catalog.data.gov/dataset/${ds.title?.toLowerCase().replace(/\s+/g, '-')}`,
            sourceName: 'Data.gov',
            verificationScore: 90
          })
        )
      }
    } catch (err) {
      log.debug(`Data.gov failed: ${err}`)
    }
    return reports
  }

  private async fetchEuOpenData(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    try {
      // EU Open Data Portal — security related datasets
      const data = await this.fetchJson<{
        result: { results: Array<{ title: string; notes: string; url: string; metadata_modified: string }> }
      }>(
        'https://data.europa.eu/api/hub/search/datasets?q=security+crime+emergency&sort=modification_date+desc&limit=10',
        { timeout: 15000 }
      )

      for (const ds of data.result?.results || []) {
        reports.push(
          this.createReport({
            title: `EU Data: ${(ds.title || '').slice(0, 80)}`,
            content: `**Updated**: ${ds.metadata_modified || 'Unknown'}\n\n${(ds.notes || '').slice(0, 1000)}`,
            severity: 'info',
            sourceUrl: ds.url || 'https://data.europa.eu',
            sourceName: 'EU Open Data',
            verificationScore: 90
          })
        )
      }
    } catch (err) {
      log.debug(`EU Open Data failed: ${err}`)
    }
    return reports
  }
}
