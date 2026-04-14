import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Government Travel Security Advisories — consolidated multi-source
// US State Dept, UK FCDO, Australia DFAT — all free, public JSON/RSS

// US State Dept advisory levels
const US_ADVISORY_URL = 'https://cadatalog.state.gov/catalog/api/3/action/package_search?q=travel-advisory&rows=50'

// Country centroid coordinates for geo-tagging advisories
const COUNTRY_COORDS: Record<string, [number, number]> = {
  'Afghanistan': [33.94, 67.71], 'Iraq': [33.22, 43.68], 'Syria': [34.80, 38.99],
  'Yemen': [15.55, 48.52], 'Libya': [26.34, 17.23], 'Somalia': [5.15, 46.20],
  'South Sudan': [6.88, 31.31], 'North Korea': [40.34, 127.51], 'Iran': [32.43, 53.69],
  'Ukraine': [48.38, 31.17], 'Russia': [61.52, 105.32], 'China': [35.86, 104.20],
  'Venezuela': [6.42, -66.59], 'Haiti': [18.97, -72.29], 'Mali': [17.57, -4.00],
  'Niger': [17.61, 8.08], 'Nigeria': [9.08, 8.68], 'Sudan': [12.86, 30.22],
  'Myanmar': [21.91, 95.96], 'Pakistan': [30.38, 69.35], 'Lebanon': [33.85, 35.86],
  'Mexico': [23.63, -102.55], 'Colombia': [4.57, -74.30], 'Ethiopia': [9.15, 40.49],
  'Mozambique': [-18.67, 35.53], 'Burkina Faso': [12.24, -1.56], 'Chad': [15.45, 18.73],
  'Congo': [-4.04, 21.76], 'Central African Republic': [6.61, 20.94],
  'Israel': [31.05, 34.85], 'Palestine': [31.95, 35.23], 'Egypt': [26.82, 30.80],
  'Turkey': [38.96, 35.24], 'India': [20.59, 78.96], 'Philippines': [12.88, 121.77],
  'Thailand': [15.87, 100.99], 'Kenya': [-0.02, 37.91], 'Tanzania': [-6.37, 34.89],
  'South Africa': [-30.56, 22.94], 'Brazil': [-14.24, -51.93], 'Argentina': [-38.42, -63.62],
  'Saudi Arabia': [23.89, 45.08], 'United Arab Emirates': [23.42, 53.85],
  'Japan': [36.20, 138.25], 'South Korea': [35.91, 127.77], 'Taiwan': [23.70, 120.96],
  'Cuba': [21.52, -77.78], 'Honduras': [15.20, -86.24], 'El Salvador': [13.79, -88.90],
  'Guatemala': [15.78, -90.23], 'Nicaragua': [12.87, -85.21]
}

// Advisory severity mapping
function advisorySeverity(level: number): ThreatLevel {
  if (level >= 4) return 'critical'  // Do Not Travel
  if (level >= 3) return 'high'      // Reconsider Travel
  if (level >= 2) return 'medium'    // Exercise Increased Caution
  return 'low'                       // Normal Precautions
}

const LEVEL_NAMES: Record<number, string> = {
  1: 'Exercise Normal Precautions',
  2: 'Exercise Increased Caution',
  3: 'Reconsider Travel',
  4: 'Do Not Travel'
}

export class SecurityAdvisoryCollector extends BaseCollector {
  readonly discipline = 'agency' as const
  readonly type = 'security-advisory'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // UK FCDO advisories (RSS feed)
    await this.collectFcdo(reports)

    // Australia DFAT Smartraveller
    await this.collectDfat(reports)

    log.info(`Security Advisories: ${reports.length} advisory reports`)
    return reports
  }

  private async collectFcdo(reports: IntelReport[]): Promise<void> {
    try {
      // UK FCDO RSS feed — travel advisories
      const text = await this.fetchText(
        'https://www.gov.uk/foreign-travel-advice.atom',
        { timeout: 15000 }
      )

      // Parse Atom XML manually (simple extraction)
      const entries = text.match(/<entry>[\s\S]*?<\/entry>/g) || []
      for (const entry of entries.slice(0, 20)) {
        const title = entry.match(/<title[^>]*>(.*?)<\/title>/)?.[1] || 'Unknown'
        const link = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/>/)?.[1] || ''
        const summary = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]?.replace(/<[^>]*>/g, '').trim() || ''
        const updated = entry.match(/<updated>(.*?)<\/updated>/)?.[1] || ''

        // Extract country from title (format: "Country - travel advice")
        const country = title.replace(/ - travel advice$/i, '').trim()
        const coords = COUNTRY_COORDS[country]

        // Determine severity from summary content
        let level = 1
        if (/advise against all travel/i.test(summary)) level = 4
        else if (/advise against all but essential/i.test(summary)) level = 3
        else if (/heightened risk|increased caution/i.test(summary)) level = 2

        reports.push(this.createReport({
          title: `UK FCDO: ${country} — ${LEVEL_NAMES[level] || 'Advisory'}`,
          content: `**Country**: ${country}\n**Advisory Level**: ${level} (${LEVEL_NAMES[level]})\n**Source**: UK Foreign, Commonwealth & Development Office\n**Updated**: ${updated}\n\n${summary.slice(0, 500)}`,
          severity: advisorySeverity(level),
          sourceUrl: link || `https://www.gov.uk/foreign-travel-advice/${country.toLowerCase().replace(/\s+/g, '-')}`,
          sourceName: 'UK FCDO',
          latitude: coords?.[0],
          longitude: coords?.[1],
          verificationScore: 95
        }))
      }
    } catch (err) {
      log.debug(`FCDO advisories failed: ${err}`)
    }
  }

  private async collectDfat(reports: IntelReport[]): Promise<void> {
    try {
      // Australia DFAT Smartraveller RSS
      const text = await this.fetchText(
        'https://www.smartraveller.gov.au/api/v2/destinations/feed',
        { timeout: 15000 }
      )

      const items = text.match(/<item>[\s\S]*?<\/item>/g) || []
      for (const item of items.slice(0, 20)) {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
          || item.match(/<title>(.*?)<\/title>/)?.[1] || 'Unknown'
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || ''
        const desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
          || item.match(/<description>(.*?)<\/description>/)?.[1] || ''
        const cleanDesc = desc.replace(/<[^>]*>/g, '').trim()

        const country = title.trim()
        const coords = COUNTRY_COORDS[country]

        let level = 1
        if (/do not travel/i.test(cleanDesc)) level = 4
        else if (/reconsider your need/i.test(cleanDesc)) level = 3
        else if (/exercise a high degree of caution/i.test(cleanDesc)) level = 2

        reports.push(this.createReport({
          title: `AU DFAT: ${country} — ${LEVEL_NAMES[level] || 'Advisory'}`,
          content: `**Country**: ${country}\n**Advisory Level**: ${level} (${LEVEL_NAMES[level]})\n**Source**: Australian DFAT Smartraveller\n\n${cleanDesc.slice(0, 500)}`,
          severity: advisorySeverity(level),
          sourceUrl: link || `https://www.smartraveller.gov.au/destinations/${country.toLowerCase().replace(/\s+/g, '-')}`,
          sourceName: 'AU DFAT',
          latitude: coords?.[0],
          longitude: coords?.[1],
          verificationScore: 95
        }))
      }
    } catch (err) {
      log.debug(`DFAT advisories failed: ${err}`)
    }
  }
}
