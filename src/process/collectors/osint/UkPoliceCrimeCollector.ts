import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// UK Police API — free, no auth
// Docs: https://data.police.uk/docs/
const UK_POLICE_API = 'https://data.police.uk/api'

interface UkCrime {
  category: string
  location_type: string
  location: {
    latitude: string
    longitude: string
    street: { id: number; name: string }
  }
  context: string
  outcome_status: { category: string; date: string } | null
  month: string
  id: number
}

export class UkPoliceCrimeCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'uk-police-crime'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const forces = this.getForces()

    for (const force of forces) {
      try {
        // Get crimes for the force area (last available month)
        const crimes = await this.fetchJson<UkCrime[]>(
          `${UK_POLICE_API}/crimes-no-location?category=all-crime&force=${force}`,
          { timeout: 15000 }
        )

        if (!crimes || crimes.length === 0) continue

        // Aggregate by category
        const byCategory: Record<string, number> = {}
        for (const crime of crimes) {
          byCategory[crime.category] = (byCategory[crime.category] || 0) + 1
        }

        const catSummary = Object.entries(byCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, count]) => `- **${cat.replace(/-/g, ' ')}**: ${count}`)
          .join('\n')

        reports.push(
          this.createReport({
            title: `UK Police: ${force} Crime Summary`,
            content: `**Force**: ${force}\n**Total Crimes**: ${crimes.length}\n**Month**: ${crimes[0]?.month || 'latest'}\n\n## By Category\n${catSummary}`,
            severity: crimes.length > 1000 ? 'high' : crimes.length > 500 ? 'medium' : 'low',
            sourceUrl: `https://data.police.uk/`,
            sourceName: `UK Police (${force})`,
            verificationScore: 95
          })
        )
      } catch (err) {
        log.debug(`UK Police failed for ${force}: ${err}`)
      }
    }

    // Also get street-level crimes for specific locations
    const locations = this.getLocations()
    for (const loc of locations) {
      try {
        const crimes = await this.fetchJson<UkCrime[]>(
          `${UK_POLICE_API}/crimes-street/all-crime?lat=${loc.lat}&lng=${loc.lng}`,
          { timeout: 15000 }
        )

        if (!crimes || crimes.length === 0) continue

        for (const crime of crimes.slice(0, 10)) {
          const lat = crime.location?.latitude ? parseFloat(crime.location.latitude) : loc.lat
          const lng = crime.location?.longitude ? parseFloat(crime.location.longitude) : loc.lng

          reports.push(
            this.createReport({
              title: `UK Crime: ${crime.category.replace(/-/g, ' ')} — ${crime.location?.street?.name || loc.name}`,
              content: `**Category**: ${crime.category.replace(/-/g, ' ')}\n**Location**: ${crime.location?.street?.name || 'Unknown'}\n**Month**: ${crime.month}\n**Outcome**: ${crime.outcome_status?.category || 'Under investigation'}`,
              severity: this.categorySeverity(crime.category),
              sourceName: `UK Police Street Crime`,
              sourceUrl: `https://www.police.uk/`,
              latitude: lat,
              longitude: lng,
              verificationScore: 90
            })
          )
        }
      } catch (err) {
        log.debug(`UK Police street crime failed for ${loc.name}: ${err}`)
      }
    }

    log.info(`UK Police: ${reports.length} crime reports`)
    return reports
  }

  private getForces(): string[] {
    const custom = this.sourceConfig?.config?.forces as string[] | undefined
    return custom && custom.length > 0 ? custom : ['metropolitan', 'west-midlands', 'greater-manchester']
  }

  private getLocations(): Array<{ name: string; lat: number; lng: number }> {
    const custom = this.sourceConfig?.config?.locations as Array<{ name: string; lat: number; lng: number }> | undefined
    return custom && custom.length > 0 ? custom : [
      { name: 'London', lat: 51.5074, lng: -0.1278 },
      { name: 'Manchester', lat: 53.4808, lng: -2.2426 }
    ]
  }

  private categorySeverity(category: string): ThreatLevel {
    if (['violent-crime', 'robbery', 'possession-of-weapons'].includes(category)) return 'high'
    if (['burglary', 'vehicle-crime', 'drugs'].includes(category)) return 'medium'
    return 'low'
  }
}
