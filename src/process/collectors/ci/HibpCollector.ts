import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

// HaveIBeenPwned API v3 — requires API key ($3.50/month)
// Docs: https://haveibeenpwned.com/API/v3
const HIBP_API = 'https://haveibeenpwned.com/api/v3'

interface HibpBreach {
  Name: string
  Title: string
  Domain: string
  BreachDate: string
  AddedDate: string
  ModifiedDate: string
  PwnCount: number
  Description: string
  DataClasses: string[]
  IsVerified: boolean
  IsSensitive: boolean
}

export class HibpCollector extends BaseCollector {
  readonly discipline = 'ci' as const
  readonly type = 'hibp'

  async collect(): Promise<IntelReport[]> {
    const apiKey = settingsService.get<string>('apikeys.hibp')
    if (!apiKey) {
      log.warn('HibpCollector: no API key configured')
      return []
    }

    const reports: IntelReport[] = []

    // Get latest breaches
    try {
      const breaches = await this.fetchJson<HibpBreach[]>(
        `${HIBP_API}/breaches`,
        { headers: { 'hibp-api-key': apiKey } }
      )

      // Filter to recent breaches (added in last 7 days)
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const recent = breaches.filter((b) => new Date(b.AddedDate) >= weekAgo)

      for (const breach of recent) {
        const severity = this.classifySeverity(breach)
        const dataClasses = breach.DataClasses.join(', ')

        reports.push(
          this.createReport({
            title: `Data Breach: ${breach.Title}`,
            content: `**Name**: ${breach.Name}\n**Domain**: ${breach.Domain}\n**Breach Date**: ${breach.BreachDate}\n**Added**: ${breach.AddedDate}\n**Accounts Affected**: ${breach.PwnCount.toLocaleString()}\n**Verified**: ${breach.IsVerified}\n**Data Exposed**: ${dataClasses}\n\n${breach.Description?.replace(/<[^>]*>/g, '') || 'No description'}`,
            severity,
            sourceUrl: `https://haveibeenpwned.com/PwnedWebsites#${breach.Name}`,
            sourceName: 'HaveIBeenPwned',
            verificationScore: breach.IsVerified ? 90 : 60
          })
        )
      }

      log.debug(`HIBP: ${recent.length} recent breaches of ${breaches.length} total`)
    } catch (err) {
      log.error('HibpCollector failed:', err)
    }

    // Check monitored domains if configured
    const domains = this.sourceConfig?.config?.domains as string[] | undefined
    if (domains && domains.length > 0 && apiKey) {
      for (const domain of domains) {
        try {
          const breaches = await this.fetchJson<HibpBreach[]>(
            `${HIBP_API}/breaches?domain=${domain}`,
            { headers: { 'hibp-api-key': apiKey } }
          )

          for (const breach of breaches) {
            reports.push(
              this.createReport({
                title: `Domain Breach Alert: ${domain} — ${breach.Title}`,
                content: `**Monitored Domain**: ${domain}\n**Breach**: ${breach.Title}\n**Date**: ${breach.BreachDate}\n**Accounts**: ${breach.PwnCount.toLocaleString()}\n**Data**: ${breach.DataClasses.join(', ')}`,
                severity: 'high',
                sourceUrl: `https://haveibeenpwned.com/PwnedWebsites#${breach.Name}`,
                sourceName: 'HIBP Domain Monitor',
                verificationScore: 90
              })
            )
          }
        } catch (err) {
          log.warn(`HIBP domain check failed for ${domain}: ${err}`)
        }

        // HIBP rate limit: 1 request per 1500ms
        await new Promise((r) => setTimeout(r, 1600))
      }
    }

    return reports
  }

  private classifySeverity(breach: HibpBreach): ThreatLevel {
    if (breach.PwnCount > 10_000_000) return 'critical'
    if (breach.PwnCount > 1_000_000) return 'high'
    if (breach.DataClasses.some((dc) => ['Passwords', 'Credit cards', 'Bank account numbers'].includes(dc))) return 'high'
    if (breach.PwnCount > 100_000) return 'medium'
    return 'low'
  }
}
