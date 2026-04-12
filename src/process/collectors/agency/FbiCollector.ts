import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// FBI Most Wanted API — free, no auth
// Docs: https://api.fbi.gov/docs
const FBI_API = 'https://api.fbi.gov/@wanted'

interface FbiWanted {
  uid: string
  title: string
  description: string
  subjects: string[]
  aliases: string[] | null
  nationality: string | null
  place_of_birth: string | null
  dates_of_birth_used: string[] | null
  reward_text: string | null
  caution: string | null
  url: string
  images: Array<{ original: string }> | null
  modified: string
  publication: string
}

export class FbiCollector extends BaseCollector {
  readonly discipline = 'agency' as const
  readonly type = 'fbi'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const data = await this.fetchJson<{
        total: number
        items: FbiWanted[]
      }>(`${FBI_API}?pageSize=20&page=1&sort_on=modified&sort_order=desc`)

      for (const item of data.items) {
        const aliases = item.aliases?.join(', ') || 'None'
        const subjects = item.subjects?.join(', ') || 'Unknown'
        const dob = item.dates_of_birth_used?.join(', ') || 'Unknown'
        const caution = item.caution?.replace(/<[^>]*>/g, '') || ''

        reports.push(
          this.createReport({
            title: `FBI Most Wanted: ${item.title}`,
            content: `**Subject**: ${item.title}\n**Categories**: ${subjects}\n**Aliases**: ${aliases}\n**Nationality**: ${item.nationality || 'Unknown'}\n**DOB**: ${dob}\n**Place of Birth**: ${item.place_of_birth || 'Unknown'}\n**Reward**: ${item.reward_text || 'None listed'}\n**Published**: ${item.publication}\n**Modified**: ${item.modified}\n\n${item.description || ''}\n\n${caution ? `**CAUTION**: ${caution.slice(0, 1000)}` : ''}`,
            severity: 'high',
            sourceUrl: item.url,
            sourceName: 'FBI Most Wanted',
            verificationScore: 98
          })
        )
      }

      log.debug(`FBI: ${data.items.length} most wanted`)
    } catch (err) {
      log.error('FbiCollector failed:', err)
    }

    return reports
  }
}
