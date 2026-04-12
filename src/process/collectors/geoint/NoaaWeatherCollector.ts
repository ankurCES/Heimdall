import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// NWS API — free, no auth
// Docs: https://www.weather.gov/documentation/services-web-api
const NWS_API = 'https://api.weather.gov'

interface NwsAlert {
  id: string
  properties: {
    event: string
    headline: string
    description: string
    severity: string // Minor, Moderate, Severe, Extreme
    certainty: string
    urgency: string
    effective: string
    expires: string
    senderName: string
    areaDesc: string
    geocode?: { UGC?: string[]; SAME?: string[] }
  }
}

export class NoaaWeatherCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'noaa-weather'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const params = new URLSearchParams({
        status: 'actual',
        message_type: 'alert',
        limit: '50'
      })

      // Filter by severity if configured
      const minSeverity = this.sourceConfig?.config?.minSeverity as string
      if (minSeverity) {
        params.set('severity', minSeverity)
      }

      const data = await this.fetchJson<{ features: NwsAlert[] }>(
        `${NWS_API}/alerts/active?${params.toString()}`,
        { headers: { Accept: 'application/geo+json' } }
      )

      for (const alert of data.features) {
        const p = alert.properties
        const severity = this.nwsSeverityToLevel(p.severity)

        reports.push(
          this.createReport({
            title: `Weather Alert: ${p.event} — ${p.areaDesc.slice(0, 60)}`,
            content: `**Event**: ${p.event}\n**Headline**: ${p.headline}\n**Severity**: ${p.severity}\n**Certainty**: ${p.certainty}\n**Urgency**: ${p.urgency}\n**Area**: ${p.areaDesc}\n**Effective**: ${p.effective}\n**Expires**: ${p.expires}\n**Sender**: ${p.senderName}\n\n${p.description?.slice(0, 3000) || 'No description'}`,
            severity,
            sourceUrl: `https://alerts.weather.gov`,
            sourceName: 'NOAA/NWS',
            verificationScore: 98
          })
        )
      }

      log.debug(`NOAA Weather: ${data.features.length} active alerts`)
    } catch (err) {
      log.error('NoaaWeatherCollector failed:', err)
    }

    return reports
  }

  private nwsSeverityToLevel(nwsSeverity: string): ThreatLevel {
    switch (nwsSeverity) {
      case 'Extreme': return 'critical'
      case 'Severe': return 'high'
      case 'Moderate': return 'medium'
      case 'Minor': return 'low'
      default: return 'info'
    }
  }
}
