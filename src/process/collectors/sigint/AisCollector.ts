import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// AISHub — free AIS data exchange
// Docs: https://www.aishub.net/api
// Alternative: aisstream.io websocket

export class AisCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'ais-maritime'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const regions = this.getRegions()

    for (const region of regions) {
      try {
        // Use AISHub API
        const data = await this.fetchJson<Array<{
          MMSI: number
          NAME: string
          IMO: number
          CALLSIGN: string
          TYPE: number
          A: number; B: number; C: number; D: number
          DRAUGHT: number
          DEST: string
          ETA: string
          LATITUDE: number
          LONGITUDE: number
          COURSE: number
          SPEED: number
          HEADING: number
          NAVSTAT: number
          TIMESTAMP: string
          FLAG: string
        }>>(
          `https://data.aishub.net/ws.php?username=AH_${region.key}&format=1&output=json&compress=0&latmin=${region.latMin}&latmax=${region.latMax}&lonmin=${region.lonMin}&lonmax=${region.lonMax}`,
          { timeout: 15000 }
        ).catch(() => [])

        if (!Array.isArray(data) || data.length === 0) continue

        // Flag interesting vessels
        for (const vessel of data.slice(0, 20)) {
          if (!vessel.NAME || !vessel.LATITUDE) continue

          const isInteresting = this.isInterestingVessel(vessel)
          if (!isInteresting) continue

          const severity: ThreatLevel = vessel.NAVSTAT === 0 ? 'info' : vessel.SPEED === 0 ? 'low' : 'info'

          reports.push(
            this.createReport({
              title: `AIS: ${vessel.NAME.trim()} (${vessel.FLAG || 'Unknown'})`,
              content: `**Vessel**: ${vessel.NAME.trim()}\n**MMSI**: ${vessel.MMSI}\n**IMO**: ${vessel.IMO || 'N/A'}\n**Callsign**: ${vessel.CALLSIGN || 'N/A'}\n**Type**: ${this.vesselType(vessel.TYPE)}\n**Flag**: ${vessel.FLAG || 'Unknown'}\n**Destination**: ${vessel.DEST || 'N/A'}\n**Speed**: ${vessel.SPEED} knots\n**Course**: ${vessel.COURSE}°\n**Position**: ${vessel.LATITUDE}, ${vessel.LONGITUDE}\n**Region**: ${region.name}`,
              severity,
              sourceName: 'AIS Maritime',
              latitude: vessel.LATITUDE,
              longitude: vessel.LONGITUDE,
              verificationScore: 85
            })
          )
        }

        log.debug(`AIS: ${region.name} — ${data.length} vessels`)
      } catch (err) {
        log.debug(`AIS failed for ${region.name}: ${err}`)
      }
    }

    return reports
  }

  private isInterestingVessel(vessel: any): boolean {
    // Flag: military vessels, tankers in unusual areas, high-speed craft
    const type = vessel.TYPE || 0
    if (type >= 35 && type <= 39) return true // Military
    if (type >= 80 && type <= 89) return true // Tankers
    if (vessel.SPEED > 25) return true // Unusually fast
    if (vessel.NAVSTAT === 6) return true // Aground
    return false
  }

  private vesselType(type: number): string {
    if (type >= 20 && type <= 29) return 'Wing in Ground'
    if (type >= 30 && type <= 39) return type >= 35 ? 'Military' : 'Fishing/Towing'
    if (type >= 40 && type <= 49) return 'High Speed Craft'
    if (type >= 60 && type <= 69) return 'Passenger'
    if (type >= 70 && type <= 79) return 'Cargo'
    if (type >= 80 && type <= 89) return 'Tanker'
    return `Type ${type}`
  }

  private getRegions(): Array<{ name: string; key: string; latMin: number; latMax: number; lonMin: number; lonMax: number }> {
    const custom = this.sourceConfig?.config?.regions as any[]
    return custom && custom.length > 0 ? custom : []
  }
}
