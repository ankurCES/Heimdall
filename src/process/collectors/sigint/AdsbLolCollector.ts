import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// ADS-B via adsb.lol — free, no auth, no bounding box required
// https://api.adsb.lol/v2/
// LADD = aircraft that have opted into Limited Aircraft Data Display

export class AdsbLolCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'adsb-lol'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      // LADD aircraft — these are notable/military/government aircraft
      const data = await this.fetchJson<{
        ac: Array<{
          hex: string; flight: string; t: string; r: string
          lat: number; lon: number; alt_baro: number
          gs: number; track: number; squawk: string
          category: string; emergency: string
        }>
        total: number
        now: number
      }>('https://api.adsb.lol/v2/ladd', { timeout: 15000 })

      if (!data?.ac) return reports

      for (const ac of data.ac.slice(0, 30)) {
        if (!ac.lat || !ac.lon) continue

        const isEmergency = ac.emergency && ac.emergency !== 'none'
        const isMilitary = ac.category === 'A7' || (ac.flight && /^RCH|REACH|EVIL|DARK|JAKE/.test(ac.flight.trim()))
        const severity: ThreatLevel = isEmergency ? 'critical' : isMilitary ? 'high' : 'low'

        reports.push(this.createReport({
          title: `ADS-B: ${(ac.flight || ac.hex).trim()} ${ac.t || ''}`,
          content: `**Callsign**: ${ac.flight?.trim() || 'N/A'}\n**Hex**: ${ac.hex}\n**Type**: ${ac.t || 'Unknown'}\n**Registration**: ${ac.r || 'N/A'}\n**Altitude**: ${ac.alt_baro || 'N/A'} ft\n**Speed**: ${ac.gs || 'N/A'} kts\n**Squawk**: ${ac.squawk || 'N/A'}\n**Category**: ${ac.category || 'N/A'}${isEmergency ? `\n**EMERGENCY**: ${ac.emergency}` : ''}`,
          severity,
          sourceUrl: `https://globe.adsb.fi/?icao=${ac.hex}`,
          sourceName: 'ADS-B (adsb.lol)',
          latitude: ac.lat,
          longitude: ac.lon,
          verificationScore: 90
        }))
      }

      log.info(`ADS-B lol: ${data.ac.length} LADD aircraft, ${reports.length} reported`)
    } catch (err) {
      log.debug(`ADS-B lol failed: ${err}`)
    }

    return reports
  }
}
