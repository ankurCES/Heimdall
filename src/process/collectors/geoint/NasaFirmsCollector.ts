import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// NASA FIRMS — Fire Information for Resource Management System
// Free, requires MAP_KEY from https://firms.modaps.eosdis.nasa.gov/api/area/
const FIRMS_API = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'

export class NasaFirmsCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'nasa-firms'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      // Use VIIRS data — most recent 24h, global hotspots
      // CSV format: latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight
      const csvText = await this.fetchText(
        `https://firms.modaps.eosdis.nasa.gov/api/country/csv/VIIRS_SNPP_NRT/world/1`,
        { timeout: 30000 }
      )

      const lines = csvText.split('\n').filter((l) => l.trim())
      if (lines.length <= 1) return reports

      const header = lines[0].split(',')
      const latIdx = header.indexOf('latitude')
      const lonIdx = header.indexOf('longitude')
      const brightIdx = header.indexOf('bright_ti4') !== -1 ? header.indexOf('bright_ti4') : header.indexOf('brightness')
      const confIdx = header.indexOf('confidence')
      const dateIdx = header.indexOf('acq_date')
      const frpIdx = header.indexOf('frp')
      const countryIdx = header.indexOf('country_id')

      // Only take high-confidence fires with significant FRP
      const significantFires = lines.slice(1).filter((line) => {
        const cols = line.split(',')
        const conf = cols[confIdx]
        const frp = parseFloat(cols[frpIdx] || '0')
        return (conf === 'high' || conf === 'h' || conf === 'nominal' || conf === 'n') && frp > 10
      }).slice(0, 30) // Top 30

      for (const line of significantFires) {
        const cols = line.split(',')
        const lat = parseFloat(cols[latIdx])
        const lon = parseFloat(cols[lonIdx])
        const brightness = parseFloat(cols[brightIdx] || '0')
        const frp = parseFloat(cols[frpIdx] || '0')
        const date = cols[dateIdx]
        const country = cols[countryIdx] || 'Unknown'

        const severity: ThreatLevel = frp > 100 ? 'critical' : frp > 50 ? 'high' : frp > 20 ? 'medium' : 'low'

        reports.push(
          this.createReport({
            title: `Fire Detection: ${country} (FRP: ${frp.toFixed(0)} MW)`,
            content: `**Location**: ${lat.toFixed(4)}, ${lon.toFixed(4)}\n**Country**: ${country}\n**Fire Radiative Power**: ${frp.toFixed(1)} MW\n**Brightness**: ${brightness.toFixed(1)} K\n**Date**: ${date}\n**Satellite**: VIIRS SNPP`,
            severity,
            sourceUrl: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lon},${lat},8z`,
            sourceName: 'NASA FIRMS',
            latitude: lat,
            longitude: lon,
            verificationScore: 95
          })
        )
      }

      log.info(`NASA FIRMS: ${significantFires.length} significant fires of ${lines.length - 1} total`)
    } catch (err) {
      log.warn(`NASA FIRMS failed: ${err}`)
    }

    return reports
  }
}
