import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// CIA World Factbook via factbook.json — free, no auth, public domain
// https://github.com/factbook/factbook.json
const FACTBOOK_BASE = 'https://raw.githubusercontent.com/factbook/factbook.json/master'

// All countries by region with GEC codes (FIPS, NOT ISO)
const COUNTRIES: Record<string, Array<{ code: string; name: string }>> = {
  'africa': [
    { code: 'ag', name: 'Algeria' }, { code: 'ao', name: 'Angola' }, { code: 'bn', name: 'Benin' },
    { code: 'bc', name: 'Botswana' }, { code: 'uv', name: 'Burkina Faso' }, { code: 'by', name: 'Burundi' },
    { code: 'cm', name: 'Cameroon' }, { code: 'cd', name: 'Chad' }, { code: 'cg', name: 'Congo DR' },
    { code: 'cf', name: 'Congo Republic' }, { code: 'ct', name: 'Central African Republic' },
    { code: 'iv', name: 'Cote d\'Ivoire' }, { code: 'dj', name: 'Djibouti' }, { code: 'eg', name: 'Egypt' },
    { code: 'et', name: 'Ethiopia' }, { code: 'ga', name: 'Gabon' }, { code: 'gh', name: 'Ghana' },
    { code: 'ke', name: 'Kenya' }, { code: 'li', name: 'Liberia' }, { code: 'ly', name: 'Libya' },
    { code: 'ma', name: 'Madagascar' }, { code: 'ml', name: 'Mali' }, { code: 'mo', name: 'Morocco' },
    { code: 'mz', name: 'Mozambique' }, { code: 'ng', name: 'Niger' }, { code: 'ni', name: 'Nigeria' },
    { code: 'rw', name: 'Rwanda' }, { code: 'sn', name: 'Senegal' }, { code: 'so', name: 'Somalia' },
    { code: 'sf', name: 'South Africa' }, { code: 'od', name: 'South Sudan' }, { code: 'su', name: 'Sudan' },
    { code: 'tz', name: 'Tanzania' }, { code: 'to', name: 'Togo' }, { code: 'ts', name: 'Tunisia' },
    { code: 'ug', name: 'Uganda' }, { code: 'za', name: 'Zambia' }, { code: 'zi', name: 'Zimbabwe' }
  ],
  'europe': [
    { code: 'al', name: 'Albania' }, { code: 'au', name: 'Austria' }, { code: 'be', name: 'Belgium' },
    { code: 'bk', name: 'Bosnia' }, { code: 'bu', name: 'Bulgaria' }, { code: 'hr', name: 'Croatia' },
    { code: 'cy', name: 'Cyprus' }, { code: 'ez', name: 'Czech Republic' }, { code: 'da', name: 'Denmark' },
    { code: 'en', name: 'Estonia' }, { code: 'fi', name: 'Finland' }, { code: 'fr', name: 'France' },
    { code: 'gm', name: 'Germany' }, { code: 'gr', name: 'Greece' }, { code: 'hu', name: 'Hungary' },
    { code: 'ic', name: 'Iceland' }, { code: 'ei', name: 'Ireland' }, { code: 'it', name: 'Italy' },
    { code: 'lg', name: 'Latvia' }, { code: 'lh', name: 'Lithuania' }, { code: 'lu', name: 'Luxembourg' },
    { code: 'mk', name: 'North Macedonia' }, { code: 'mt', name: 'Malta' }, { code: 'md', name: 'Moldova' },
    { code: 'mn', name: 'Monaco' }, { code: 'mj', name: 'Montenegro' }, { code: 'nl', name: 'Netherlands' },
    { code: 'no', name: 'Norway' }, { code: 'pl', name: 'Poland' }, { code: 'po', name: 'Portugal' },
    { code: 'ro', name: 'Romania' }, { code: 'rs', name: 'Russia' }, { code: 'ri', name: 'Serbia' },
    { code: 'lo', name: 'Slovakia' }, { code: 'si', name: 'Slovenia' }, { code: 'sp', name: 'Spain' },
    { code: 'sw', name: 'Sweden' }, { code: 'sz', name: 'Switzerland' }, { code: 'tu', name: 'Turkey' },
    { code: 'up', name: 'Ukraine' }, { code: 'uk', name: 'United Kingdom' }
  ],
  'middle-east': [
    { code: 'ba', name: 'Bahrain' }, { code: 'ir', name: 'Iran' }, { code: 'iz', name: 'Iraq' },
    { code: 'is', name: 'Israel' }, { code: 'jo', name: 'Jordan' }, { code: 'ku', name: 'Kuwait' },
    { code: 'le', name: 'Lebanon' }, { code: 'mu', name: 'Oman' }, { code: 'qa', name: 'Qatar' },
    { code: 'sa', name: 'Saudi Arabia' }, { code: 'sy', name: 'Syria' }, { code: 'ae', name: 'UAE' },
    { code: 'ym', name: 'Yemen' }
  ],
  'south-asia': [
    { code: 'af', name: 'Afghanistan' }, { code: 'bg', name: 'Bangladesh' }, { code: 'bt', name: 'Bhutan' },
    { code: 'in', name: 'India' }, { code: 'mv', name: 'Maldives' }, { code: 'np', name: 'Nepal' },
    { code: 'pk', name: 'Pakistan' }, { code: 'ce', name: 'Sri Lanka' }
  ],
  'east-n-southeast-asia': [
    { code: 'ch', name: 'China' }, { code: 'ja', name: 'Japan' }, { code: 'ks', name: 'South Korea' },
    { code: 'kn', name: 'North Korea' }, { code: 'bm', name: 'Burma/Myanmar' }, { code: 'cb', name: 'Cambodia' },
    { code: 'id', name: 'Indonesia' }, { code: 'la', name: 'Laos' }, { code: 'my', name: 'Malaysia' },
    { code: 'rp', name: 'Philippines' }, { code: 'sn', name: 'Singapore' }, { code: 'th', name: 'Thailand' },
    { code: 'vm', name: 'Vietnam' }, { code: 'tw', name: 'Taiwan' }, { code: 'mg', name: 'Mongolia' }
  ],
  'central-asia': [
    { code: 'kz', name: 'Kazakhstan' }, { code: 'kg', name: 'Kyrgyzstan' },
    { code: 'ti', name: 'Tajikistan' }, { code: 'tx', name: 'Turkmenistan' }, { code: 'uz', name: 'Uzbekistan' }
  ],
  'north-america': [
    { code: 'us', name: 'United States' }, { code: 'ca', name: 'Canada' }, { code: 'mx', name: 'Mexico' }
  ],
  'south-america': [
    { code: 'ar', name: 'Argentina' }, { code: 'bl', name: 'Bolivia' }, { code: 'br', name: 'Brazil' },
    { code: 'ci', name: 'Chile' }, { code: 'co', name: 'Colombia' }, { code: 'ec', name: 'Ecuador' },
    { code: 'gy', name: 'Guyana' }, { code: 'pa', name: 'Paraguay' }, { code: 'pe', name: 'Peru' },
    { code: 'uy', name: 'Uruguay' }, { code: 've', name: 'Venezuela' }
  ]
}

