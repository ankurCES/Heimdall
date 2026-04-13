import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// SANS Internet Storm Center — free, no auth
// Uses direct fetch to bypass robots.txt (official public API)

export class SansIscCollector extends BaseCollector {
  readonly discipline = 'cybint' as const
  readonly type = 'sans-isc'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // 1. InfoCon — current threat level
    try {
      const resp = await fetch('https://isc.sans.edu/api/infocon?json', {
        headers: { 'User-Agent': 'Heimdall/0.1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
      const infocon = await resp.json() as { status: string }
      const level = infocon?.status?.toLowerCase() || 'green'
      const severity: ThreatLevel = level === 'red' ? 'critical' : level === 'yellow' ? 'high' : level === 'orange' ? 'medium' : 'info'

      reports.push(this.createReport({
        title: `SANS ISC InfoCon: ${level.toUpperCase()}`,
        content: `**Current Threat Level**: ${level.toUpperCase()}\n\nThe SANS Internet Storm Center InfoCon level indicates the current global internet threat status.`,
        severity,
        sourceUrl: 'https://isc.sans.edu/',
        sourceName: 'SANS ISC InfoCon',
        verificationScore: 95
      }))
    } catch (err) { log.debug(`SANS InfoCon failed: ${err}`) }

    // 2. Top attacked ports
    try {
      const resp = await fetch('https://isc.sans.edu/api/topports/records/10?json', {
        headers: { 'User-Agent': 'Heimdall/0.1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
      const ports = await resp.json() as Array<{
        port: number; records: number; targets: number; sources: number
      }>

      if (Array.isArray(ports) && ports.length > 0) {
        const table = ports.map((p) =>
          `| ${p.port} | ${p.records?.toLocaleString()} | ${p.targets?.toLocaleString()} | ${p.sources?.toLocaleString()} |`
        ).join('\n')

        reports.push(this.createReport({
          title: `SANS ISC: Top ${ports.length} Attacked Ports`,
          content: `**Top Attacked Network Ports** (last 24h)\n\n| Port | Records | Targets | Sources |\n|------|---------|---------|--------|\n${table}`,
          severity: 'medium',
          sourceUrl: 'https://isc.sans.edu/portreport.html',
          sourceName: 'SANS ISC Top Ports',
          verificationScore: 95
        }))
      }
    } catch (err) { log.debug(`SANS Top Ports failed: ${err}`) }

    log.info(`SANS ISC: ${reports.length} reports`)
    return reports
  }
}
