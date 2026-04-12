import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// RDAP (Registration Data Access Protocol) — free, no auth
// Replaces traditional WHOIS with RESTful JSON API
const RDAP_SERVERS: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1',
  net: 'https://rdap.verisign.com/net/v1',
  org: 'https://rdap.org/org/v1',
  default: 'https://rdap.org/domain'
}

interface RdapDomain {
  handle: string
  ldhName: string
  status: string[]
  events: Array<{ eventAction: string; eventDate: string }>
  entities: Array<{
    roles: string[]
    vcardArray?: [string, Array<[string, Record<string, unknown>, string, string]>]
  }>
  nameservers?: Array<{ ldhName: string }>
}

export class DnsWhoisCollector extends BaseCollector {
  readonly discipline = 'cybint' as const
  readonly type = 'dns-whois'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const domains = this.getDomains()

    for (const domain of domains) {
      try {
        const report = await this.lookupDomain(domain)
        if (report) reports.push(report)
      } catch (err) {
        log.warn(`RDAP lookup failed for ${domain}: ${err}`)
      }
    }

    return reports
  }

  private async lookupDomain(domain: string): Promise<IntelReport | null> {
    const tld = domain.split('.').pop() || 'default'
    const server = RDAP_SERVERS[tld] || RDAP_SERVERS.default

    try {
      const data = await this.fetchJson<RdapDomain>(
        `${server}/domain/${domain}`,
        { timeout: 10000 }
      )

      const registrationDate = data.events?.find((e) => e.eventAction === 'registration')?.eventDate
      const expirationDate = data.events?.find((e) => e.eventAction === 'expiration')?.eventDate
      const lastChanged = data.events?.find((e) => e.eventAction === 'last changed')?.eventDate

      const nameservers = data.nameservers?.map((ns) => ns.ldhName).join(', ') || 'Unknown'
      const status = data.status?.join(', ') || 'Unknown'

      // Extract registrant info from vcard
      let registrant = 'Redacted/Private'
      for (const entity of data.entities || []) {
        if (entity.roles?.includes('registrant') && entity.vcardArray) {
          const fnEntry = entity.vcardArray[1]?.find((v) => v[0] === 'fn')
          if (fnEntry) registrant = fnEntry[3] as string
        }
      }

      // Flag recently registered domains (< 30 days) as potentially suspicious
      const isNew = registrationDate &&
        (Date.now() - new Date(registrationDate).getTime()) < 30 * 24 * 60 * 60 * 1000

      return this.createReport({
        title: `Domain RDAP: ${domain}`,
        content: `**Domain**: ${data.ldhName}\n**Status**: ${status}\n**Registrant**: ${registrant}\n**Registered**: ${registrationDate || 'Unknown'}\n**Expires**: ${expirationDate || 'Unknown'}\n**Last Changed**: ${lastChanged || 'Unknown'}\n**Nameservers**: ${nameservers}${isNew ? '\n\n**NOTE**: Recently registered domain (< 30 days)' : ''}`,
        severity: isNew ? 'medium' : 'info',
        sourceUrl: `https://rdap.org/domain/${domain}`,
        sourceName: 'RDAP',
        verificationScore: 90
      })
    } catch (err) {
      log.debug(`RDAP lookup failed for ${domain}: ${err}`)
      return null
    }
  }

  private getDomains(): string[] {
    const custom = this.sourceConfig?.config?.domains as string[] | undefined
    return custom && custom.length > 0 ? custom : []
  }
}
