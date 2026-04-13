import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// ISS and satellite tracking — free, no auth
// https://api.wheretheiss.at/

export class SatelliteCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'satellite'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const iss = await this.fetchJson<{
        name: string; id: number
        latitude: number; longitude: number; altitude: number
        velocity: number; visibility: string
        timestamp: number
      }>('https://api.wheretheiss.at/v1/satellites/25544', { timeout: 10000 })

      if (iss) {
        reports.push(this.createReport({
          title: `ISS Position: ${iss.latitude.toFixed(2)}°, ${iss.longitude.toFixed(2)}°`,
          content: `**International Space Station**\n**Latitude**: ${iss.latitude.toFixed(4)}\n**Longitude**: ${iss.longitude.toFixed(4)}\n**Altitude**: ${iss.altitude.toFixed(1)} km\n**Velocity**: ${iss.velocity.toFixed(1)} km/h\n**Visibility**: ${iss.visibility}`,
          severity: 'info',
          sourceUrl: 'https://www.wheretheiss.at/',
          sourceName: 'ISS Tracker',
          latitude: iss.latitude,
          longitude: iss.longitude,
          verificationScore: 98
        }))
      }
    } catch (err) {
      log.debug(`ISS tracker failed: ${err}`)
    }

    log.info(`Satellite: ${reports.length} positions`)
    return reports
  }
}
