import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// arXiv API — free, no auth required
// Docs: https://info.arxiv.org/help/api/index.html
const ARXIV_API = 'https://export.arxiv.org/api/query'

export class AcademicCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'academic'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []
    const categories = this.getCategories()

    for (const category of categories) {
      try {
        const query = `cat:${category}&sortBy=submittedDate&sortOrder=descending&max_results=15`
        const xml = await this.fetchText(`${ARXIV_API}?search_query=${query}`)
        const entries = this.parseAtom(xml)

        for (const entry of entries) {
          reports.push(
            this.createReport({
              title: entry.title,
              content: `**Authors**: ${entry.authors}\n**Category**: ${category}\n**Published**: ${entry.published}\n\n${entry.summary}`,
              severity: 'info',
              sourceUrl: entry.link,
              sourceName: `arXiv (${category})`,
              verificationScore: 85 // Peer-adjacent academic work
            })
          )
        }

        log.debug(`arXiv: ${category} — ${entries.length} papers`)
      } catch (err) {
        log.warn(`arXiv fetch failed for ${category}: ${err}`)
      }
    }

    return reports
  }

  private getCategories(): string[] {
    const custom = this.sourceConfig?.config?.categories as string[] | undefined
    return custom && custom.length > 0
      ? custom
      : ['cs.CR', 'cs.AI'] // Cryptography/Security, AI
  }

  private parseAtom(xml: string): Array<{
    title: string
    summary: string
    link: string
    authors: string
    published: string
  }> {
    const results: Array<{
      title: string
      summary: string
      link: string
      authors: string
      published: string
    }> = []

    // Simple regex-based XML parsing (arXiv returns Atom format)
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
    let match: RegExpExecArray | null

    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1]

      const title = this.extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim()
      const summary = this.extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim()
      const published = this.extractTag(entry, 'published')
      const link = this.extractAttr(entry, 'link', 'href', 'title="pdf"') ||
        this.extractAttr(entry, 'link', 'href', 'rel="alternate"') || ''

      // Extract authors
      const authorRegex = /<author>\s*<name>(.*?)<\/name>\s*<\/author>/g
      const authors: string[] = []
      let authorMatch: RegExpExecArray | null
      while ((authorMatch = authorRegex.exec(entry)) !== null) {
        authors.push(authorMatch[1])
      }

      if (title && summary) {
        results.push({
          title,
          summary: summary.slice(0, 2000),
          link,
          authors: authors.join(', ') || 'Unknown',
          published: published || 'Unknown'
        })
      }
    }

    return results
  }

  private extractTag(xml: string, tag: string): string | null {
    const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's')
    const match = regex.exec(xml)
    return match ? match[1] : null
  }

  private extractAttr(xml: string, tag: string, attr: string, filter?: string): string | null {
    const filterStr = filter ? `[^>]*${filter}` : ''
    const regex = new RegExp(`<${tag}${filterStr}[^>]*${attr}="([^"]*)"`, 's')
    const match = regex.exec(xml)
    return match ? match[1] : null
  }
}
