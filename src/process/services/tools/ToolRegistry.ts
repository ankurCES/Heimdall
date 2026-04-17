import { safeFetcher } from '../../collectors/SafeFetcher'
import { getDatabase } from '../database'
import { vectorDbService } from '../vectordb/VectorDbService'
import { intelRagService } from '../llm/IntelRagService'
import { intelEnricher } from '../enrichment/IntelEnricher'
import { resolveNodesById } from '../../bridge/enrichmentBridge'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  requiresApproval: boolean
}

export interface ToolResult {
  output: string
  error?: string
  data?: unknown
}

/**
 * Optional per-call context passed by the caller (ToolCallingAgent) so tools
 * can resolve context-sensitive params — e.g. `session_id='current'` in
 * `humint_recall` resolves to the active chat sessionId.
 */
export interface ToolExecContext {
  sessionId?: string
}

type ToolHandler = (params: Record<string, unknown>, ctx?: ToolExecContext) => Promise<ToolResult>

class ToolRegistryImpl {
  private tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>()

  constructor() {
    this.registerBuiltins()
  }

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler })
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  hasName(name: string): boolean {
    return this.tools.has(name)
  }

  getToolSchemas(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.tools.values()).map(({ def }) => ({
      type: 'function' as const,
      function: { name: def.name, description: def.description, parameters: def.parameters }
    }))
  }

  async execute(name: string, params: Record<string, unknown>, ctx?: ToolExecContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { output: `Unknown tool: ${name}`, error: 'TOOL_NOT_FOUND' }

    log.info(`Tool exec: ${name}(${JSON.stringify(params).slice(0, 100)})`)
    const start = Date.now()

    try {
      const result = await tool.handler(params, ctx)
      log.info(`Tool done: ${name} in ${Date.now() - start}ms`)
      return result
    } catch (err) {
      log.warn(`Tool error: ${name}: ${err}`)
      return { output: `Tool error: ${err}`, error: String(err) }
    }
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys())
  }

  requiresApproval(name: string): boolean {
    return this.tools.get(name)?.def.requiresApproval ?? true
  }

  private registerBuiltins(): void {
    // ── Intel Search ──
    this.register({
      name: 'intel_search',
      description: `Full-text search across intel reports using SQLite FTS5 with BM25 ranking.

TIPS for best results:
- Pass 2-6 specific keywords, NOT a full sentence. Drop articles/verbs/conversational fillers.
- Quote multi-word phrases for exact match: "ballistic missile"
- Use OR between alternative terms: drone OR uav
- Use AND to require all terms: nuclear AND iran
- Prefix wildcard: missile* matches missile, missiles, missilery
- For an exact entity (CVE, IP, domain, hash), prefer entity_lookup.

EXAMPLES:
  GOOD: query="China Iran nuclear* OR atomic*"
  GOOD: query="\\"ballistic missile\\" Iran"
  BAD:  query="What's the latest on China-Iran nuclear cooperation?"

By default the query goes through QueryPlanner which strips stop-words,
expands short queries with intel-domain synonyms, and rewrites natural-
language input into FTS5 syntax. Set auto_refine=false to bypass and pass
your query straight to FTS5.`,
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Search keywords or FTS5 expression' },
        discipline: { type: 'string', description: 'Filter by discipline (osint, cybint, finint, etc.)' },
        severity: { type: 'string', description: 'Filter by severity (critical, high, medium, low)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        auto_refine: { type: 'boolean', description: 'When true (default), QueryPlanner preprocesses the query. Set false if you have already extracted clean keywords.' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params) => {
      const rawQuery = params.query as string
      const limit = (params.limit as number) || 10
      const autoRefine = params.auto_refine !== false  // default true

      // Plan + execute. Deterministic plan first; if it returns < 3 hits we
      // could escalate to LLM via planAdaptive — keep it deterministic-only
      // here so a single tool call doesn't pay an extra LLM round-trip.
      // (AgenticChatOrchestrator.runInternalGroup uses planAdaptive when
      //  the analyst clearly typed natural language.)
      const { queryPlanner } = await import('../intel/QueryPlanner')
      const plan = autoRefine ? queryPlanner.plan(rawQuery) : null

      const ftsQueryToUse = plan?.ftsQuery || rawQuery
      const reports = intelRagService.searchReportsRanked(ftsQueryToUse, limit, { rawFts: !!plan })

      const filtered = reports.filter((r) => {
        if (params.discipline && r.discipline !== params.discipline) return false
        if (params.severity && r.severity !== params.severity) return false
        return true
      })

      // Build the output — leading [meta] line so the LLM (and the trail)
      // can see the actual rewrite + entity hints.
      const metaLine = plan ? plan.meta : `[meta] FTS query: ${ftsQueryToUse} | source: raw (auto_refine=false)`
      const entityHintLine = plan && plan.entityHints.length > 0
        ? `[hint] Detected entities — consider calling entity_lookup for exact matches: ${plan.entityHints.map((e) => `${e.type}=${e.value}`).join(', ')}`
        : ''
      const matchedViaLine = filtered.length > 0
        ? `[match] ${filtered.length} hit(s) via ${filtered[0].matchedVia.toUpperCase()}${filtered[0].matchedVia === 'fts5' ? ' (BM25-ranked)' : ' (LIKE fallback)'}`
        : '[match] no hits'

      const headerLines = [metaLine, entityHintLine, matchedViaLine].filter(Boolean).join('\n')
      const resultLines = filtered.map((r) =>
        `[${r.severity.toUpperCase()}] ${r.title}\nDiscipline: ${r.discipline} | Source: ${r.sourceName} | BM25: ${r.score.toFixed(2)}\n${r.content.slice(0, 300)}\n[id:${r.id}]`
      ).join('\n---\n')

      return {
        // Trailing [id:<uuid>] marker per result lets the LLM cite reports by id
        // when summarizing and also lands in tool_call_logs.result for later
        // source-id extraction when saving a preliminary report.
        output: resultLines ? `${headerLines}\n\n${resultLines}` : `${headerLines}\n\n(no matching reports — try simpler keywords, or call entity_lookup if you have a specific CVE/IP/domain)`,
        data: filtered
      }
    })

    // ── Vector Search ──
    this.register({
      name: 'vector_search',
      description: 'Semantic similarity search across all intelligence data using vector embeddings. Pass include_linked: true to also return each hit\'s top-3 graph neighbors (HUMINT findings that cite it, related intel) in one call.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Max results (default 8)' },
        include_linked: { type: 'boolean', description: 'When true, each hit carries up to 3 strongest graph neighbors inline' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params) => {
      const results = await vectorDbService.search(params.query as string, (params.limit as number) || 8)
      const includeLinked = params.include_linked === true

      if (!includeLinked) {
        return {
          // Each result carries [id:<uuid>] so the LLM can cite by id and
          // handleSavePreliminaryReport can harvest IDs from tool_call_logs.
          output: results.map((r) => `[${r.severity}] ${r.title} (score: ${r.score.toFixed(2)})\n${r.snippet}\n[id:${r.id}]`).join('\n---\n'),
          data: results
        }
      }

      // Linked mode — fetch top-3 strongest neighbors per hit via intelEnricher
      const db = getDatabase()
      const lines: string[] = []
      for (const r of results) {
        lines.push(`[${r.severity}] ${r.title} (score: ${r.score.toFixed(2)})\n${r.snippet}\n[id:${r.id}]`)

        try {
          const links = intelEnricher.getLinks(r.id).slice(0, 3)
          if (links.length > 0) {
            const neighborIds = links.map((l) => l.linkedReportId)
            const neighbors = resolveNodesById(db, neighborIds)
            for (const l of links) {
              const n = neighbors.get(l.linkedReportId) as { title?: string; type?: string; discipline?: string } | undefined
              const title = n?.title ? String(n.title).slice(0, 60) : '(unknown)'
              const marker = n?.type === 'humint'
                ? `[humint:${l.linkedReportId}]`
                : n?.type === 'preliminary'
                ? `[preliminary:${l.linkedReportId}]`
                : `[id:${l.linkedReportId}]`
              lines.push(`  → ${marker} (${l.linkType}, ${l.strength.toFixed(2)}) "${title}"`)
            }
          }
        } catch {}
      }

      return {
        output: lines.join('\n---\n'),
        data: results
      }
    })

    // ── Entity Lookup ──
    this.register({
      name: 'entity_lookup',
      description: 'Find intelligence reports containing a specific entity (IP address, CVE, country, organization, threat actor).',
      parameters: { type: 'object', properties: {
        entity_type: { type: 'string', description: 'Entity type: ip, cve, country, organization, threat_actor, malware' },
        entity_value: { type: 'string', description: 'Entity value to search for' }
      }, required: ['entity_type', 'entity_value'] },
      requiresApproval: false
    }, async (params) => {
      const db = getDatabase()
      const results = db.prepare(
        'SELECT r.id, r.title, r.discipline, r.severity, r.source_name, substr(r.content, 1, 300) as snippet FROM intel_reports r JOIN intel_entities e ON r.id = e.report_id WHERE e.entity_type = ? AND e.entity_value = ? LIMIT 10'
      ).all(params.entity_type, params.entity_value) as Array<Record<string, unknown>>
      return {
        output: results.map((r) => `[${r.severity}] ${r.title}\n${r.discipline} | ${r.source_name}\n${r.snippet}\n[id:${r.id}]`).join('\n---\n') || 'No matching reports found.',
        data: results
      }
    })

    // ── Web Fetch ──
    this.register({
      name: 'web_fetch',
      description: 'Fetch content from a public URL. Uses rate limiting and robots.txt compliance.',
      parameters: { type: 'object', properties: {
        url: { type: 'string', description: 'URL to fetch' }
      }, required: ['url'] },
      requiresApproval: false
    }, async (params) => {
      const text = await safeFetcher.fetchText(params.url as string, { timeout: 15000 })
      return { output: text.slice(0, 3000) }
    })

    // ── Onion Fetch (Tor-routed) ──
    // Fetches a `.onion` URL via SafeFetcher. SafeFetcher auto-routes any
    // host ending in `.onion` through the bound SOCKS5 proxy when one is
    // set (TorService.connect() does the binding). Pre-checks Tor state so
    // the LLM gets an actionable error instead of a cryptic timeout.
    this.register({
      name: 'onion_fetch',
      description: 'Fetch a `.onion` URL through the Tor SOCKS5 proxy. Use this on URLs returned by ahmia_search to read the actual dark-web page content. REQUIRES Tor to be connected (Settings → Dark Web → Connect to Tor). Returns truncated text content.',
      parameters: { type: 'object', properties: {
        url: { type: 'string', description: 'Full .onion URL (e.g. http://lockbit…onion/leak/page)' },
        max_chars: { type: 'number', description: 'Max chars of body to return (default 3000, max 10000)' }
      }, required: ['url'] },
      requiresApproval: false
    }, async (params) => {
      const url = String(params.url || '').trim()
      if (!url) return { output: 'Empty URL', error: 'EMPTY_URL' }
      let parsed: URL
      try { parsed = new URL(url) } catch { return { output: `Invalid URL: ${url}`, error: 'INVALID_URL' } }
      if (!parsed.hostname.endsWith('.onion')) {
        return { output: `Not an onion URL: ${parsed.hostname}. Use web_fetch for clearnet URLs.`, error: 'NOT_ONION' }
      }
      // Pre-check Tor state — clearer error than a network timeout 30s later.
      const { torService } = await import('../darkweb/TorService')
      const torState = torService.getState()
      if (torState.status !== 'connected_external' && torState.status !== 'connected_managed') {
        return {
          output: `Tor is not connected (status: ${torState.status}). Open Settings → Dark Web → "Connect to Tor" before fetching .onion URLs.`,
          error: 'TOR_NOT_CONNECTED'
        }
      }
      const maxChars = Math.min(Math.max((params.max_chars as number) || 3000, 100), 10000)
      try {
        // skipRobots: onion sites typically have no robots.txt; the
        // SafeFetcher SOCKS5 routing kicks in automatically based on the
        // .onion suffix.
        const html = await safeFetcher.fetchText(url, { timeout: 30000, skipRobots: true, maxRetries: 1 })
        // Strip HTML / scripts / styles for a readable text excerpt.
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim()
        return {
          output: `[onion:${parsed.hostname}] (${text.length} chars text / ${html.length} chars HTML)\n${text.slice(0, maxChars)}${text.length > maxChars ? '\n…[truncated]' : ''}`,
          data: { url, hostname: parsed.hostname, text, htmlLength: html.length, textLength: text.length }
        }
      } catch (err) {
        return { output: `Onion fetch failed for ${parsed.hostname}: ${(err as Error).message}`, error: String(err) }
      }
    })

    // ── Ahmia Dark-Web Search (clearnet, no Tor) ──
    // Searches ahmia.fi which indexes .onion sites. No auth, no API key.
    // Result rows include the .onion URL so the analyst can investigate
    // further via OnionFeedCollector if Tor is configured. Honors the global
    // DarkWebConfig.enabled + ahmiaEnabled toggles — disabled by default
    // unless the analyst opts in via Settings → Dark Web.
    this.register({
      name: 'ahmia_search',
      description: 'Search the dark-web (.onion sites) via the Ahmia clearnet index. Use for ransomware, data-leak, credential-dump, threat-actor reconnaissance. Returns onion URLs + descriptions. Requires Settings → Dark Web → Ahmia enabled.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Search keywords (e.g. "ransomware victim leak", actor name, exposed credential domain)' },
        limit: { type: 'number', description: 'Max results (default 10, max 25)' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params) => {
      const { settingsService } = await import('../settings/SettingsService')
      const dw = settingsService.get<{ enabled?: boolean; ahmiaEnabled?: boolean }>('darkWeb')
      if (!dw?.enabled || !dw?.ahmiaEnabled) {
        return { output: 'Ahmia dark-web search is disabled. Enable it in Settings → Dark Web → Ahmia toggle.', error: 'AHMIA_DISABLED' }
      }
      const q = String(params.query || '').trim()
      if (!q) return { output: 'Empty query', error: 'EMPTY_QUERY' }
      const limit = Math.min(Math.max((params.limit as number) || 10, 1), 25)
      try {
        const { ahmiaSearch } = await import('../darkweb/AhmiaClient')
        const hits = await ahmiaSearch(q, limit)
        if (hits.length === 0) {
          return { output: `Ahmia: no .onion results for "${q}"`, data: [] }
        }
        const lines = hits.map((h, i) =>
          `${i + 1}. ${h.title}\n   .onion: ${h.onionUrl}\n   last seen: ${h.lastSeen || 'unknown'}\n   ${h.description.slice(0, 240)}`
        )
        return {
          output: `Ahmia dark-web search "${q}" — ${hits.length} hit(s):\n\n${lines.join('\n\n')}`,
          data: hits
        }
      } catch (err) {
        return { output: `Ahmia search failed: ${(err as Error).message}`, error: String(err) }
      }
    })

    // ── WHOIS Lookup ──
    this.register({
      name: 'whois_lookup',
      description: 'Perform RDAP/WHOIS lookup for a domain name. Returns registration info.',
      parameters: { type: 'object', properties: {
        domain: { type: 'string', description: 'Domain name to look up' }
      }, required: ['domain'] },
      requiresApproval: false
    }, async (params) => {
      const domain = params.domain as string
      const tld = domain.split('.').pop() || 'com'
      const server = tld === 'com' || tld === 'net' ? 'https://rdap.verisign.com' : 'https://rdap.org'
      const data = await safeFetcher.fetchJson<Record<string, unknown>>(`${server}/${tld}/v1/domain/${domain}`)
      const events = (data.events as Array<{ eventAction: string; eventDate: string }>) || []
      const reg = events.find((e) => e.eventAction === 'registration')?.eventDate
      const exp = events.find((e) => e.eventAction === 'expiration')?.eventDate
      return { output: `Domain: ${domain}\nRegistered: ${reg || 'Unknown'}\nExpires: ${exp || 'Unknown'}\nStatus: ${((data.status as string[]) || []).join(', ')}`, data }
    })

    // ── CVE Detail ──
    this.register({
      name: 'cve_detail',
      description: 'Get detailed information about a CVE vulnerability from the NVD database.',
      parameters: { type: 'object', properties: {
        cve_id: { type: 'string', description: 'CVE ID (e.g., CVE-2024-1234)' }
      }, required: ['cve_id'] },
      requiresApproval: false
    }, async (params) => {
      const data = await safeFetcher.fetchJson<{ vulnerabilities: Array<{ cve: { descriptions: Array<{ value: string }>; metrics?: Record<string, unknown> } }> }>(
        `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${params.cve_id}`
      )
      const cve = data.vulnerabilities?.[0]?.cve
      if (!cve) return { output: `CVE ${params.cve_id} not found` }
      const desc = cve.descriptions?.find((d: any) => d.lang === 'en')?.value || 'No description'
      return { output: `${params.cve_id}\n${desc}`, data: cve }
    })

    // ── DNS Resolve ──
    this.register({
      name: 'dns_resolve',
      description: 'Resolve DNS records for a domain using public DNS.',
      parameters: { type: 'object', properties: {
        domain: { type: 'string', description: 'Domain to resolve' },
        type: { type: 'string', description: 'Record type: A, AAAA, MX, NS, TXT (default: A)' }
      }, required: ['domain'] },
      requiresApproval: false
    }, async (params) => {
      const rrType = (params.type as string) || 'A'
      const data = await safeFetcher.fetchJson<{ Answer?: Array<{ name: string; type: number; data: string }> }>(
        `https://dns.google/resolve?name=${params.domain}&type=${rrType}`
      )
      const answers = data.Answer || []
      return { output: answers.map((a) => `${a.name} → ${a.data}`).join('\n') || `No ${rrType} records found`, data: answers }
    })

    // ── Shell Exec ──
    this.register({
      name: 'shell_exec',
      description: 'Execute a shell command. Only allowed: curl, dig, nslookup, whois, traceroute, ping, ls, cat, head, grep.',
      parameters: { type: 'object', properties: {
        command: { type: 'string', description: 'Shell command to execute' }
      }, required: ['command'] },
      requiresApproval: true
    }, async (params) => {
      const cmd = params.command as string
      const allowed = ['curl', 'dig', 'nslookup', 'whois', 'traceroute', 'ping', 'ls', 'cat', 'head', 'grep', 'wc', 'sort', 'uniq']
      const firstWord = cmd.trim().split(/\s+/)[0]
      if (!allowed.includes(firstWord)) {
        return { output: `Command "${firstWord}" not in allowlist: ${allowed.join(', ')}`, error: 'FORBIDDEN' }
      }
      // Block shell operators
      if (/[;&|><`$()]/.test(cmd)) {
        return { output: 'Shell operators (;, &, |, >, <, `, $) are not allowed', error: 'FORBIDDEN' }
      }

      const { exec } = await import('child_process')
      return new Promise((resolve) => {
        exec(cmd, { timeout: 30000, maxBuffer: 10240 }, (err, stdout, stderr) => {
          if (err) resolve({ output: `Error: ${err.message}\n${stderr}`, error: err.message })
          else resolve({ output: stdout.slice(0, 5000) || stderr.slice(0, 5000) })
        })
      })
    })

    // ── Create Intel Report ──
    this.register({
      name: 'create_report',
      description: 'Create a new intelligence report from findings. Links it to the knowledge base.',
      parameters: { type: 'object', properties: {
        title: { type: 'string', description: 'Report title' },
        content: { type: 'string', description: 'Report content (markdown)' },
        discipline: { type: 'string', description: 'Intelligence discipline' },
        severity: { type: 'string', description: 'Severity level' }
      }, required: ['title', 'content', 'discipline', 'severity'] },
      requiresApproval: false
    }, async (params) => {
      const db = getDatabase()
      const now = timestamp()
      const id = generateId()
      const { createHash } = await import('crypto')
      const hash = createHash('sha256').update(params.title + params.content).digest('hex')

      db.prepare(
        'INSERT INTO intel_reports (id, discipline, title, content, severity, source_id, source_name, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, params.discipline, params.title, params.content, params.severity, 'tool-agent', 'Agent Tool', hash, 70, 0, now, now)

      return { output: `Report created: ${params.title} (ID: ${id.slice(0, 8)})`, data: { id } }
    })

    // ── Graph Query (SQLite-backed; for richer traversal use graph_neighborhood) ──
    this.register({
      name: 'graph_query',
      description: 'Query the intelligence relationship graph using Cypher. Supports: connections (default), shortest_path between two reports, neighbors_2hop for multi-hop traversal, entity_pattern to find reports sharing a specific entity.',
      parameters: { type: 'object', properties: {
        report_id: { type: 'string', description: 'Report ID to find connections for' },
        link_type: { type: 'string', description: 'Filter by link type: shared_entity, temporal, preliminary_reference, humint_source' },
        query_type: { type: 'string', description: 'Type of query: connections (default), shortest_path, neighbors_2hop, entity_pattern' },
        target_id: { type: 'string', description: 'Target report ID (for shortest_path)' },
        entity_value: { type: 'string', description: 'Entity value to search for (for entity_pattern)' },
        entity_type: { type: 'string', description: 'Entity type: ip, cve, country, organization, threat_actor, malware (for entity_pattern)' }
      }, required: ['report_id'] },
      requiresApproval: false
    }, async (params) => {
      // SQLite-only graph traversal. The historical Kuzu path was removed
      // alongside the npm package in v0.4 — see migration 012. Use
      // graph_neighborhood (1–2 hop) for neighbor traversal beyond a single
      // hop; this tool returns direct connections for backward compat.
      const links = intelEnricher.getLinks(params.report_id as string)
      const filtered = params.link_type ? links.filter((l) => l.linkType === params.link_type) : links
      return {
        output: filtered.map((l) => `→ ${l.linkedReportId.slice(0, 8)} [${l.linkType}] strength=${l.strength} "${l.reason}"`).join('\n') || 'No linked reports found.',
        data: filtered
      }
    })

    // ─────────────────────────────────────────────────────────────────────
    //  Knowledge-graph tools — surface prior analyst conclusions so the
    //  agent doesn't re-derive work that's already been recorded.
    // ─────────────────────────────────────────────────────────────────────

    // ── HUMINT Recall ──
    this.register({
      name: 'humint_recall',
      description: 'Find prior HUMINT analyst reports relevant to a topic. Use BEFORE fresh searches to avoid re-deriving conclusions an analyst already recorded. Returns findings, analyst notes, confidence, and the intel that backed each conclusion.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Topic or question to match against past HUMINT findings' },
        limit: { type: 'number', description: 'Max HUMINTs to return (default 5)' },
        session_id: { type: 'string', description: 'Filter to a specific chat session. Pass "current" to scope to the current chat.' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params, ctx) => {
      const query = String(params.query || '')
      const limit = (params.limit as number) || 5
      let sessionId: string | undefined = params.session_id as string | undefined
      if (sessionId === 'current') sessionId = ctx?.sessionId

      const db = getDatabase()

      // Vector search first (semantic recall over findings/analyst_notes)
      let humintIds: string[] = []
      try {
        const vr = await vectorDbService.search(query, Math.min(limit * 3, 30))
        for (const r of vr) {
          const id = (r as { id?: string }).id
          if (!id) continue
          const row = db.prepare('SELECT 1 FROM humint_reports WHERE id = ?').get(id)
          if (row) humintIds.push(id)
        }
      } catch {}

      // Keyword fallback / augment
      if (humintIds.length < limit) {
        const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5)
        if (keywords.length > 0) {
          const conds = keywords.map(() => '(LOWER(findings) LIKE ? OR LOWER(analyst_notes) LIKE ?)').join(' OR ')
          const bind: string[] = []
          for (const k of keywords) bind.push(`%${k}%`, `%${k}%`)
          const rows = db.prepare(
            `SELECT id FROM humint_reports WHERE ${conds} ORDER BY created_at DESC LIMIT ?`
          ).all(...bind, limit) as Array<{ id: string }>
          for (const r of rows) if (!humintIds.includes(r.id)) humintIds.push(r.id)
        }
      }

      if (humintIds.length === 0) {
        return { output: `No past HUMINT reports found matching "${query}".`, data: [] }
      }

      humintIds = humintIds.slice(0, limit)
      const placeholders = humintIds.map(() => '?').join(',')
      const sessionFilter = sessionId ? ' AND session_id = ?' : ''
      const bindArgs: unknown[] = [...humintIds]
      if (sessionId) bindArgs.push(sessionId)
      const rows = db.prepare(
        `SELECT id, session_id, findings, analyst_notes, confidence, source_report_ids, created_at FROM humint_reports WHERE id IN (${placeholders})${sessionFilter} ORDER BY created_at DESC`
      ).all(...bindArgs) as Array<{
        id: string; session_id: string; findings: string; analyst_notes: string;
        confidence: string; source_report_ids: string | null; created_at: number
      }>

      if (rows.length === 0) {
        return { output: `No HUMINTs matched${sessionId ? ' in current session' : ''}.`, data: [] }
      }

      const blocks = rows.map((r) => {
        let sourceCount = 0
        try { sourceCount = JSON.parse(r.source_report_ids || '[]').length } catch {}
        const findings = (r.findings || '').replace(/\s+/g, ' ').slice(0, 500)
        const notes = (r.analyst_notes || '').replace(/\s+/g, ' ').slice(0, 500)
        return [
          `[humint:${r.id}] (confidence: ${r.confidence}, session: ${r.session_id.slice(0, 8)}, ${new Date(r.created_at).toISOString().slice(0, 10)})`,
          `Findings: ${findings || '(none)'}`,
          notes ? `Analyst notes: ${notes}` : '',
          `Cited intel: ${sourceCount} reports`
        ].filter(Boolean).join('\n')
      })

      return {
        output: blocks.join('\n---\n'),
        data: rows
      }
    })

    // ── Preliminary Brief ──
    this.register({
      name: 'preliminary_brief',
      description: 'Retrieve analyst-curated preliminary briefings relevant to a topic. Each brief summarizes prior intel synthesis plus any open information gaps and recommended actions.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Topic to match against briefing title and content' },
        limit: { type: 'number', description: 'Max briefings to return (default 3)' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params) => {
      const query = String(params.query || '')
      const limit = (params.limit as number) || 3
      const db = getDatabase()

      const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5)
      if (keywords.length === 0) return { output: 'Query too short — use at least one keyword of length >3.', data: [] }

      const conds = keywords.map(() => '(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)').join(' OR ')
      const bind: string[] = []
      for (const k of keywords) bind.push(`%${k}%`, `%${k}%`)

      const rows = db.prepare(
        `SELECT id, title, content, status, source_report_ids, created_at FROM preliminary_reports WHERE ${conds} ORDER BY created_at DESC LIMIT ?`
      ).all(...bind, limit) as Array<{
        id: string; title: string; content: string; status: string;
        source_report_ids: string | null; created_at: number
      }>

      if (rows.length === 0) return { output: `No preliminary briefings found for "${query}".`, data: [] }

      const blocks = rows.map((r) => {
        let citedCount = 0
        try { citedCount = JSON.parse(r.source_report_ids || '[]').length } catch {}

        const gaps = db.prepare(
          "SELECT description, severity FROM intel_gaps WHERE preliminary_report_id = ? AND status = 'open' LIMIT 5"
        ).all(r.id) as Array<{ description: string; severity: string }>
        const actions = db.prepare(
          "SELECT action, priority FROM recommended_actions WHERE preliminary_report_id = ? AND status = 'pending' LIMIT 5"
        ).all(r.id) as Array<{ action: string; priority: string }>

        const content = (r.content || '').replace(/\s+/g, ' ').slice(0, 800)
        const parts = [
          `[preliminary:${r.id}] "${(r.title || '').slice(0, 80)}" (${new Date(r.created_at).toISOString().slice(0, 10)}, ${citedCount} cited)`,
          `Summary: ${content}`
        ]
        if (gaps.length > 0) parts.push(`Open gaps (${gaps.length}):\n${gaps.map((g) => `  - [${g.severity}] ${g.description.slice(0, 120)}`).join('\n')}`)
        if (actions.length > 0) parts.push(`Recommended actions (${actions.length}):\n${actions.map((a) => `  - [${a.priority}] ${a.action.slice(0, 120)}`).join('\n')}`)
        return parts.join('\n')
      })

      return { output: blocks.join('\n---\n'), data: rows }
    })

    // ── Cited By (reverse citation) ──
    this.register({
      name: 'cited_by',
      description: 'Reverse citation lookup — given an intel report id, find all preliminary briefings and HUMINT analyst products that cited it. Use to see how a specific intel finding has shaped prior conclusions.',
      parameters: { type: 'object', properties: {
        report_id: { type: 'string', description: 'Intel report id to look up citations for' }
      }, required: ['report_id'] },
      requiresApproval: false
    }, async (params) => {
      const reportId = String(params.report_id || '')
      if (!reportId) return { output: 'report_id is required.', data: [] }

      const db = getDatabase()
      const links = db.prepare(
        "SELECT source_report_id, link_type, strength, reason FROM intel_links WHERE target_report_id = ? AND link_type IN ('preliminary_reference', 'humint_source', 'humint_preliminary') ORDER BY strength DESC LIMIT 30"
      ).all(reportId) as Array<{ source_report_id: string; link_type: string; strength: number; reason: string }>

      if (links.length === 0) return { output: `Intel ${reportId.slice(0, 8)} has not been cited by any HUMINT or preliminary report.`, data: [] }

      const sourceIds = links.map((l) => l.source_report_id)
      const nodes = resolveNodesById(db, sourceIds)

      const lines: string[] = []
      for (const l of links) {
        const n = nodes.get(l.source_report_id) as { title?: string; type?: string } | undefined
        if (!n) continue
        const marker = n.type === 'humint'
          ? `[humint:${l.source_report_id}]`
          : n.type === 'preliminary'
          ? `[preliminary:${l.source_report_id}]`
          : `[id:${l.source_report_id}]`
        lines.push(`${marker} "${String(n.title || '').slice(0, 80)}" (${l.link_type}, strength ${l.strength.toFixed(2)})`)
      }

      return {
        output: `Intel ${reportId.slice(0, 8)} has been cited by ${lines.length} analyst products:\n${lines.join('\n')}`,
        data: links
      }
    })

    // ── Graph Neighborhood ──
    this.register({
      name: 'graph_neighborhood',
      description: 'Pull the knowledge-graph subgraph around a node (1 or 2 hops). Returns connected intel, HUMINT findings, preliminary briefings, information gaps, and recommended actions — grouped by node type so structure is visible at a glance.',
      parameters: { type: 'object', properties: {
        report_id: { type: 'string', description: 'Center node id (intel, humint, preliminary, or gap)' },
        depth: { type: 'number', description: 'Hop depth (1 or 2, default 1)' },
        limit: { type: 'number', description: 'Max total nodes to return (default 30)' }
      }, required: ['report_id'] },
      requiresApproval: false
    }, async (params) => {
      const reportId = String(params.report_id || '')
      const depth = Math.min(Math.max((params.depth as number) || 1, 1), 2)
      const limit = (params.limit as number) || 30
      if (!reportId) return { output: 'report_id is required.', data: null }

      const db = getDatabase()

      // Collect link-connected ids up to depth
      const visited = new Set<string>([reportId])
      const frontier = new Set<string>([reportId])
      const linkRows: Array<{ source: string; target: string; type: string; strength: number }> = []

      for (let hop = 0; hop < depth; hop++) {
        if (frontier.size === 0) break
        const currentIds = Array.from(frontier)
        frontier.clear()
        const placeholders = currentIds.map(() => '?').join(',')
        const links = db.prepare(
          `SELECT source_report_id AS source, target_report_id AS target, link_type AS type, strength FROM intel_links WHERE source_report_id IN (${placeholders}) OR target_report_id IN (${placeholders}) ORDER BY strength DESC LIMIT ?`
        ).all(...currentIds, ...currentIds, limit * 2) as Array<{ source: string; target: string; type: string; strength: number }>
        for (const l of links) {
          linkRows.push(l)
          for (const id of [l.source, l.target]) {
            if (!visited.has(id)) { visited.add(id); frontier.add(id) }
          }
        }
      }

      if (visited.size === 1) {
        return { output: `Node ${reportId.slice(0, 8)} has no graph connections within ${depth} hops.`, data: { nodes: [], links: [] } }
      }

      const allIds = Array.from(visited).slice(0, limit)
      const nodes = resolveNodesById(db, allIds)

      // Group by type
      const groups: Record<string, Array<{ id: string; title: string; discipline?: string; severity?: string }>> = {
        INTEL: [], HUMINT: [], PRELIMINARY: [], GAP: [], ACTION: [], OTHER: []
      }
      for (const [id, n] of nodes) {
        if (id === reportId) continue
        const typed = n as { type?: string; discipline?: string; severity?: string; title?: string }
        const bucket = typed.type === 'humint' ? 'HUMINT'
          : typed.type === 'preliminary' ? 'PRELIMINARY'
          : typed.type === 'gap' ? 'GAP'
          : typed.type === 'action' ? 'ACTION'
          : 'INTEL'
        groups[bucket].push({ id, title: String(typed.title || '(untitled)').slice(0, 80), discipline: typed.discipline, severity: typed.severity })
      }

      const lines: string[] = [`Neighborhood of ${reportId.slice(0, 8)} within ${depth} hop(s) — ${visited.size - 1} nodes, ${linkRows.length} links`]
      for (const group of ['HUMINT', 'PRELIMINARY', 'INTEL', 'GAP', 'ACTION']) {
        const items = groups[group]
        if (items.length === 0) continue
        lines.push(`\n${group} (${items.length}):`)
        for (const it of items) {
          const marker = group === 'HUMINT' ? `[humint:${it.id}]` : group === 'PRELIMINARY' ? `[preliminary:${it.id}]` : `[id:${it.id}]`
          const meta = [it.discipline, it.severity].filter(Boolean).join('/')
          lines.push(`  ${marker} "${it.title}" ${meta ? `(${meta})` : ''}`)
        }
      }

      return { output: lines.join('\n'), data: { nodes: Array.from(nodes.values()), links: linkRows } }
    })

    // ── Entity Lineage ──
    this.register({
      name: 'entity_lineage',
      description: 'Walk the graph for a specific entity (IP, CVE, country, org, threat actor, malware). Returns a chronological view: intel reports mentioning the entity → HUMINTs that cite those reports → preliminary briefings → open gaps.',
      parameters: { type: 'object', properties: {
        entity_type: { type: 'string', description: 'Entity type: ip, cve, country, organization, threat_actor, malware' },
        entity_value: { type: 'string', description: 'Entity value to trace' },
        limit: { type: 'number', description: 'Max intel reports to include per bucket (default 20)' }
      }, required: ['entity_type', 'entity_value'] },
      requiresApproval: false
    }, async (params) => {
      const entityType = String(params.entity_type || '')
      const entityValue = String(params.entity_value || '')
      const limit = (params.limit as number) || 20
      if (!entityType || !entityValue) return { output: 'entity_type and entity_value are required.', data: null }

      const db = getDatabase()

      // Intel reports citing this entity
      const intel = db.prepare(
        'SELECT r.id, r.title, r.discipline, r.severity, r.created_at FROM intel_reports r JOIN intel_entities e ON r.id = e.report_id WHERE e.entity_type = ? AND e.entity_value = ? ORDER BY r.created_at DESC LIMIT ?'
      ).all(entityType, entityValue, limit) as Array<{ id: string; title: string; discipline: string; severity: string; created_at: number }>

      if (intel.length === 0) return { output: `No intel reports reference ${entityType}=${entityValue}.`, data: null }

      const intelIds = intel.map((r) => r.id)
      const placeholders = intelIds.map(() => '?').join(',')

      // HUMINTs / preliminaries that cite any of those intel reports
      const analystLinks = db.prepare(
        `SELECT source_report_id, target_report_id, link_type FROM intel_links WHERE target_report_id IN (${placeholders}) AND link_type IN ('humint_source', 'preliminary_reference')`
      ).all(...intelIds) as Array<{ source_report_id: string; target_report_id: string; link_type: string }>

      const productIds = Array.from(new Set(analystLinks.map((l) => l.source_report_id)))
      const products = productIds.length > 0 ? resolveNodesById(db, productIds) : new Map()

      // Open gaps on those preliminaries
      const prelimIds = Array.from(products.entries())
        .filter(([, n]) => (n as { type?: string }).type === 'preliminary')
        .map(([id]) => id)
      let gaps: Array<{ id: string; description: string; severity: string; preliminary_report_id: string }> = []
      if (prelimIds.length > 0) {
        const ph = prelimIds.map(() => '?').join(',')
        gaps = db.prepare(
          `SELECT id, description, severity, preliminary_report_id FROM intel_gaps WHERE preliminary_report_id IN (${ph}) AND status = 'open' LIMIT 15`
        ).all(...prelimIds) as Array<{ id: string; description: string; severity: string; preliminary_report_id: string }>
      }

      const lines: string[] = [`Entity lineage — ${entityType} = "${entityValue}"`, '']
      lines.push(`INTEL (${intel.length}):`)
      for (const r of intel.slice(0, 10)) {
        lines.push(`  [id:${r.id}] "${String(r.title || '').slice(0, 60)}" (${r.discipline}/${r.severity}, ${new Date(r.created_at).toISOString().slice(0, 10)})`)
      }

      const humintCount = Array.from(products.values()).filter((n) => (n as { type?: string }).type === 'humint').length
      const prelimCount = Array.from(products.values()).filter((n) => (n as { type?: string }).type === 'preliminary').length
      if (humintCount > 0 || prelimCount > 0) {
        lines.push(`\nANALYST PRODUCTS (${humintCount} HUMINTs, ${prelimCount} preliminaries):`)
        for (const [id, n] of products) {
          const typed = n as { type?: string; title?: string }
          const marker = typed.type === 'humint' ? `[humint:${id}]` : `[preliminary:${id}]`
          lines.push(`  ${marker} "${String(typed.title || '').slice(0, 60)}"`)
        }
      }

      if (gaps.length > 0) {
        lines.push(`\nOPEN GAPS (${gaps.length}):`)
        for (const g of gaps) {
          lines.push(`  [${g.severity}] ${String(g.description || '').slice(0, 100)}`)
        }
      }

      return {
        output: lines.join('\n'),
        data: { intel, products: Array.from(products.values()), gaps }
      }
    })

    log.info(`ToolRegistry: ${this.tools.size} tools registered`)
  }
}

export const toolRegistry = new ToolRegistryImpl()
