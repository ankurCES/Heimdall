import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Airport Delay & NOTAM Intelligence
// FAA Airport Status Web Service (ASWS) — free, no auth
// Monitors 14 major US hubs for ground delays, ground stops, closures

const FAA_API = 'https://soa.smext.faa.gov/asws/api/airport/status'

// Major US hub airports
const FAA_AIRPORTS = [
  'ATL', 'ORD', 'DFW', 'DEN', 'JFK', 'LAX', 'SFO', 'SEA', 'LAS', 'MCO',
  'EWR', 'CLT', 'PHX', 'IAH'
]

// Airport coordinates for geo-tagging
const AIRPORT_COORDS: Record<string, [number, number]> = {
  ATL: [33.6407, -84.4277], ORD: [41.9742, -87.9073], DFW: [32.8998, -97.0403],
  DEN: [39.8561, -104.6737], JFK: [40.6413, -73.7781], LAX: [33.9425, -118.4081],
  SFO: [37.6213, -122.3790], SEA: [47.4502, -122.3088], LAS: [36.0840, -115.1537],
  MCO: [28.4312, -81.3081], EWR: [40.6895, -74.1745], CLT: [35.2140, -80.9431],
  PHX: [33.4373, -112.0078], IAH: [29.9902, -95.3368]
}

interface FaaStatus {
  Name: string
  IATA: string
  Delay: boolean
  Status: Array<{
    Type: string
    Reason: string
    AvgDelay?: string
    ClosureBegin?: string
    ClosureEnd?: string
    MinDelay?: string
    MaxDelay?: string
    Trend?: string
    EndTime?: string
  }>
  Weather: {
    Temp: string[]
    Wind: string[]
    Weather: string[]
    Visibility: string[]
    Meta: string[]
  }
}

export class AirportDelayCollector extends BaseCollector {
  readonly discipline = 'sigint' as const
  readonly type = 'airport-delay'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // Query FAA for each airport
    const results = await Promise.allSettled(
      FAA_AIRPORTS.map((code) => this.checkAirport(code))
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        reports.push(result.value)
      }
    }

    // Summary report
    const delayed = reports.filter((r) => r.severity !== 'info')
    if (delayed.length > 0) {
      log.info(`Airport Delays: ${delayed.length}/${FAA_AIRPORTS.length} airports with delays`)
    } else {
      log.debug('Airport Delays: all airports operating normally')
    }

    return reports
  }

  private async checkAirport(code: string): Promise<IntelReport | null> {
    try {
      // Use direct fetch — FAA ASWS has SSL/TLS quirks with Node fetch
      const response = await fetch(`${FAA_API}/${code}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Heimdall/0.1.0' },
        signal: AbortSignal.timeout(10000)
      })
      if (!response.ok) return null
      const data = await response.json() as FaaStatus

      if (!data) return null

      const coords = AIRPORT_COORDS[code]
      const hasDelay = data.Delay

      if (!hasDelay) {
        // Only report non-delayed airports as info-level occasionally
        return this.createReport({
          title: `Airport: ${code} (${data.Name}) — Normal Operations`,
          content: `**Airport**: ${data.Name} (${code})\n**Status**: No delays\n**Weather**: ${data.Weather?.Weather?.[0] || 'Clear'}\n**Temperature**: ${data.Weather?.Temp?.[0] || 'N/A'}\n**Wind**: ${data.Weather?.Wind?.[0] || 'Calm'}\n**Visibility**: ${data.Weather?.Visibility?.[0] || 'Good'}`,
          severity: 'info',
          sourceUrl: `https://www.fly.faa.gov/flyfaa/usmap.jsp`,
          sourceName: 'FAA ASWS',
          latitude: coords?.[0],
          longitude: coords?.[1],
          verificationScore: 98
        })
      }

      // Parse delay details
      const statusLines = (data.Status || []).map((s) => {
        let detail = `**${s.Type}**`
        if (s.Reason) detail += `: ${s.Reason}`
        if (s.AvgDelay) detail += ` (avg ${s.AvgDelay})`
        if (s.MinDelay && s.MaxDelay) detail += ` (${s.MinDelay} - ${s.MaxDelay})`
        if (s.ClosureBegin && s.ClosureEnd) detail += ` (${s.ClosureBegin} - ${s.ClosureEnd})`
        if (s.Trend) detail += ` | Trend: ${s.Trend}`
        return detail
      }).join('\n')

      const severity = this.delaySeverity(data.Status)
      const isGroundStop = data.Status?.some((s) => s.Type?.toLowerCase().includes('ground stop'))
      const isClosure = data.Status?.some((s) => s.Type?.toLowerCase().includes('closure'))

      return this.createReport({
        title: `Airport ${isClosure ? 'CLOSED' : isGroundStop ? 'GROUND STOP' : 'DELAY'}: ${code} (${data.Name})`,
        content: `**Airport**: ${data.Name} (${code})\n**Delay**: YES\n**Weather**: ${data.Weather?.Weather?.[0] || 'N/A'}\n**Temperature**: ${data.Weather?.Temp?.[0] || 'N/A'}\n**Wind**: ${data.Weather?.Wind?.[0] || 'N/A'}\n**Visibility**: ${data.Weather?.Visibility?.[0] || 'N/A'}\n\n**Delay Details**:\n${statusLines || 'General delay reported'}\n\n_FAA Airport Status Web Service — real-time operational data._`,
        severity,
        sourceUrl: `https://www.fly.faa.gov/flyfaa/usmap.jsp`,
        sourceName: 'FAA ASWS',
        latitude: coords?.[0],
        longitude: coords?.[1],
        verificationScore: 98
      })
    } catch (err) {
      log.debug(`FAA check failed for ${code}: ${err}`)
      return null
    }
  }

  private delaySeverity(statuses: FaaStatus['Status']): ThreatLevel {
    if (!statuses || statuses.length === 0) return 'low'

    for (const s of statuses) {
      const type = (s.Type || '').toLowerCase()
      if (type.includes('closure') || type.includes('closed')) return 'critical'
      if (type.includes('ground stop')) return 'high'
      if (type.includes('ground delay')) return 'medium'
    }

    // Check average delay duration
    for (const s of statuses) {
      const avg = s.AvgDelay || s.MaxDelay || ''
      const minutes = parseInt(avg)
      if (minutes > 60) return 'high'
      if (minutes > 30) return 'medium'
    }

    return 'low'
  }
}
