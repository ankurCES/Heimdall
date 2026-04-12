import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// FCC ULS (Universal Licensing System) — free, no auth
// Docs: https://www.fcc.gov/developers/uls-license-data
const FCC_API = 'https://data.fcc.gov/api/license-view/basicSearch/getLicenses'

interface FccLicense {
  licName: string
  frn: string
  callSign: string
  categoryDesc: string
  serviceDesc: string
  statusDesc: string
  expiredDate: string
  licenseID: string
}

export class FccCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'fcc'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const searchTerms = this.getSearchTerms()

    for (const term of searchTerms) {
      try {
        const params = new URLSearchParams({
          searchValue: term,
          format: 'json',
          limit: '20'
        })

        const data = await this.fetchJson<{
          Licenses: { License: FccLicense[] }
        }>(`${FCC_API}?${params.toString()}`)

        const licenses = data.Licenses?.License || []

        for (const lic of licenses) {
          reports.push(
            this.createReport({
              title: `FCC License: ${lic.callSign || lic.licName}`,
              content: `**Licensee**: ${lic.licName}\n**Call Sign**: ${lic.callSign || 'N/A'}\n**FRN**: ${lic.frn}\n**Category**: ${lic.categoryDesc}\n**Service**: ${lic.serviceDesc}\n**Status**: ${lic.statusDesc}\n**Expires**: ${lic.expiredDate || 'N/A'}`,
              severity: 'info',
              sourceUrl: `https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${lic.licenseID}`,
              sourceName: 'FCC ULS',
              verificationScore: 95
            })
          )
        }

        log.debug(`FCC: "${term}" — ${licenses.length} licenses`)
      } catch (err) {
        log.warn(`FCC search failed for "${term}": ${err}`)
      }
    }

    return reports
  }

  private getSearchTerms(): string[] {
    const custom = this.sourceConfig?.config?.searchTerms as string[] | undefined
    return custom && custom.length > 0 ? custom : []
  }
}
