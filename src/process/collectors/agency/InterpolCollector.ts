import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Interpol Notices API — free, no auth
// Docs: https://interpol.api.bund.dev/ (unofficial docs of public API)
const INTERPOL_API = 'https://ws-public.interpol.int/notices/v1'

interface InterpolNotice {
  entity_id: string
  name: string
  forename: string
  date_of_birth: string
  nationalities: string[]
  _links: { self: { href: string }; thumbnail?: { href: string } }
}

type NoticeType = 'red' | 'yellow' | 'un'

export class InterpolCollector extends BaseCollector {
  readonly discipline = 'agency' as const
  readonly type = 'interpol'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const noticeTypes: NoticeType[] = ['red', 'yellow', 'un']

    for (const type of noticeTypes) {
      try {
        const data = await this.fetchJson<{
          total: number
          _embedded: { notices: InterpolNotice[] }
        }>(`${INTERPOL_API}/${type}?resultPerPage=20&page=1`)

        const notices = data._embedded?.notices || []

        for (const notice of notices) {
          const fullName = `${notice.forename || ''} ${notice.name || ''}`.trim()
          const severity = this.noticeSeverity(type)
          const nationalities = notice.nationalities?.join(', ') || 'Unknown'

          reports.push(
            this.createReport({
              title: `Interpol ${type.toUpperCase()} Notice: ${fullName}`,
              content: `**Name**: ${fullName}\n**DOB**: ${notice.date_of_birth || 'Unknown'}\n**Nationalities**: ${nationalities}\n**Notice Type**: ${type.toUpperCase()}\n**Entity ID**: ${notice.entity_id}`,
              severity,
              sourceUrl: notice._links?.self?.href,
              sourceName: `Interpol ${type.toUpperCase()} Notices`,
              verificationScore: 95
            })
          )
        }

        log.debug(`Interpol: ${type} — ${notices.length} notices`)
      } catch (err) {
        log.warn(`Interpol ${type} notices failed: ${err}`)
      }
    }

    return reports
  }

  private noticeSeverity(type: NoticeType): ThreatLevel {
    switch (type) {
      case 'red': return 'critical'
      case 'yellow': return 'high'
      case 'un': return 'high'
      default: return 'medium'
    }
  }
}
