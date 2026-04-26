import { getDatabase } from '../database'
import { timestamp } from '@common/utils/id'
import { llmService } from '../llm/LlmService'
import log from 'electron-log'

/**
 * Dark-web specialised enrichment pipeline.
 *
 * Two-phase:
 *   A. Deterministic (regex + lexicon, ~10 ms) — IOC extraction, threat-
 *      actor lexicon match, activity classification, language hint, severity
 *      bumps. Runs on every new [DARKWEB] report.
 *   B. LLM tag generation (~2 s on small/fast routed model) — produces 5-10
 *      normalized prefixed tags (`darkweb:`, `actor:`, `marketplace:`,
 *      `victim:`, `tech:`).
 *
 * Output: rows in intel_tags with `source = 'darkweb-enrich'`. The chat
 * filter picker reads these to show a Dark Web filter section.
 *
 * Queue: at most ENRICHMENT_PARALLELISM jobs in flight at once. Idle drain
 * timer kicks pending items every 5s. Idempotent — skips reports already
 * enriched within the last 7 days.
 */

const ENRICHMENT_PARALLELISM = 5
const REENRICH_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const ENRICHMENT_VERSION_TAG = 'darkweb-enrich-v1' // bump if pipeline changes

/** Known threat-actor / ransomware-group lexicon. Conservative —
 *  whole-word match only to avoid false positives ("conti" → "continent"). */
const THREAT_ACTOR_LEXICON: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'LockBit',     pattern: /\blockbit\b/i },
  { name: 'ALPHV',       pattern: /\b(alphv|blackcat)\b/i },
  { name: 'Conti',       pattern: /\bconti\b/i },
  { name: 'Black Basta', pattern: /\bblack[-\s]?basta\b/i },
  { name: 'REvil',       pattern: /\brevil\b/i },
  { name: 'Clop',        pattern: /\b(clop|cl0p)\b/i },
  { name: 'Akira',       pattern: /\bakira\b/i },
  { name: 'Royal',       pattern: /\broyal[-\s]?ransomware\b/i },
  { name: 'BlackSuit',   pattern: /\bblacksuit\b/i },
  { name: 'Medusa',      pattern: /\bmedusa[-\s]?(blog|leak)?\b/i },
  { name: 'BianLian',    pattern: /\bbianlian\b/i },
  { name: 'Play',        pattern: /\bplay[-\s]?ransomware\b/i },
  { name: 'Rhysida',     pattern: /\brhysida\b/i },
  { name: 'NoEscape',    pattern: /\bnoescape\b/i },
  { name: 'INC Ransom',  pattern: /\binc[-\s]?ransom\b/i },
  { name: 'Hunters',     pattern: /\bhunters[-\s]?international\b/i },
  { name: 'Lazarus',     pattern: /\blazarus\b/i },
  { name: 'APT28',       pattern: /\bapt[-\s]?28\b/i },
  { name: 'APT29',       pattern: /\bapt[-\s]?29\b/i },
  { name: 'FIN7',        pattern: /\bfin7\b/i },
  { name: 'Lapsus$',     pattern: /\blapsus\$?\b/i },
  { name: 'ScatteredSpider', pattern: /\bscattered[-\s]?spider\b/i }
]

/** Activity classifier — keyword counts decide the dominant tag. */
const ACTIVITY_KEYWORDS: Record<string, RegExp[]> = {
  ransomware: [/\bransom(?:ware|payment|note|demand)\b/i, /\bdecrypt(?:ion|or)\b/i, /\bencrypt(?:ed|ion)\b/i, /\bvictim\b/i],
  leak:       [/\bleak(?:ed|s)?\b/i, /\bdump(?:ed|ing)?\b/i, /\bdatabase\b/i, /\bbreach(?:ed)?\b/i, /\bexfiltrat(?:ed|ion)\b/i],
  marketplace:[/\bmarketplace\b/i, /\bvendor\b/i, /\bproduct\b/i, /\bcart\b/i, /\bcheckout\b/i, /\bshipping\b/i, /\bescrow\b/i],
  forum:      [/\bforum\b/i, /\bthread\b/i, /\bviewtopic\b/i, /\bregister\b/i, /\busergroup\b/i, /\breply\b/i],
  blog:       [/\barticle\b/i, /\bblog\b/i, /\bnewsletter\b/i, /\bopinion\b/i, /\beditorial\b/i],
  c2:         [/\bc2\b/i, /\bcommand[-\s]?and[-\s]?control\b/i, /\bbeacon\b/i, /\bimplant\b/i],
  extortion:  [/\bextort(?:ion|ed|ing)\b/i, /\bpay(?:ment)?[-\s]?deadline\b/i, /\bcountdown\b/i, /\bauction\b/i],
  phishing:   [/\bphish(?:ing|ed|er)?\b/i, /\bsmishing\b/i, /\bvishing\b/i, /\bcredential[-\s]?harvest\b/i]
}

