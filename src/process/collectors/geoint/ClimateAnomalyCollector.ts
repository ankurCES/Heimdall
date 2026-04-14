import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Climate Anomaly Detection — Open-Meteo ERA5 Reanalysis
// Free, no auth — monitors temperature + precipitation anomalies
// in conflict-prone and disaster-vulnerable zones
// Ref: World Monitor seed-climate-anomalies.mjs

const OPEN_METEO_API = 'https://api.open-meteo.com/v1/forecast'

// 15 conflict/disaster-prone zones to monitor
const MONITORING_ZONES = [
  { name: 'Middle East (Baghdad)', lat: 33.31, lon: 44.37, region: 'Middle East' },
  { name: 'Horn of Africa (Mogadishu)', lat: 2.05, lon: 45.32, region: 'East Africa' },
  { name: 'Sahel (Niamey)', lat: 13.51, lon: 2.11, region: 'West Africa' },
  { name: 'Eastern Ukraine (Donetsk)', lat: 48.00, lon: 37.80, region: 'Eastern Europe' },
  { name: 'Kashmir (Srinagar)', lat: 34.08, lon: 74.80, region: 'South Asia' },
  { name: 'Gaza', lat: 31.50, lon: 34.47, region: 'Middle East' },
  { name: 'Kabul', lat: 34.53, lon: 69.17, region: 'Central Asia' },
  { name: 'Khartoum', lat: 15.60, lon: 32.53, region: 'East Africa' },
  { name: 'Port-au-Prince', lat: 18.54, lon: -72.34, region: 'Caribbean' },
  { name: 'Dhaka', lat: 23.81, lon: 90.41, region: 'South Asia' },
  { name: 'Manila', lat: 14.60, lon: 120.98, region: 'Southeast Asia' },
  { name: 'Mexico City', lat: 19.43, lon: -99.13, region: 'Americas' },
  { name: 'Tripoli', lat: 32.90, lon: 13.18, region: 'North Africa' },
  { name: 'Caracas', lat: 10.49, lon: -66.88, region: 'Americas' },
  { name: 'Yangon', lat: 16.87, lon: 96.20, region: 'Southeast Asia' }
]

export class ClimateAnomalyCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'climate-anomaly'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // Process zones in small batches to respect rate limits
    for (let i = 0; i < MONITORING_ZONES.length; i += 3) {
      const batch = MONITORING_ZONES.slice(i, i + 3)
      const results = await Promise.allSettled(
        batch.map((zone) => this.checkZone(zone))
      )
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) reports.push(r.value)
      }
      // Small delay between batches
      if (i + 3 < MONITORING_ZONES.length) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    const anomalies = reports.filter((r) => r.severity !== 'info')
    log.info(`Climate Anomalies: ${anomalies.length} anomalies detected in ${MONITORING_ZONES.length} zones`)
    return reports
  }

  private async checkZone(zone: typeof MONITORING_ZONES[0]): Promise<IntelReport | null> {
    try {
      // Get current conditions + 7-day forecast
      const data = await this.fetchJson<{
        current: {
          temperature_2m: number
          relative_humidity_2m: number
          precipitation: number
          wind_speed_10m: number
          weather_code: number
        }
        daily: {
          temperature_2m_max: number[]
          temperature_2m_min: number[]
          precipitation_sum: number[]
          time: string[]
        }
      }>(
        `${OPEN_METEO_API}?latitude=${zone.lat}&longitude=${zone.lon}` +
        `&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&past_days=7&forecast_days=3&timezone=auto`,
        { timeout: 10000 }
      )

      if (!data?.current || !data?.daily) return null

      const current = data.current
      const daily = data.daily

      // Calculate 7-day baseline
      const pastTemps = daily.temperature_2m_max.slice(0, 7)
      const pastPrecip = daily.precipitation_sum.slice(0, 7)
      const baselineTemp = pastTemps.reduce((a, b) => a + b, 0) / pastTemps.length
      const baselinePrecip = pastPrecip.reduce((a, b) => a + b, 0) / pastPrecip.length

      const tempAnomaly = current.temperature_2m - baselineTemp
      const todayPrecip = daily.precipitation_sum[daily.precipitation_sum.length - 1] || 0
      const precipAnomaly = todayPrecip - baselinePrecip

      // Classify anomaly
      let anomalyType = 'Normal'
      let severity: ThreatLevel = 'info'

      if (Math.abs(tempAnomaly) > 5 || precipAnomaly > 80) {
        anomalyType = tempAnomaly > 5 ? 'Extreme Heat' : tempAnomaly < -5 ? 'Extreme Cold' : 'Extreme Precipitation'
        severity = 'high'
      } else if (Math.abs(tempAnomaly) > 3 || precipAnomaly > 40) {
        anomalyType = tempAnomaly > 3 ? 'Above-Average Heat' : tempAnomaly < -3 ? 'Below-Average Cold' : 'Heavy Precipitation'
        severity = 'medium'
      } else if (Math.abs(tempAnomaly) > 1.5 || precipAnomaly > 20) {
        anomalyType = 'Mild Anomaly'
        severity = 'low'
      }

      const weatherDesc = this.weatherCode(current.weather_code)

      // Forecast outlook
      const forecastTemps = daily.temperature_2m_max.slice(7)
      const forecastPrecip = daily.precipitation_sum.slice(7)
      const forecastLines = forecastTemps.map((t, idx) => {
        const date = daily.time[7 + idx] || ''
        return `  ${date}: ${t.toFixed(1)}°C, ${(forecastPrecip[idx] || 0).toFixed(1)}mm`
      }).join('\n')

      return this.createReport({
        title: `Climate: ${zone.name} — ${anomalyType} (${tempAnomaly > 0 ? '+' : ''}${tempAnomaly.toFixed(1)}°C)`,
        content: `**Zone**: ${zone.name}\n**Region**: ${zone.region}\n**Current**: ${current.temperature_2m.toFixed(1)}°C, ${weatherDesc}\n**Humidity**: ${current.relative_humidity_2m}%\n**Wind**: ${current.wind_speed_10m.toFixed(1)} km/h\n**Precipitation Today**: ${todayPrecip.toFixed(1)}mm\n\n**Anomaly Analysis**:\n- Temperature: ${tempAnomaly > 0 ? '+' : ''}${tempAnomaly.toFixed(1)}°C vs 7-day baseline (${baselineTemp.toFixed(1)}°C)\n- Precipitation: ${precipAnomaly > 0 ? '+' : ''}${precipAnomaly.toFixed(1)}mm vs baseline (${baselinePrecip.toFixed(1)}mm/day)\n- Classification: **${anomalyType}**\n\n**3-Day Forecast**:\n${forecastLines}\n\n_Climate stress is a recognized conflict accelerant — droughts trigger food insecurity, floods cause displacement._`,
        severity,
        sourceUrl: `https://open-meteo.com/en/docs#latitude=${zone.lat}&longitude=${zone.lon}`,
        sourceName: 'Open-Meteo Climate',
        latitude: zone.lat,
        longitude: zone.lon,
        verificationScore: 90
      })
    } catch (err) {
      log.debug(`Climate check failed for ${zone.name}: ${err}`)
      return null
    }
  }

  private weatherCode(code: number): string {
    const codes: Record<number, string> = {
      0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
      45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
      55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
      71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
      80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
      95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail'
    }
    return codes[code] || `WMO Code ${code}`
  }
}