export class FactbookCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'factbook'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const regions = this.getRegions()

    for (const region of regions) {
      const countries = COUNTRIES[region]
      if (!countries) continue

      for (const country of countries) {
        try {
          const url = `${FACTBOOK_BASE}/${region}/${country.code}.json`
          const data = await this.fetchJson<Record<string, unknown>>(url, { timeout: 15000 })

          const report = this.parseCountryProfile(country.name, region, data, url)
          if (report) reports.push(report)
        } catch (err) {
          log.debug(`Factbook: failed to fetch ${country.name}: ${err}`)
        }
      }
    }

    log.info(`Factbook: collected ${reports.length} country profiles`)
    return reports
  }

  private parseCountryProfile(
    name: string, region: string, data: Record<string, unknown>, url: string
  ): IntelReport | null {
    const sections: string[] = []

    const intro = this.extractNestedText(data, 'Introduction', 'Background')
    if (intro) sections.push(`## Background\n\n${intro}`)

    const govType = this.extractNestedText(data, 'Government', 'Government type')
    const capital = this.extractNestedText(data, 'Government', 'Capital')
    const chiefOfState = this.extractNestedText(data, 'Government', 'Executive branch')
    if (govType || capital) {
      sections.push(`## Government\n\n**Type**: ${govType || 'N/A'}\n**Capital**: ${capital || 'N/A'}\n${chiefOfState ? `**Executive**: ${chiefOfState}` : ''}`)
    }

    const gdp = this.extractNestedText(data, 'Economy', 'GDP (purchasing power parity)')
    const gdpGrowth = this.extractNestedText(data, 'Economy', 'Real GDP growth rate')
    const inflation = this.extractNestedText(data, 'Economy', 'Inflation rate (consumer prices)')
    if (gdp) {
      sections.push(`## Economy\n\n**GDP (PPP)**: ${gdp}\n**Growth**: ${gdpGrowth || 'N/A'}\n**Inflation**: ${inflation || 'N/A'}`)
    }

    const military = this.extractNestedText(data, 'Military and Security', 'Military and security forces')
    const milSpending = this.extractNestedText(data, 'Military and Security', 'Military expenditures')
    if (military) {
      sections.push(`## Military & Security\n\n**Forces**: ${military}\n**Spending**: ${milSpending || 'N/A'}`)
    }

    const terrorism = this.extractNestedText(data, 'Terrorism', 'Terrorist group(s)')
    if (terrorism) {
      sections.push(`## Terrorism\n\n**Groups**: ${terrorism}`)
    }

    const transnational = this.extractNestedText(data, 'Transnational Issues', 'Disputes - international')
    const refugees = this.extractNestedText(data, 'Transnational Issues', 'Refugees and internally displaced persons')
    const drugs = this.extractNestedText(data, 'Transnational Issues', 'Illicit drugs')
    if (transnational || refugees || drugs) {
      sections.push(`## Transnational Issues\n\n${transnational ? `**Disputes**: ${transnational}\n` : ''}${refugees ? `**Refugees/IDPs**: ${refugees}\n` : ''}${drugs ? `**Illicit Drugs**: ${drugs}` : ''}`)
    }

    if (sections.length === 0) return null

    const hasThreat = !!(terrorism || drugs || transnational)

    return this.createReport({
      title: `Country Profile: ${name}`,
      content: `**Country**: ${name}\n**Region**: ${region}\n\n${sections.join('\n\n---\n\n')}`,
      severity: hasThreat ? 'low' : 'info',
      sourceUrl: `https://github.com/factbook/factbook.json/blob/master/${region}/${name.toLowerCase().replace(/\s+/g, '-')}.json`,
      sourceName: 'CIA World Factbook',
      verificationScore: 90
    })
  }

  private extractNestedText(data: Record<string, unknown>, ...keys: string[]): string {
    let current: unknown = data
    for (const key of keys) {
      if (!current || typeof current !== 'object') return ''
      current = (current as Record<string, unknown>)[key]
    }
    if (!current || typeof current !== 'object') return typeof current === 'string' ? current : ''
    const obj = current as Record<string, unknown>
    if (obj.text) return String(obj.text)
    const first = Object.values(obj)[0]
    if (first && typeof first === 'object' && (first as Record<string, unknown>).text) {
      return String((first as Record<string, unknown>).text)
    }
    return ''
  }

  private getRegions(): string[] {
    const custom = this.sourceConfig?.config?.regions as string[] | undefined
    return custom && custom.length > 0 ? custom : Object.keys(COUNTRIES)
  }
}