/** IOC extraction patterns. */
const IOC_PATTERNS = {
  // BTC: legacy P2PKH/P2SH (1/3) + bech32 (bc1)
  btc: /\b(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{8,87})\b/g,
  eth: /\b0x[a-fA-F0-9]{40}\b/g,
  // Monero: 95-char base58 starting with 4 (regular) or 8 (subaddress)
  xmr: /\b[48][1-9A-HJ-NP-Za-km-z]{94}\b/g,
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|\d?\d)\b/g,
  email: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  md5: /\b[a-f0-9]{32}\b/gi,
  sha1: /\b[a-f0-9]{40}\b/gi,
  sha256: /\b[a-f0-9]{64}\b/gi,
  cve: /\bCVE-\d{4}-\d{4,7}\b/gi,
  onion: /\b[a-z2-7]{16,56}\.onion\b/gi,
  telegram: /\b@[A-Za-z][A-Za-z0-9_]{4,31}\b/g,
  jabber: /\b[a-z0-9._-]+@(?:jabber|xmpp|exploit\.im|thesecure\.biz|jabb)\.[a-z.]+\b/gi
} as const

export interface ThreatRating {
  score: number    // 1-10 (1=benign, 10=critical active threat)
  label: string    // 'low' | 'medium' | 'high' | 'critical'
  rationale: string // 1-sentence explanation
}

export interface EnrichmentResult {
  reportId: string
  iocs: Array<{ type: string; value: string }>
  actors: string[]
  activities: string[]
  language: string | null
  llmTags: string[]
  threatRating: ThreatRating | null
  severityBumped: boolean
}

class DarkWebEnrichmentServiceImpl {
  private queue: string[] = []
  private inFlight = new Set<string>()
  private drainTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(s: { queued: number; inFlight: number; processedTotal: number }) => void>()
  private processedTotal = 0

  constructor() {
    // Idle drain every 5s. Cheap when queue is empty.
    this.drainTimer = setInterval(() => this.drain(), 5_000)
  }

  /** Add a report to the enrichment queue. Idempotent — already-queued or
   *  in-flight reports are skipped. The actual run happens asynchronously
   *  on the next drain tick or when capacity opens up. */
  enqueue(reportId: string): void {
    if (this.queue.includes(reportId) || this.inFlight.has(reportId)) return
    this.queue.push(reportId)
    this.emit()
    void this.drain()
  }

  /** Enqueue every [DARKWEB] report not enriched in the last 7 days. */
  enqueueUnenriched(): { queued: number } {
    const db = getDatabase()
    const threshold = timestamp() - REENRICH_AFTER_MS
    // Find [DARKWEB] reports whose latest darkweb-enrich tag is missing or stale.
    const rows = db.prepare(`
      SELECT r.id FROM intel_reports r
      WHERE r.title LIKE '[DARKWEB]%'
        AND NOT EXISTS (
          SELECT 1 FROM intel_tags t
          WHERE t.report_id = r.id
            AND t.tag = ?
            AND t.created_at > ?
        )
      LIMIT 5000
    `).all(ENRICHMENT_VERSION_TAG, threshold) as Array<{ id: string }>
    let added = 0
    for (const row of rows) {
      if (this.queue.includes(row.id) || this.inFlight.has(row.id)) continue
      this.queue.push(row.id)
      added++
    }
    this.emit()
    void this.drain()
    return { queued: added }
  }

  getStatus(): { queued: number; inFlight: number; processedTotal: number } {
    return { queued: this.queue.length, inFlight: this.inFlight.size, processedTotal: this.processedTotal }
  }

