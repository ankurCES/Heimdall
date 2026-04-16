import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import type { DarkWebConfig } from '@common/types/settings'
import log from 'electron-log'

/**
 * Ahmia (https://ahmia.fi) — clearnet search engine for indexed .onion
 * sites. No API key, no Tor required. Returns a JSON list of onion URLs
 * + descriptions for a given search term.
 *
 * Each result becomes an intel_reports row tagged `darkweb` + `ahmia`.
 * The .onion URL is stored as source_url so the analyst can investigate
 * further via an OnionFeedCollector if Tor is configured.
 *
 * Watch terms come from the global DarkWebConfig.watchTerms list.
 * Per-source overrides supported via config.queries on the source row.
 */

const AHMIA_BASE = 'https://ahmia.fi/search/'

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
        // Ahmia returns HTML; the JSON API is at /search/?q=...&format=json
        const url = `${AHMIA_BASE}?q=${encodeURIComponent(term)}&format=json`
        const data = await this.fetchJson<Array<{
          title?: string
          url?: string
          description?: string
          updated_on?: string
        }>>(url)

        if (!Array.isArray(data)) {
          log.debug(`Ahmia: unexpected response shape for "${term}"`)
          continue
        }

        for (const hit of data.slice(0, 25)) {
          if (!hit.url || !hit.title) continue
          reports.push(this.createReport({
            title: `[DARKWEB] ${hit.title}`.slice(0, 250),
            content: `**Source**: Ahmia (${term})\n**Onion URL**: ${hit.url}\n**Updated**: ${hit.updated_on ?? 'unknown'}\n\n${hit.description ?? '(no description)'}`,
            severity: 'medium',
            sourceUrl: hit.url,
            sourceName: 'Ahmia',
            verificationScore: 40 // Dark-web indexed content is unverified by definition
          }))
        }

        log.debug(`Ahmia: "${term}" — ${data.length} hits`)
      } catch (err) {
        log.warn(`Ahmia query failed for "${term}": ${(err as Error).message}`)
      }
    }

    return reports
  }
}
