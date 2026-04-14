import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// GDACS — Global Disaster Alerting Coordination System (UN OCHA)
// Free, no auth — provides multi-hazard alerts: earthquakes, floods, cyclones, volcanoes, wildfires, droughts
// GeoJSON feed available at: https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH

const GDACS_API = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH'

const ALERT_SEVERITY: Record<string, ThreatLevel> = {
  Red: 'critical',
  Orange: 'high',
  Green: 'medium'
}

const HAZARD_ICONS: Record<string, string> = {
  EQ: 'Earthquake',
  TC: 'Tropical Cyclone',
  FL: 'Flood',
  VO: 'Volcanic Eruption',
  DR: 'Drought',
  WF: 'Wildfire',
  TS: 'Tsunami'
}

export class GdacsCollector extends BaseCollector {
  readonly discipline = 'geoint' as const
  readonly type = 'gdacs'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      // GDACS GeoJSON feed — last 24h events
      const data = await this.fetchJson<{
        features: Array<{
          properties: {
            eventid: number
            eventtype: string
            name: string
            alertlevel: string
            alertscore: number
            country: string
            fromdate: string
            todate: string
            description: string
            url: { report: string; details: string }
            severity: { severity: number; severitytext: string; severityunit: string }
            population: { exposure: number; affected: number }
          }
          geometry: {
            type: string
            coordinates: number[] // [lon, lat]
          }
        }>
      }>(
        `${GDACS_API}?alertlevel=Green;Orange;Red&eventlist=EQ;TC;FL;VO;WF;DR&from=${this.since48h()}`,
        { timeout: 20000 }
      )

      if (!data?.features) return reports

      for (const feature of data.features.slice(0, 30)) {
        const p = feature.properties
        const coords = feature.geometry?.coordinates
        const lat = coords?.[1]
        const lon = coords?.[0]

        if (!lat || !lon) continue

        const alertLevel = p.alertlevel || 'Green'
        const severity = ALERT_SEVERITY[alertLevel] || 'medium'
        const hazardName = HAZARD_ICONS[p.eventtype] || p.eventtype
        const population = p.population?.exposure || 0
        const affected = p.population?.affected || 0

        const severityText = p.severity
          ? `${p.severity.severitytext} (${p.severity.severity} ${p.severity.severityunit})`
          : 'Unknown'

        reports.push(this.createReport({
          title: `GDACS ${alertLevel}: ${hazardName} — ${p.name || p.country}`,
          content: `**Alert Level**: ${alertLevel}\n**Hazard**: ${hazardName}\n**Location**: ${p.country || 'Unknown'}\n**Severity**: ${severityText}\n**Started**: ${p.fromdate}\n**Population Exposed**: ${population.toLocaleString()}\n**Population Affected**: ${affected.toLocaleString()}\n**Description**: ${p.description || 'No description'}\n\n**Event ID**: ${p.eventid}`,
          severity,
          sourceUrl: p.url?.report || `https://www.gdacs.org/report.aspx?eventid=${p.eventid}&eventtype=${p.eventtype}`,
          sourceName: `GDACS ${hazardName}`,
          latitude: lat,
          longitude: lon,
          verificationScore: alertLevel === 'Red' ? 98 : alertLevel === 'Orange' ? 95 : 90
        }))
      }

      const redCount = data.features.filter((f) => f.properties.alertlevel === 'Red').length
      log.info(`GDACS: ${data.features.length} events (${redCount} Red alerts)`)
    } catch (err) {
      log.warn(`GDACS failed: ${err}`)
    }

    return reports
  }

  private since48h(): string {
    return new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('T')[0]
  }
}
