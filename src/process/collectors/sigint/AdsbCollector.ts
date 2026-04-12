import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// OpenSky Network API — free tier (no auth = 10s cache, limited requests)
// Docs: https://openskynetwork.github.io/opensky-api/rest.html
const OPENSKY_API = 'https://opensky-network.org/api'

interface OpenskyState {
  // [icao24, callsign, origin_country, time_position, last_contact,
  //  longitude, latitude, baro_altitude, on_ground, velocity,
  //  true_track, vertical_rate, sensors, geo_altitude, squawk,
  //  spi, position_source]
  0: string   // icao24
  1: string   // callsign
  2: string   // origin_country
  5: number | null  // longitude
  6: number | null  // latitude
  7: number | null  // baro_altitude
  8: boolean  // on_ground
  9: number | null  // velocity
  14: string | null // squawk
}

export class AdsbCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'adsb'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const boundingBoxes = this.getBoundingBoxes()

    for (const bbox of boundingBoxes) {
      try {
        const params = new URLSearchParams({
          lamin: String(bbox.lamin),
          lomin: String(bbox.lomin),
          lamax: String(bbox.lamax),
          lomax: String(bbox.lomax)
        })

        const data = await this.fetchJson<{ time: number; states: OpenskyState[] | null }>(
          `${OPENSKY_API}/states/all?${params.toString()}`
        )

        if (!data.states) continue

        // Look for interesting aircraft (military squawk codes, unusual patterns)
        for (const state of data.states) {
          const icao = state[0]
          const callsign = (state[1] || '').trim()
          const country = state[2]
          const lon = state[5]
          const lat = state[6]
          const altitude = state[7]
          const velocity = state[9]
          const squawk = state[14]

          // Flag military/emergency squawk codes
          const isInteresting = this.isInterestingSquawk(squawk) ||
            this.isInterestingCallsign(callsign)

          if (!isInteresting) continue

          reports.push(
            this.createReport({
              title: `ADS-B: ${callsign || icao} (${country})`,
              content: `**ICAO24**: ${icao}\n**Callsign**: ${callsign || 'N/A'}\n**Country**: ${country}\n**Squawk**: ${squawk || 'N/A'}\n**Altitude**: ${altitude ? Math.round(altitude) + ' m' : 'N/A'}\n**Velocity**: ${velocity ? Math.round(velocity) + ' m/s' : 'N/A'}\n**Position**: ${lat}, ${lon}\n**Region**: ${bbox.name}`,
              severity: this.isEmergencySquawk(squawk) ? 'high' : 'low',
              sourceName: 'OpenSky Network',
              sourceUrl: `https://opensky-network.org/network/explorer?icao24=${icao}`,
              latitude: lat ?? undefined,
              longitude: lon ?? undefined,
              verificationScore: 85
            })
          )
        }

        log.debug(`ADS-B: ${bbox.name} — ${data.states.length} aircraft, ${reports.length} flagged`)
      } catch (err) {
        log.warn(`ADS-B fetch failed for ${bbox.name}: ${err}`)
      }
    }

    return reports
  }

  private isInterestingSquawk(squawk: string | null): boolean {
    if (!squawk) return false
    const interesting = ['7500', '7600', '7700'] // Hijack, Radio fail, Emergency
    return interesting.includes(squawk)
  }

  private isEmergencySquawk(squawk: string | null): boolean {
    return squawk === '7500' || squawk === '7700'
  }

  private isInterestingCallsign(callsign: string): boolean {
    if (!callsign) return false
    const militaryPrefixes = ['RCH', 'EVIL', 'DOOM', 'TOPCAT', 'DARK', 'REACH', 'JAKE']
    return militaryPrefixes.some((p) => callsign.startsWith(p))
  }

  private getBoundingBoxes(): Array<{
    name: string; lamin: number; lomin: number; lamax: number; lomax: number
  }> {
    const custom = this.sourceConfig?.config?.boundingBoxes as Array<{
      name: string; lamin: number; lomin: number; lamax: number; lomax: number
    }> | undefined
    return custom && custom.length > 0 ? custom : []
    // Users configure bounding boxes for areas of interest
  }
}
