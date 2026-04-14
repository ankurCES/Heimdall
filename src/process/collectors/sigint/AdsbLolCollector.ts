import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { squawkClassifier } from '../../services/sigint/SquawkClassifier'
import { militaryAircraftClassifier } from '../../services/sigint/MilitaryAircraftClassifier'
import log from 'electron-log'

// ADS-B via adsb.lol — free, no auth
// Enriches with squawk code classification

export class AdsbLolCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'adsb-lol'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const data = await this.fetchJson<{
        ac: Array<{
          hex: string; flight: string; t: string; r: string
          lat: number; lon: number; alt_baro: number
          gs: number; track: number; squawk: string
          category: string; emergency: string
        }>
        total: number; now: number
      }>('https://api.adsb.lol/v2/ladd', { timeout: 15000 })

      if (!data?.ac) return reports

      for (const ac of data.ac.slice(0, 50)) {
        if (!ac.lat || !ac.lon) continue

        // Classify squawk + military hex range
        const squawk = squawkClassifier.classify(ac.squawk)
        const milClass = militaryAircraftClassifier.classify(ac.hex, ac.flight)
        const isEmergency = ac.emergency && ac.emergency !== 'none'
        const isMilitary = milClass.isMilitary || ac.category === 'A7' || squawk.category === 'military'

        let severity: ThreatLevel = squawk.severity
        if (isEmergency) severity = 'critical'
        else if (isMilitary && severity === 'info') severity = 'high'

        const squawkSection = ac.squawk
          ? `\n\n## Squawk Analysis\n**Code**: ${squawk.code}\n**Classification**: ${squawk.meaning}\n**Category**: ${squawk.category.toUpperCase()}\n**Description**: ${squawk.description}`
          : ''

        const milSection = milClass.isMilitary
          ? `\n\n## Military Classification\n**Country**: ${milClass.country}\n**Operator**: ${milClass.operator}\n**Confidence**: ${(milClass.confidence * 100).toFixed(0)}%\n**Method**: ${milClass.method === 'hex_range' ? 'ICAO Hex Range' : 'Callsign Match'}`
          : ''

        reports.push(this.createReport({
          title: `ADS-B: ${(ac.flight || ac.hex).trim()} ${ac.t || ''} [${squawk.meaning}]`,
          content: `**Callsign**: ${ac.flight?.trim() || 'N/A'}\n**Hex**: ${ac.hex}\n**Type**: ${ac.t || 'Unknown'}\n**Registration**: ${ac.r || 'N/A'}\n**Altitude**: ${ac.alt_baro || 'N/A'} ft\n**Speed**: ${ac.gs || 'N/A'} kts\n**Squawk**: ${ac.squawk || 'N/A'}\n**Category**: ${ac.category || 'N/A'}${isMilitary ? `\n**Military**: YES (${milClass.operator || squawk.category})` : ''}${isEmergency ? `\n\n**EMERGENCY**: ${ac.emergency}` : ''}${squawkSection}${milSection}`,
          severity,
          sourceUrl: `https://globe.adsb.fi/?icao=${ac.hex}`,
          sourceName: `ADS-B [${squawk.meaning}]`,
          latitude: ac.lat,
          longitude: ac.lon,
          verificationScore: 90
        }))
      }

      const notable = data.ac.filter((ac) => ac.squawk && squawkClassifier.isNotable(ac.squawk))
      if (notable.length > 0) {
        log.info(`ADS-B: ${notable.length} notable squawks: ${notable.map((a) => `${a.flight?.trim() || a.hex}=${a.squawk}`).join(', ')}`)
      }

      log.info(`ADS-B lol: ${data.ac.length} aircraft, ${reports.length} reported, ${notable.length} notable`)
    } catch (err) {
      log.debug(`ADS-B lol failed: ${err}`)
    }

    return reports
  }
}
