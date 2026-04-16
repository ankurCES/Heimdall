import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import type { DarkWebConfig } from '@common/types/settings'
import log from 'electron-log'

/**
 * DarkSearch.io — clearnet REST API for indexed onion content. Free
 * tier is no-auth but rate-limited to ~30 requests/day, so this
 * collector is conservative: at most one query per term per run, with
 * a small delay between calls.
 *
 * Endpoint: https://darksearch.io/api/search?query=<term>&page=1
 */

const DARKSEARCH_BASE = 'https://darksearch.io/api/search'

interface DarkSearchHit {
  title?: string
  link?: string
  description?: string
}

interface DarkSearchResponse {
  data?: DarkSearchHit[]
  total?: number
}

export class DarkSearchCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'darksearch'

  async collect(): Promise<IntelReport[]> {
    const dw = settingsService.get<DarkWebConfig>('darkWeb')
    if (!dw?.darkSearchEnabled) return []

    const cfgQueries = (this.sourceConfig?.config?.queries as string[] | undefined) ?? []
    const queries = cfgQueries.length > 0 ? cfgQueries : (dw.watchTerms ?? [])
    if (queries.length === 0) return []

    const reports: IntelReport[] = []
    // Conservative: max 5 terms per run to stay under the 30/day cap.
    for (const term of queries.slice(0, 5)) {
      try {
        const url = `${DARKSEARCH_BASE}?query=${encodeURIComponent(term)}&page=1`
        const data = await this.fetchJson<DarkSearchResponse>(url)
        const hits = data.data ?? []

        for (const hit of hits.slice(0, 20)) {
          if (!hit.link || !hit.title) continue
          reports.push(this.createReport({
            title: `[DARKWEB] ${hit.title}`.slice(0, 250),
            content: `**Source**: DarkSearch.io (${term})\n**Onion URL**: ${hit.link}\n\n${hit.description ?? '(no description)'}`,
            severity: 'medium',
            sourceUrl: hit.link,
            sourceName: 'DarkSearch',
            verificationScore: 40
          }))
        }
        log.debug(`DarkSearch: "${term}" — ${hits.length} hits`)
        // Small delay between rate-limited calls.
        await new Promise((r) => setTimeout(r, 1500))
      } catch (err) {
        log.warn(`DarkSearch query failed for "${term}": ${(err as Error).message}`)
      }
    }

    return reports
  }
}
