// MastodonCollector — v1.4.1 federated SOCMINT firehose.
//
// Polls a configurable Mastodon instance's public + hashtag timelines.
// No auth required by default (public timeline is open) — instance
// admins may rate-limit anonymous clients to ~300 req / 5min, which
// is well within our default 5-minute schedule.
//
// Why Mastodon:
//   - Federated, so a single instance (mastodon.social by default)
//     surfaces posts from across the fediverse.
//   - Open API, no key gates, no scraping fragility.
//   - Strong adoption among researchers, security pros, and dissident
//     communities — exactly the OSINT signal we want post-Twitter.
//
// Configurable per source:
//   - instance:  e.g. "mastodon.social", "infosec.exchange", "ioc.exchange"
//   - hashtags:  array, e.g. ["infosec","threatintel","opsec"]
//   - includePublic: also pull the federated public timeline
//   - keywords:  client-side substring filter (case-insensitive)
//   - accessToken: optional — bumps anonymous rate limits + unlocks
//     status search via /api/v2/search

import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { settingsService } from '../../services/settings/SettingsService'
import log from 'electron-log'

interface MastodonAccount {
  id: string
  username: string
  acct: string                      // "user" or "user@otherinstance"
  display_name: string
  url: string
  followers_count?: number
}

interface MastodonStatus {
  id: string
  created_at: string
  url: string | null
  uri: string
  account: MastodonAccount
  content: string                   // HTML
  language: string | null
  reblogs_count: number
  favourites_count: number
  replies_count: number
  tags: Array<{ name: string; url: string }>
  media_attachments?: Array<{ type: string; url: string; preview_url?: string }>
  sensitive?: boolean
  spoiler_text?: string
}

interface MastodonConfig {
  instance?: string
  hashtags?: string[]
  includePublic?: boolean
  keywords?: string[]
  accessToken?: string
  perTagLimit?: number
  publicLimit?: number
}

const DEFAULT_INSTANCE = 'mastodon.social'
const DEFAULT_HASHTAGS = ['infosec', 'threatintel', 'cybersecurity', 'breaking']
const DEFAULT_PER_TAG = 40
const DEFAULT_PUBLIC = 40
const MAX_PER_RUN = 200             // cap per collect() to bound LLM enrichment cost

const CRITICAL_KEYWORDS = [
  'breaking', 'explosion', 'mass shooting', 'terrorist attack', 'active shooter',
  'critical infrastructure', 'critical vulnerability', 'zero-day', 'ransomware'
]
const HIGH_KEYWORDS = [
  'attack', 'bombing', 'hostage', 'evacuate', 'data breach', 'leak',
  'exploit released', 'supply chain', 'malware'
]

export class MastodonCollector extends BaseCollector {
  readonly discipline = 'socmint' as const
  readonly type = 'mastodon'

