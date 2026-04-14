import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Internet Outage Detection via public outage tracking APIs
// Uses IODA (Internet Outage Detection and Analysis) from Georgia Tech / CAIDA
// Free, no auth required

// IODA v2 API deprecated — use Cloudflare Radar as primary
const IODA_API = 'https://api.ioda.inetintel.cc.gatech.edu/v2'

// Country centroids for geo-tagging
const COUNTRY_COORDS: Record<string, [number, number]> = {
  US: [39.83, -98.58], RU: [61.52, 105.32], CN: [35.86, 104.20],
  IR: [32.43, 53.69], UA: [48.38, 31.17], SY: [34.80, 38.99],
  IQ: [33.22, 43.68], AF: [33.94, 67.71], EG: [26.82, 30.80],
  TR: [38.96, 35.24], IN: [20.59, 78.96], PK: [30.38, 69.35],
  BD: [23.68, 90.36], MM: [21.91, 95.96], ET: [9.15, 40.49],
  SD: [12.86, 30.22], VE: [6.42, -66.59], CU: [21.52, -77.78],
  KP: [40.34, 127.51], BY: [53.71, 27.95], NG: [9.08, 8.68],
  KE: [-0.02, 37.91], ZA: [-30.56, 22.94], BR: [-14.24, -51.93],
  DE: [51.17, 10.45], FR: [46.23, 2.21], GB: [55.38, -3.44],
  JP: [36.20, 138.25], KR: [35.91, 127.77], AU: [-25.27, 133.78],
  ID: [-0.79, 113.92], TH: [15.87, 100.99], PH: [12.88, 121.77],
  SA: [23.89, 45.08], IL: [31.05, 34.85], LB: [33.85, 35.86],
  YE: [15.55, 48.52], LY: [26.34, 17.23], TZ: [-6.37, 34.89]
}

export class InternetOutageCollector extends BaseCollector {
  readonly discipline = 'cybint' as const
  readonly type = 'internet-outage'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      // IODA outage alerts — recent events
      const now = Math.floor(Date.now() / 1000)
      const since = now - 24 * 60 * 60 // Last 24h

      const data = await this.fetchJson<{
        data: Array<{
          datasource: string
          entity: { code: string; name: string; type: string }
          time: number
          level: string
          condition: string
          value: number
          historyValue: number
        }>
      }>(
        `${IODA_API}/alerts?from=${since}&until=${now}&limit=50`,
        { timeout: 20000 }
      )

      if (!data?.data || !Array.isArray(data.data) || data.data.length === 0) {
        // IODA may be down or changed — use Cloudflare Radar as primary
        await this.collectFromDowndetector(reports)
        return reports
      }

      for (const alert of data.data) {
        const cc = alert.entity?.code?.toUpperCase()
        const country = alert.entity?.name || cc || 'Unknown'
        const coords = cc ? COUNTRY_COORDS[cc] : undefined

        const dropPercent = alert.historyValue > 0
          ? Math.round((1 - alert.value / alert.historyValue) * 100)
          : 0

        const severity = this.outrageSeverity(alert.level, dropPercent)

        reports.push(this.createReport({
          title: `Internet Outage: ${country} (${dropPercent}% drop)`,
          content: `**Country**: ${country}\n**Code**: ${cc}\n**Alert Level**: ${alert.level}\n**Condition**: ${alert.condition}\n**Current Value**: ${Math.round(alert.value)}\n**Baseline**: ${Math.round(alert.historyValue)}\n**Drop**: ${dropPercent}%\n**Data Source**: ${alert.datasource}\n**Type**: ${alert.entity?.type}\n\n_Possible causes: government shutdown, infrastructure failure, natural disaster, censorship, or DDoS attack._`,
          severity,
          sourceUrl: `https://ioda.inetintel.cc.gatech.edu/country/${cc}`,
          sourceName: 'IODA Internet Outage',
          latitude: coords?.[0],
          longitude: coords?.[1],
          verificationScore: dropPercent > 50 ? 95 : 85
        }))
      }

      log.info(`Internet Outages: ${data.data.length} alerts`)
    } catch (err) {
      log.debug(`Internet outage detection failed: ${err}`)
      // Try fallback
      await this.collectFromDowndetector(reports)
    }

    return reports
  }

  private async collectFromDowndetector(reports: IntelReport[]): Promise<void> {
    // Fallback: use Cloudflare Radar public summary (no API key needed)
    try {
      const data = await this.fetchJson<{
        result: {
          annotations: Array<{
            description: string
            startDate: string
            endDate: string
            locations: string[]
            asns: number[]
            scope: string
          }>
        }
      }>(
        'https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=20&dateRange=1d&format=json',
        { timeout: 15000 }
      )

      if (data?.result?.annotations) {
        for (const outage of data.result.annotations.slice(0, 10)) {
          const location = outage.locations?.[0] || 'Unknown'
          const coords = COUNTRY_COORDS[location]

          reports.push(this.createReport({
            title: `Internet Disruption: ${location} — ${outage.scope}`,
            content: `**Location**: ${location}\n**Scope**: ${outage.scope}\n**Started**: ${outage.startDate}\n**Ended**: ${outage.endDate || 'Ongoing'}\n**ASNs Affected**: ${outage.asns?.join(', ') || 'Multiple'}\n\n${outage.description}`,
            severity: outage.scope === 'country' ? 'critical' : 'high',
            sourceUrl: 'https://radar.cloudflare.com/outage-center',
            sourceName: 'Cloudflare Radar',
            latitude: coords?.[0],
            longitude: coords?.[1],
            verificationScore: 90
          }))
        }
      }
    } catch (err) {
      log.debug(`Cloudflare Radar fallback failed: ${err}`)
    }
  }

  private outrageSeverity(level: string, dropPercent: number): ThreatLevel {
    if (level === 'critical' || dropPercent > 80) return 'critical'
    if (level === 'warning' || dropPercent > 50) return 'high'
    if (dropPercent > 20) return 'medium'
    return 'low'
  }
}
