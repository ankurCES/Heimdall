import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import * as cheerio from 'cheerio'
import log from 'electron-log'

// OFAC SDN (Specially Designated Nationals) — free, no auth
// UN Security Council Consolidated List — free, no auth
const OFAC_SDN_CSV = 'https://www.treasury.gov/ofac/downloads/sdn.csv'
const OFAC_RECENT_ACTIONS = 'https://www.treasury.gov/resource-center/sanctions/OFAC-Enforcement/Pages/OFAC-Recent-Actions.aspx'
const UN_CONSOLIDATED_XML = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml'

export class SanctionsCollector extends BaseCollector {
  readonly discipline = 'finint' as const
  readonly type = 'sanctions'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    // OFAC Recent Actions (scrape page for latest updates)
    const ofacReports = await this.collectOfacRecent()
    reports.push(...ofacReports)

    // UN Sanctions consolidated list updates
    const unReports = await this.collectUnSanctions()
    reports.push(...unReports)

    return reports
  }

  private async collectOfacRecent(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const html = await this.fetchText(OFAC_RECENT_ACTIONS)
      const $ = cheerio.load(html)

      // Parse recent actions table
      $('table tr').slice(0, 20).each((_, row) => {
        const cells = $(row).find('td')
        if (cells.length < 3) return

        const date = $(cells[0]).text().trim()
        const action = $(cells[1]).text().trim()
        const link = $(cells[1]).find('a').attr('href')
        const details = $(cells[2]).text().trim()

        if (!date || !action) return

        reports.push(
          this.createReport({
            title: `OFAC Action: ${action.slice(0, 100)}`,
            content: `**Date**: ${date}\n**Action**: ${action}\n**Details**: ${details}`,
            severity: 'medium',
            sourceUrl: link ? `https://www.treasury.gov${link}` : 'https://www.treasury.gov/ofac',
            sourceName: 'OFAC',
            verificationScore: 95
          })
        )
      })

      log.debug(`OFAC: ${reports.length} recent actions`)
    } catch (err) {
      log.warn(`OFAC recent actions failed: ${err}`)
    }

    return reports
  }

  private async collectUnSanctions(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const xml = await this.fetchText(UN_CONSOLIDATED_XML, { timeout: 60000 })

      // Parse individuals from UN consolidated list — latest entries
      const individualRegex = /<INDIVIDUAL>([\s\S]*?)<\/INDIVIDUAL>/g
      let match: RegExpExecArray | null
      let count = 0

      while ((match = individualRegex.exec(xml)) !== null && count < 20) {
        const entry = match[1]
        const name = this.extractXmlTag(entry, 'FIRST_NAME') + ' ' + this.extractXmlTag(entry, 'SECOND_NAME')
        const listType = this.extractXmlTag(entry, 'UN_LIST_TYPE')
        const referenceNumber = this.extractXmlTag(entry, 'REFERENCE_NUMBER')
        const listedOn = this.extractXmlTag(entry, 'LISTED_ON')
        const comments = this.extractXmlTag(entry, 'COMMENTS1')
        const nationality = this.extractXmlTag(entry, 'NATIONALITY')

        if (!name.trim()) continue

        reports.push(
          this.createReport({
            title: `UN Sanctions: ${name.trim()}`,
            content: `**Name**: ${name.trim()}\n**List**: ${listType || 'Unknown'}\n**Reference**: ${referenceNumber || 'N/A'}\n**Listed On**: ${listedOn || 'Unknown'}\n**Nationality**: ${nationality || 'Unknown'}\n\n${comments || 'No additional comments'}`,
            severity: 'high',
            sourceUrl: 'https://www.un.org/securitycouncil/sanctions/information',
            sourceName: 'UN Security Council Sanctions',
            verificationScore: 95
          })
        )
        count++
      }

      log.debug(`UN Sanctions: ${count} individuals parsed`)
    } catch (err) {
      log.warn(`UN sanctions collection failed: ${err}`)
    }

    return reports
  }

  private extractXmlTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's')
    const match = regex.exec(xml)
    return match ? match[1].trim() : ''
  }
}
