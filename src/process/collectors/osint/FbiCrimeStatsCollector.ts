import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

// FBI Crime Data Explorer API — free with data.gov API key
// Docs: https://crime-data-api.fr.cloud.gov/swagger-ui/
const FBI_CRIME_API = 'https://api.usa.gov/crime/fbi/sapi'

export class FbiCrimeStatsCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'fbi-crime-stats'

  async collect(): Promise<IntelReport[]> {
    const apiKey = settingsService.get<string>('apikeys.datagov')
    if (!apiKey) {
      log.debug('FbiCrimeStats: no data.gov API key configured')
      return []
    }

    const reports: IntelReport[] = []
    const states = this.getStates()

    for (const state of states) {
      try {
        // Get recent crime estimates by state
        const data = await this.fetchJson<{
          results: Array<{
            state_abbr: string
            year: number
            population: number
            violent_crime: number
            homicide: number
            robbery: number
            aggravated_assault: number
            property_crime: number
            burglary: number
            larceny: number
            motor_vehicle_theft: number
          }>
        }>(`${FBI_CRIME_API}/api/estimates/states/${state}?api_key=${apiKey}`, { timeout: 15000 })

        const latest = data.results?.[0]
        if (!latest) continue

        const severity = this.classifySeverity(latest)

        reports.push(
          this.createReport({
            title: `FBI Crime Stats: ${state} (${latest.year})`,
            content: `**State**: ${latest.state_abbr}\n**Year**: ${latest.year}\n**Population**: ${latest.population?.toLocaleString()}\n\n` +
              `## Violent Crime\n- **Total**: ${latest.violent_crime?.toLocaleString()}\n- **Homicide**: ${latest.homicide?.toLocaleString()}\n- **Robbery**: ${latest.robbery?.toLocaleString()}\n- **Aggravated Assault**: ${latest.aggravated_assault?.toLocaleString()}\n\n` +
              `## Property Crime\n- **Total**: ${latest.property_crime?.toLocaleString()}\n- **Burglary**: ${latest.burglary?.toLocaleString()}\n- **Larceny**: ${latest.larceny?.toLocaleString()}\n- **Motor Vehicle Theft**: ${latest.motor_vehicle_theft?.toLocaleString()}`,
            severity,
            sourceUrl: `https://cde.ucr.cjis.gov/LATEST/webapp/#/pages/explorer/crime/crime-trend`,
            sourceName: 'FBI Crime Data Explorer',
            verificationScore: 95
          })
        )
      } catch (err) {
        log.debug(`FBI Crime Stats failed for ${state}: ${err}`)
      }
    }

    log.info(`FBI Crime Stats: ${reports.length} state reports`)
    return reports
  }

  private getStates(): string[] {
    const custom = this.sourceConfig?.config?.states as string[] | undefined
    return custom && custom.length > 0 ? custom : ['CA', 'TX', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI']
  }

  private classifySeverity(data: Record<string, number>): ThreatLevel {
    const homicideRate = (data.homicide || 0) / (data.population || 1) * 100000
    if (homicideRate > 10) return 'critical'
    if (homicideRate > 5) return 'high'
    if (homicideRate > 2) return 'medium'
    return 'low'
  }
}