  onStatus(listener: (s: { queued: number; inFlight: number; processedTotal: number }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const s = this.getStatus()
    for (const l of this.listeners) {
      try { l(s) } catch { /* */ }
    }
  }

  private async drain(): Promise<void> {
    while (this.inFlight.size < ENRICHMENT_PARALLELISM && this.queue.length > 0) {
      const id = this.queue.shift()!
      this.inFlight.add(id)
      this.emit()
      // Fire and forget; success / error both come back here.
      void this.enrichOne(id)
        .catch((err) => log.warn(`DarkWebEnrich: ${id} failed: ${err}`))
        .finally(() => {
          this.inFlight.delete(id)
          this.processedTotal++
          this.emit()
        })
    }
  }

  /** Run the full pipeline on one report. */
  async enrichOne(reportId: string): Promise<EnrichmentResult | null> {
    const db = getDatabase()
    const row = db.prepare('SELECT id, title, content FROM intel_reports WHERE id = ?').get(reportId) as { id: string; title: string; content: string } | undefined
    if (!row) return null

    const text = (row.content || '').slice(0, 12000) // cap LLM input
    const result: EnrichmentResult = {
      reportId,
      iocs: this.extractIocs(text),
      actors: this.matchActors(text),
      activities: this.classifyActivities(text),
      language: this.detectLanguage(text),
      llmTags: [],
      threatRating: null,
      severityBumped: false
    }

    // Phase B: LLM tag generation + threat rating. Optional — if it fails
    // we still write the deterministic tags.
    try {
      const llmResult = await this.generateLlmTagsAndRating(row.title, text, result)
      result.llmTags = llmResult.tags
      result.threatRating = llmResult.rating
    } catch (err) {
      log.debug(`DarkWebEnrich LLM phase failed for ${reportId}: ${err}`)
    }

    // Severity update — use the LLM threat rating if available, otherwise
    // fall back to deterministic bump rules.
    const threatScore = result.threatRating?.score ?? 0
    let newSeverity: string | null = null
    if (threatScore >= 9)      newSeverity = 'critical'
    else if (threatScore >= 7) newSeverity = 'high'
    else if (threatScore >= 4) newSeverity = 'medium'
    else if (threatScore >= 1) newSeverity = 'low'

    // Deterministic escalation (additive — can only bump UP, never down).
    const cveCount = result.iocs.filter((i) => i.type === 'cve').length
    const btcCount = result.iocs.filter((i) => i.type === 'btc').length
    if (!newSeverity && (cveCount >= 3 || btcCount >= 5 || result.actors.length >= 1)) {
      newSeverity = 'high'
    }

    // Threat-feed cross-reference: if any extracted IOC matches a known-bad
    // entry from MITRE/MISP feeds, escalate severity. The threat_feed match
    // is a stronger signal than the deterministic heuristics above because
    // it represents a curated indicator (not a regex hit on raw text).
    try {
      const { threatFeedMatcher } = await import('../training/ThreatFeedMatcher')
      const indicators = result.iocs.map((i) => ({
        type: i.type as Parameters<typeof threatFeedMatcher.match>[0],
        value: i.value
      }))
      const feedMatches = threatFeedMatcher.matchBatch(indicators)
      if (feedMatches.length > 0) {
        const hasCritical = feedMatches.some((m) => m.severity === 'critical')
        const hasHigh = feedMatches.some((m) => m.severity === 'high')
        if (hasCritical) newSeverity = 'critical'
        else if (hasHigh && newSeverity !== 'critical') newSeverity = 'high'
        else if (!newSeverity) newSeverity = 'medium'
        log.debug(`DarkWebEnrich ${reportId}: ${feedMatches.length} threat-feed matches → severity ${newSeverity}`)
      }
    } catch (err) {
      log.debug(`threat-feed cross-ref failed for ${reportId}: ${err}`)
    }

    if (newSeverity) {
      try {
        // Only bump UP — don't downgrade a manually-set severity.
        const SEV_ORDER = { low: 0, medium: 1, high: 2, critical: 3 }
        const current = (db.prepare('SELECT severity FROM intel_reports WHERE id = ?').get(reportId) as { severity: string })?.severity || 'medium'
        if ((SEV_ORDER[newSeverity as keyof typeof SEV_ORDER] ?? 0) > (SEV_ORDER[current as keyof typeof SEV_ORDER] ?? 0)) {
          db.prepare('UPDATE intel_reports SET severity = ? WHERE id = ?').run(newSeverity, reportId)
          result.severityBumped = true
        }
      } catch { /* */ }
    }

    // Persist tags. Each finding becomes a tag with prefix.
    const now = timestamp()
    const tagStmt = db.prepare(
      'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      for (const a of result.activities) tagStmt.run(reportId, `darkweb:${a}`, 1.0, 'darkweb-enrich', now)
      for (const a of result.actors) tagStmt.run(reportId, `actor:${a.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 1.0, 'darkweb-enrich', now)
      if (result.language) tagStmt.run(reportId, `lang:${result.language}`, 0.7, 'darkweb-enrich', now)
      // IOC tags — type-only (one per type) so we can filter "reports with BTC IOCs"
      // without polluting the tag space with thousands of unique addresses.
      const iocTypes = new Set(result.iocs.map((i) => i.type))
      for (const t of iocTypes) tagStmt.run(reportId, `ioc:${t}`, 1.0, 'darkweb-enrich', now)
      for (const t of result.llmTags) {
        const safe = t.toLowerCase().trim().slice(0, 60).replace(/[^a-z0-9:_-]+/g, '-')
        if (safe.length >= 3) tagStmt.run(reportId, safe, 0.85, 'darkweb-enrich', now)
      }
      // Threat rating tag — e.g. "threat:8-high" so it's filterable + sortable.
      if (result.threatRating) {
        const r = result.threatRating
        tagStmt.run(reportId, `threat:${r.score}-${r.label}`, 1.0, 'darkweb-enrich', now)
        tagStmt.run(reportId, `threat-rationale:${r.rationale.slice(0, 120).replace(/[^a-z0-9 .,;:-]+/gi, ' ').trim()}`, 0.9, 'darkweb-enrich', now)
      }
      // Version stamp so enqueueUnenriched can skip recently-processed rows.
      tagStmt.run(reportId, ENRICHMENT_VERSION_TAG, 1.0, 'darkweb-enrich', now)
    })
    tx()

    const threatStr = result.threatRating ? ` threat=${result.threatRating.score}/10 (${result.threatRating.label})` : ''
    log.debug(`DarkWebEnrich: ${reportId} — ${result.iocs.length} IOCs, ${result.actors.length} actors, ${result.activities.length} activities, ${result.llmTags.length} LLM tags${threatStr}${result.severityBumped ? ' [severity bumped]' : ''}`)
    return result
  }

  // ── Deterministic phase ──────────────────────────────────────────────
  private extractIocs(text: string): Array<{ type: string; value: string }> {
    const out: Array<{ type: string; value: string }> = []
    const seen = new Set<string>()
    for (const [type, re] of Object.entries(IOC_PATTERNS)) {
      // Reset lastIndex since the regex is module-level + has /g flag.
      ;(re as RegExp).lastIndex = 0
      const matches = text.match(re as RegExp) || []
      for (const m of matches.slice(0, 50)) {
        const key = `${type}:${m}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ type, value: m })
      }
    }
    return out
  }

  private matchActors(text: string): string[] {
    const out = new Set<string>()
    for (const { name, pattern } of THREAT_ACTOR_LEXICON) {
      if (pattern.test(text)) out.add(name)
    }
    return Array.from(out)
  }

  private classifyActivities(text: string): string[] {
    const counts: Record<string, number> = {}
    for (const [activity, patterns] of Object.entries(ACTIVITY_KEYWORDS)) {
      let count = 0
      for (const p of patterns) {
        const m = text.match(p)
        if (m) count += m.length
      }
      if (count > 0) counts[activity] = count
    }
    // Return activities sorted by descending count, top 3.
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a)
  }

  private detectLanguage(text: string): string | null {
    const sample = text.slice(0, 2000)
    const cyrillic = (sample.match(/[\u0400-\u04FF]/g) || []).length
    const cjk = (sample.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g) || []).length
    const arabic = (sample.match(/[\u0600-\u06FF]/g) || []).length
    const latin = (sample.match(/[a-zA-Z]/g) || []).length
    const max = Math.max(cyrillic, cjk, arabic, latin)
    if (max < 50) return null // not enough signal
    if (max === cyrillic) return 'cyrillic'
    if (max === cjk) return 'cjk'
    if (max === arabic) return 'arabic'
    return 'latin'
  }

  // ── LLM phase — tags + threat rating in one call ─────────────────────
  private async generateLlmTagsAndRating(
    title: string,
    text: string,
    deterministic: EnrichmentResult
  ): Promise<{ tags: string[]; rating: ThreatRating | null }> {
    const detSummary = [
      deterministic.activities.length > 0 ? `activities: ${deterministic.activities.join(', ')}` : '',
      deterministic.actors.length > 0 ? `actors: ${deterministic.actors.join(', ')}` : '',
      deterministic.iocs.length > 0 ? `IOCs found: ${Array.from(new Set(deterministic.iocs.map((i) => i.type))).join(', ')}` : ''
    ].filter(Boolean).join(' | ')

    const prompt = `You are a dark-web intel analyst assistant. Do TWO things:

1. **Tags** — generate 5–10 normalized tags for this dark-web page. Prefixes:
   - "darkweb:<activity>"   — e.g. darkweb:ransomware, darkweb:carding
   - "actor:<name>"         — known threat actor (canonical, lowercase, hyphenated)
   - "marketplace:<name>"   — marketplace name if identifiable
   - "victim:<org>"         — named victim organization (only if explicitly mentioned)
   - "tech:<thing>"         — affected tech / CVE / product

2. **Threat rating** — assess how dangerous / actionable this content is on a 1–10 scale:
   1-2 = benign (informational, privacy tools, news mirrors)
   3-4 = low (generic forum chatter, inactive marketplace listing)
   5-6 = medium (active marketplace, credential dump, exploit discussion)
   7-8 = high (active ransomware leak with named victims, fresh credential dump, active C2)
   9-10 = critical (imminent attack planning, zero-day with working exploit, active hostage/extortion with deadline)

   Also provide a 1-sentence rationale.

Page title: "${title}"
Auto-detected: ${detSummary || '(none)'}

Page content (truncated):
${text.slice(0, 4000)}

Return STRICT JSON only:
{
  "tags": ["tag1", "tag2", ...],
  "threat_score": 7,
  "threat_label": "high",
  "threat_rationale": "Active ransomware leak site with 3 named victim organizations and countdown timers."
}`

    const raw = await llmService.completeForTask('planner', prompt, undefined, 600)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { tags: [], rating: null }
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        tags?: string[]
        threat_score?: number
        threat_label?: string
        threat_rationale?: string
      }

      const tags = Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter((t) => t.length >= 3 && t.length <= 60)
            .slice(0, 10)
        : []

      let rating: ThreatRating | null = null
      if (typeof parsed.threat_score === 'number' && parsed.threat_score >= 1 && parsed.threat_score <= 10) {
        const score = Math.round(parsed.threat_score)
        const label = parsed.threat_label && ['low', 'medium', 'high', 'critical'].includes(parsed.threat_label)
          ? parsed.threat_label
          : score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low'
        rating = {
          score,
          label,
          rationale: (parsed.threat_rationale || '').slice(0, 200).trim() || 'No rationale provided'
        }
      }

      return { tags, rating }
    } catch {
      return { tags: [], rating: null }
    }
  }

  // ── Aggregates for the Enrichment tab UI ─────────────────────────────
  getCounts(): { enriched: number; unenriched: number; total: number } {
    const db = getDatabase()
    const total = (db.prepare("SELECT COUNT(*) AS c FROM intel_reports WHERE title LIKE '[DARKWEB]%'").get() as { c: number }).c
    const enriched = (db.prepare(
      "SELECT COUNT(DISTINCT r.id) AS c FROM intel_reports r JOIN intel_tags t ON t.report_id = r.id WHERE r.title LIKE '[DARKWEB]%' AND t.tag = ?"
    ).get(ENRICHMENT_VERSION_TAG) as { c: number }).c
    return { enriched, unenriched: total - enriched, total }
  }

  /** Top tags by frequency, optionally restricted to a prefix (for the
   *  chat filter picker — show top 30 actor tags, etc.). */
  getTopTags(opts: { prefix?: string; limit?: number } = {}): Array<{ tag: string; count: number }> {
    const db = getDatabase()
    const limit = opts.limit ?? 50
    const where = opts.prefix ? "AND tag LIKE ?" : ''
    const sql = `
      SELECT tag, COUNT(DISTINCT report_id) AS count
      FROM intel_tags
      WHERE source = 'darkweb-enrich' ${where}
      GROUP BY tag
      ORDER BY count DESC, tag
      LIMIT ?
    `
    return (opts.prefix
      ? db.prepare(sql).all(`${opts.prefix}%`, limit)
      : db.prepare(sql).all(limit)
    ) as Array<{ tag: string; count: number }>
  }

  getIocSummary(): Array<{ type: string; reportCount: number }> {
    const db = getDatabase()
    return db.prepare(`
      SELECT REPLACE(tag, 'ioc:', '') AS type, COUNT(DISTINCT report_id) AS reportCount
      FROM intel_tags
      WHERE source = 'darkweb-enrich' AND tag LIKE 'ioc:%'
      GROUP BY tag
      ORDER BY reportCount DESC
    `).all() as Array<{ type: string; reportCount: number }>
  }
}

export const darkWebEnrichmentService = new DarkWebEnrichmentServiceImpl()
