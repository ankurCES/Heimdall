import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// NVD CVE API v2 — free, no auth required (but rate limited to 5 req/30s without API key)
// Docs: https://nvd.nist.gov/developers/vulnerabilities
const NVD_API = 'https://services.nvd.nist.gov/rest/json/cves/2.0'

interface NvdCve {
  id: string
  descriptions: Array<{ lang: string; value: string }>
  metrics?: {
    cvssMetricV31?: Array<{
      cvssData: { baseScore: number; baseSeverity: string }
    }>
    cvssMetricV2?: Array<{
      cvssData: { baseScore: number }
    }>
  }
  references?: Array<{ url: string; source: string }>
  published: string
  lastModified: string
}

interface NvdResponse {
  totalResults: number
  vulnerabilities: Array<{ cve: NvdCve }>
}

export class CveCollector extends BaseCollector {
  readonly discipline = 'cybint' as const
  readonly type = 'cve'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      // Get CVEs modified in the last 24 hours
      const now = new Date()
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

      const params = new URLSearchParams({
        lastModStartDate: yesterday.toISOString(),
        lastModEndDate: now.toISOString(),
        resultsPerPage: '50'
      })

      // Add keyword filter if configured
      const keywords = this.sourceConfig?.config?.keywords as string | undefined
      if (keywords) {
        params.set('keywordSearch', keywords)
      }

      const data = await this.fetchJson<NvdResponse>(
        `${NVD_API}?${params.toString()}`,
        { timeout: 30000 }
      )

      for (const vuln of data.vulnerabilities) {
        const cve = vuln.cve
        const description = cve.descriptions.find((d) => d.lang === 'en')?.value || 'No description'
        const cvss = this.getCvssScore(cve)
        const severity = this.cvssToSeverity(cvss)

        const refs = (cve.references || [])
          .slice(0, 5)
          .map((r) => `- [${r.source}](${r.url})`)
          .join('\n')

        reports.push(
          this.createReport({
            title: `${cve.id} (CVSS: ${cvss ?? 'N/A'})`,
            content: `**CVE ID**: ${cve.id}\n**CVSS Score**: ${cvss ?? 'Not scored'}\n**Published**: ${cve.published}\n**Modified**: ${cve.lastModified}\n\n${description}\n\n**References**:\n${refs || 'None'}`,
            severity,
            sourceUrl: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
            sourceName: 'NVD/CVE',
            verificationScore: 95 // Official government database
          })
        )
      }

      log.info(`CVE: collected ${data.vulnerabilities.length} of ${data.totalResults} total`)
    } catch (err) {
      log.error('CveCollector failed:', err)
    }

    return reports
  }

  private getCvssScore(cve: NvdCve): number | null {
    const v31 = cve.metrics?.cvssMetricV31?.[0]?.cvssData.baseScore
    if (v31 !== undefined) return v31

    const v2 = cve.metrics?.cvssMetricV2?.[0]?.cvssData.baseScore
    if (v2 !== undefined) return v2

    return null
  }

  private cvssToSeverity(score: number | null): ThreatLevel {
    if (score === null) return 'info'
    if (score >= 9.0) return 'critical'
    if (score >= 7.0) return 'high'
    if (score >= 4.0) return 'medium'
    if (score >= 0.1) return 'low'
    return 'info'
  }
}
