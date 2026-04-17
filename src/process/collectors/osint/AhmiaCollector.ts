import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import { ahmiaSearch } from '../../services/darkweb/AhmiaClient'
import type { DarkWebConfig } from '@common/types/settings'
import log from 'electron-log'

/**
 * Ahmia (https://ahmia.fi) — clearnet search engine for indexed .onion
 * sites. No API key, no Tor required. Each result becomes an intel_reports
 * row tagged `darkweb` + `ahmia`. The .onion URL is stored as source_url so
 * the analyst can investigate further via an OnionFeedCollector if Tor is
 * configured.
 *
 * Watch terms come from the global DarkWebConfig.watchTerms list.
 * Per-source overrides supported via config.queries on the source row.
 *
 * The actual search transport (token-based HTML scrape after Ahmia removed
 * their JSON API) lives in services/darkweb/AhmiaClient.ts so the chat
 * `ahmia_search` tool and this collector share one implementation.
 */
export class AhmiaCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'ahmia'

  async collect(): Promise<IntelReport[]> {
    const dw = settingsService.get<DarkWebConfig>('darkWeb')
    if (!dw?.ahmiaEnabled) return []

    const cfgQueries = (this.sourceConfig?.config?.queries as string[] | undefined) ?? []
    const queries = cfgQueries.length > 0 ? cfgQueries : (dw.watchTerms ?? [])
    if (queries.length === 0) return []

    const reports: IntelReport[] = []
    for (const term of queries.slice(0, 10)) {
      try {
        const hits = await ahmiaSearch(term, 25)
        for (const hit of hits) {
          reports.push(this.createReport({
            title: `[DARKWEB] ${hit.title}`.slice(0, 250),
            content: `**Source**: Ahmia (${term})\n**Onion URL**: ${hit.onionUrl}\n**Last seen**: ${hit.lastSeen ?? 'unknown'}\n\n${hit.description}`,
            severity: 'medium',
            sourceUrl: hit.onionUrl,
            sourceName: 'Ahmia',
            verificationScore: 40 // Dark-web indexed content is unverified by definition
          }))
        }
        log.debug(`Ahmia: "${term}" — ${hits.length} hits`)
      } catch (err) {
        log.warn(`Ahmia query failed for "${term}": ${(err as Error).message}`)
      }
    }

    return reports
  }
}
