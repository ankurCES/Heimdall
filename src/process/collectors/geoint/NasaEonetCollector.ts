import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// NASA EONET — Earth Observatory Natural Event Tracker
// Free, no auth — https://eonet.gsfc.nasa.gov/docs/v3
const EONET_API = 'https://eonet.gsfc.nasa.gov/api/v3'

interface EonetEvent {
  id: string
  title: string
  description: string | null
  link: string
  categories: Array<{ id: string; title: string }>
  sources: Array<{ id: string; url: string }>
  geometry: Array<{
    date: string
    type: string
    coordinates: number[] // [lon, lat] or [[lon, lat], ...]
  }>
}

const CATEGORY_SEVERITY: Record<string, ThreatLevel> = {
  wildfires: 'high',
  severeStorms: 'high',
  volcanoes: 'critical',
  earthquakes: 'high',
  floods: 'high',
  landslides: 'medium',
  seaLakeIce: 'low',
  snow: 'low',
  drought: 'medium',
  dustHaze: 'low',
  tempExtremes: 'medium',
  manmade: 'high'
}

export class NasaEonetCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'nasa-eonet'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const data = await this.fetchJson<{ events: EonetEvent[] }>(
        `${EONET_API}/events?status=open&limit=50`,
        { timeout: 20000 }
      )

      for (const event of data.events || []) {
        const category = event.categories[0]?.id || 'unknown'
        const categoryTitle = event.categories[0]?.title || 'Unknown'
        const severity = CATEGORY_SEVERITY[category] || 'medium'

        // Get latest geometry
        const latestGeo = event.geometry[event.geometry.length - 1]
        let lat: number | undefined
        let lon: number | undefined

        if (latestGeo?.type === 'Point' && latestGeo.coordinates) {
          lon = latestGeo.coordinates[0]
          lat = latestGeo.coordinates[1]
        }

        const sources = event.sources?.map((s) => `[${s.id}](${s.url})`).join(', ') || 'None'

        reports.push(
          this.createReport({
            title: `EONET: ${event.title}`,
            content: `**Category**: ${categoryTitle}\n**Event ID**: ${event.id}\n**Date**: ${latestGeo?.date || 'Unknown'}\n**Sources**: ${sources}\n${event.description ? `\n${event.description}` : ''}`,
            severity,
            sourceUrl: event.link,
            sourceName: 'NASA EONET',
            latitude: lat,
            longitude: lon,
            verificationScore: 95
          })
        )
      }

      log.info(`NASA EONET: ${data.events?.length || 0} active events`)
    } catch (err) {
      log.warn(`NASA EONET failed: ${err}`)
    }

    return reports
  }
}
