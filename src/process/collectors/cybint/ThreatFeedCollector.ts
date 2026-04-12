import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

// AlienVault OTX API — requires free API key
// Docs: https://otx.alienvault.com/api
const OTX_API = 'https://otx.alienvault.com/api/v1'

// abuse.ch URLhaus — free, no auth required
// Docs: https://urlhaus-api.abuse.ch/
const URLHAUS_API = 'https://urlhaus-api.abuse.ch/v1'

interface OtxPulse {
  id: string
  name: string
  description: string
  created: string
  modified: string
  tags: string[]
  tlp: string
  adversary: string
  targeted_countries: string[]
  indicators: Array<{ type: string; indicator: string }>
  references: string[]
}

interface UrlhausEntry {
  id: string
  url: string
  url_status: string
  threat: string
  host: string
  date_added: string
  tags: string[] | null
}

export class ThreatFeedCollector extends BaseCollector {
  readonly discipline = 'cybint' as const
  readonly type = 'threat-feed'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // AlienVault OTX (requires API key)
    const otxKey = settingsService.get<string>('apikeys.otx')
    if (otxKey) {
      const otxReports = await this.collectOtx(otxKey)
      reports.push(...otxReports)
    }

    // abuse.ch URLhaus (free)
    const urlhausReports = await this.collectUrlhaus()
    reports.push(...urlhausReports)

    return reports
  }

  private async collectOtx(apiKey: string): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const data = await this.fetchJson<{ results: OtxPulse[] }>(
        `${OTX_API}/pulses/subscribed?limit=20&modified_since=1d`,
        { headers: { 'X-OTX-API-KEY': apiKey } }
      )

      for (const pulse of data.results) {
        const indicators = pulse.indicators
          .slice(0, 10)
          .map((i) => `- **${i.type}**: \`${i.indicator}\``)
          .join('\n')

        const severity = this.classifyOtxSeverity(pulse)

        reports.push(
          this.createReport({
            title: pulse.name,
            content: `**Adversary**: ${pulse.adversary || 'Unknown'}\n**TLP**: ${pulse.tlp}\n**Tags**: ${pulse.tags.join(', ') || 'None'}\n**Targeted Countries**: ${pulse.targeted_countries.join(', ') || 'Global'}\n**Created**: ${pulse.created}\n\n${pulse.description || 'No description'}\n\n**Indicators** (${pulse.indicators.length} total):\n${indicators}`,
            severity,
            sourceUrl: `https://otx.alienvault.com/pulse/${pulse.id}`,
            sourceName: 'AlienVault OTX',
            verificationScore: 70
          })
        )
      }

      log.debug(`OTX: ${data.results.length} pulses`)
    } catch (err) {
      log.warn(`OTX collection failed: ${err}`)
    }

    return reports
  }

  private async collectUrlhaus(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const response = await this.safeFetch(`${URLHAUS_API}/urls/recent/`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      })
      const data = await response.json() as { urls: UrlhausEntry[] }

      // Take latest 30 entries
      const entries = (data.urls || []).slice(0, 30)

      for (const entry of entries) {
        const severity: ThreatLevel = entry.url_status === 'online' ? 'high' : 'medium'
        const tags = Array.isArray(entry.tags) ? entry.tags.join(', ') : 'None'

        reports.push(
          this.createReport({
            title: `Malicious URL: ${entry.host}`,
            content: `**URL**: \`${entry.url}\`\n**Status**: ${entry.url_status}\n**Threat**: ${entry.threat}\n**Host**: ${entry.host}\n**Tags**: ${tags}\n**Added**: ${entry.date_added}`,
            severity,
            sourceUrl: `https://urlhaus.abuse.ch/url/${entry.id}/`,
            sourceName: 'abuse.ch URLhaus',
            verificationScore: 80
          })
        )
      }

      log.debug(`URLhaus: ${entries.length} entries`)
    } catch (err) {
      log.warn(`URLhaus collection failed: ${err}`)
    }

    return reports
  }

  private classifyOtxSeverity(pulse: OtxPulse): ThreatLevel {
    const text = (pulse.name + ' ' + pulse.description + ' ' + pulse.tags.join(' ')).toLowerCase()
    if (text.includes('critical') || text.includes('zero-day') || text.includes('apt')) return 'critical'
    if (text.includes('ransomware') || text.includes('exploit') || text.includes('malware')) return 'high'
    if (text.includes('phishing') || text.includes('trojan') || text.includes('c2')) return 'medium'
    return 'low'
  }
}
