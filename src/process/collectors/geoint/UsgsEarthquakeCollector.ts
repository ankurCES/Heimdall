import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// USGS Earthquake API — free, no auth
// Docs: https://earthquake.usgs.gov/fdsnws/event/1/
const USGS_API = 'https://earthquake.usgs.gov/fdsnws/event/1/query'

interface UsgsFeature {
  id: string
  properties: {
    mag: number
    place: string
    time: number
    url: string
    title: string
    alert: string | null
    tsunami: number
    sig: number
    type: string
  }
  geometry: {
    coordinates: [number, number, number] // [lon, lat, depth]
  }
}

export class UsgsEarthquakeCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'usgs-earthquake'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const now = new Date()
      const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      const minMagnitude = (this.sourceConfig?.config?.minMagnitude as number) ?? 4.0

      const params = new URLSearchParams({
        format: 'geojson',
        starttime: startTime.toISOString(),
        endtime: now.toISOString(),
        minmagnitude: String(minMagnitude),
        orderby: 'magnitude',
        limit: '50'
      })

      const data = await this.fetchJson<{ features: UsgsFeature[] }>(
        `${USGS_API}?${params.toString()}`
      )

      for (const feature of data.features) {
        const p = feature.properties
        const [lon, lat, depth] = feature.geometry.coordinates
        const severity = this.magnitudeToSeverity(p.mag)

        reports.push(
          this.createReport({
            title: p.title,
            content: `**Magnitude**: ${p.mag}\n**Location**: ${p.place}\n**Depth**: ${depth} km\n**Time**: ${new Date(p.time).toISOString()}\n**Significance**: ${p.sig}\n**Tsunami Warning**: ${p.tsunami ? 'YES' : 'No'}\n**Alert Level**: ${p.alert || 'None'}\n**Type**: ${p.type}`,
            severity,
            sourceUrl: p.url,
            sourceName: 'USGS Earthquake',
            latitude: lat,
            longitude: lon,
            verificationScore: 98
          })
        )
      }

      log.debug(`USGS Earthquakes: ${data.features.length} events (M${minMagnitude}+)`)
    } catch (err) {
      log.error('UsgsEarthquakeCollector failed:', err)
    }

    return reports
  }

  private magnitudeToSeverity(mag: number): ThreatLevel {
    if (mag >= 7.0) return 'critical'
    if (mag >= 6.0) return 'high'
    if (mag >= 5.0) return 'medium'
    if (mag >= 4.0) return 'low'
    return 'info'
  }
}