  async collect(): Promise<IntelReport[]> {
    const cfg = (this.sourceConfig?.config || {}) as MastodonConfig
    const instance = (cfg.instance || DEFAULT_INSTANCE).replace(/^https?:\/\//, '').replace(/\/+$/, '')
    const hashtags = cfg.hashtags && cfg.hashtags.length ? cfg.hashtags : DEFAULT_HASHTAGS
    const includePublic = cfg.includePublic !== false   // default on
    const perTagLimit = Math.min(cfg.perTagLimit ?? DEFAULT_PER_TAG, 40)
    const publicLimit = Math.min(cfg.publicLimit ?? DEFAULT_PUBLIC, 40)
    const keywordFilter = (cfg.keywords || []).map((k) => k.toLowerCase()).filter(Boolean)
    const token = cfg.accessToken || settingsService.get<string>('apikeys.mastodon')

    const headers: Record<string, string> = {
      'User-Agent': 'Heimdall/1.4 (intel-collector)',
      Accept: 'application/json'
    }
    if (token) headers.Authorization = `Bearer ${token}`

    const seen = new Set<string>()
    const reports: IntelReport[] = []

    // 1. Public federated timeline (drops local-only posts via remote=true)
    if (includePublic) {
      try {
        const url = `https://${instance}/api/v1/timelines/public?remote=true&limit=${publicLimit}`
        const data = await this.fetchJson<MastodonStatus[]>(url, { headers })
        if (Array.isArray(data)) {
          for (const s of data) this.collectIfMatch(s, keywordFilter, seen, reports, 'federated')
        }
      } catch (err) {
        log.warn(`Mastodon: federated timeline ${instance} failed: ${err}`)
      }
    }

    // 2. Per-hashtag timelines
    for (const tag of hashtags) {
      if (reports.length >= MAX_PER_RUN) break
      const cleanTag = tag.replace(/^#/, '').trim()
      if (!cleanTag) continue
      try {
        const url = `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(cleanTag)}?limit=${perTagLimit}`
        const data = await this.fetchJson<MastodonStatus[]>(url, { headers })
        if (Array.isArray(data)) {
          for (const s of data) this.collectIfMatch(s, keywordFilter, seen, reports, `#${cleanTag}`)
        }
        log.debug(`Mastodon: #${cleanTag} on ${instance} → ${Array.isArray(data) ? data.length : 0} statuses`)
      } catch (err) {
        log.warn(`Mastodon: hashtag #${cleanTag} on ${instance} failed: ${err}`)
      }
    }

    log.info(`Mastodon: ${instance} → ${reports.length} report(s) from ${hashtags.length} hashtag(s)${includePublic ? ' + federated' : ''}`)
    return reports.slice(0, MAX_PER_RUN)
  }

  private collectIfMatch(
    s: MastodonStatus,
    keywordFilter: string[],
    seen: Set<string>,
    out: IntelReport[],
    queryLabel: string
  ): void {
    if (!s || !s.id || seen.has(s.id)) return
    seen.add(s.id)

    const text = htmlToText(s.content)
    if (!text || text.length < 20) return

    if (keywordFilter.length) {
      const low = text.toLowerCase()
      const hit = keywordFilter.some((k) => low.includes(k))
      if (!hit) return
    }

    const engagement = (s.reblogs_count ?? 0) + (s.favourites_count ?? 0) + (s.replies_count ?? 0)
    const severity = classifySeverity(text, engagement)
    const author = s.account?.acct ? `@${s.account.acct}` : (s.account?.username ?? 'unknown')
    const tagList = (s.tags || []).map((t) => `#${t.name}`).join(' ')
    const media = (s.media_attachments || []).filter(m => m.url).slice(0, 4)
      .map((m) => `- ${m.type}: ${m.url}`).join('\n')

    const sourceUrl = s.url || s.uri || `https://${this.sourceConfig?.config?.instance || DEFAULT_INSTANCE}/web/statuses/${s.id}`
    const titlePrefix = s.sensitive && s.spoiler_text ? `[CW: ${s.spoiler_text}] ` : ''

    out.push(this.createReport({
      title: `Mastodon: ${titlePrefix}${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
      content: [
        `**Author**: ${author}${s.account?.display_name ? ` (${s.account.display_name})` : ''}`,
        `**Posted**: ${s.created_at}`,
        `**Engagement**: ${engagement} (boosts ${s.reblogs_count ?? 0}, favs ${s.favourites_count ?? 0}, replies ${s.replies_count ?? 0})`,
        `**Source query**: ${queryLabel}`,
        `**Language**: ${s.language || '—'}`,
        tagList ? `**Tags**: ${tagList}` : null,
        media ? `**Media**:\n${media}` : null,
        '',
        text
      ].filter(Boolean).join('\n'),
      severity,
      sourceUrl,
      sourceName: 'Mastodon',
      verificationScore: 30   // social media floor; AutoVerificationService boosts
    }))
  }
}

function htmlToText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function classifySeverity(text: string, engagement: number): ThreatLevel {
  const low = text.toLowerCase()
  for (const kw of CRITICAL_KEYWORDS) {
    if (low.includes(kw)) return 'critical'
  }
  for (const kw of HIGH_KEYWORDS) {
    if (low.includes(kw)) return engagement > 50 ? 'high' : 'medium'
  }
  return engagement > 200 ? 'medium' : 'low'
}
