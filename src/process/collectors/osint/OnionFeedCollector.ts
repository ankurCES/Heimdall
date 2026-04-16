import { BaseCollector } from '../BaseCollector'
import type { IntelReport } from '@common/types/intel'
import * as cheerio from 'cheerio'
import log from 'electron-log'

/**
 * Generic .onion fetcher. The user configures one source row per
 * onion URL via the existing Sources page, choosing `kind` = `html` or
 * `json`. SafeFetcher routes .onion hostnames through the configured
 * Tor SOCKS5 proxy automatically.
 *
 * For HTML feeds we extract every <a> with text content and the title
 * tag — sufficient to produce searchable intel without per-site parsing.
 * For JSON feeds we ingest the raw payload as a single intel report.
 *
 * config.url:        full .onion URL (required)
 * config.kind:       'html' | 'json' (default 'html')
 * config.titleSel:   optional CSS selector for the title (HTML only)
 */

interface OnionConfig {
  url?: string
  kind?: 'html' | 'json'
  titleSel?: string
}

export class OnionFeedCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'onion-feed'

  async collect(): Promise<IntelReport[]> {
    const cfg = (this.sourceConfig?.config ?? {}) as OnionConfig
    const url = cfg.url
    if (!url) {
      log.warn(`OnionFeedCollector: no url configured for ${this.sourceConfig?.name ?? '(unknown)'}`)
      return []
    }
    if (!url.includes('.onion')) {
      log.warn(`OnionFeedCollector: refusing non-.onion URL ${url}`)
      return []
    }

    try {
      if (cfg.kind === 'json') {
        const data = await this.fetchJson<unknown>(url)
        return [this.createReport({
          title: `[DARKWEB] ${this.sourceConfig?.name ?? 'Onion feed'}`,
          content: `**Onion URL**: ${url}\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 8000)}\n\`\`\``,
          severity: 'medium',
          sourceUrl: url,
          sourceName: this.sourceConfig?.name ?? 'Onion feed',
          verificationScore: 35
        })]
      }

      // HTML path
      const html = await this.fetchText(url)
      const $ = cheerio.load(html)
      const pageTitle = (cfg.titleSel ? $(cfg.titleSel).first().text() : $('title').first().text()).trim()
      const links: Array<{ text: string; href: string }> = []
      $('a').each((_i, el) => {
        const text = $(el).text().trim()
        const href = $(el).attr('href')
        if (text && href && text.length >= 4) links.push({ text: text.slice(0, 200), href })
      })

      const summary = links.slice(0, 30).map((l) => `- [${l.text}](${l.href})`).join('\n')
      return [this.createReport({
        title: `[DARKWEB] ${pageTitle || this.sourceConfig?.name || 'Onion feed'}`.slice(0, 250),
        content: `**Onion URL**: ${url}\n**Page title**: ${pageTitle || '(none)'}\n**Link count**: ${links.length}\n\n## Top links\n${summary}`,
        severity: 'medium',
        sourceUrl: url,
        sourceName: this.sourceConfig?.name ?? 'Onion feed',
        verificationScore: 35
      })]
    } catch (err) {
      log.warn(`OnionFeedCollector: fetch failed for ${url}: ${(err as Error).message}`)
      return []
    }
  }
}
