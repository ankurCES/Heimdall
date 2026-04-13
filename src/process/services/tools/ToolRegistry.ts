import { safeFetcher } from '../../collectors/SafeFetcher'
import { getDatabase } from '../database'
import { vectorDbService } from '../vectordb/VectorDbService'
import { intelRagService } from '../llm/IntelRagService'
import { intelEnricher } from '../enrichment/IntelEnricher'
import { kuzuService } from '../graphdb/KuzuService'
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

type ToolHandler = (params: Record<string, unknown>) => Promise<ToolResult>

class ToolRegistryImpl {
  private tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>()

  constructor() {
    this.registerBuiltins()
  }

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler })
  }

  getToolSchemas(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.tools.values()).map(({ def }) => ({
      type: 'function' as const,
      function: { name: def.name, description: def.description, parameters: def.parameters }
    }))
  }

  async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { output: `Unknown tool: ${name}`, error: 'TOOL_NOT_FOUND' }

    log.info(`Tool exec: ${name}(${JSON.stringify(params).slice(0, 100)})`)
    const start = Date.now()

    try {
      const result = await tool.handler(params)
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
      description: 'Search the intelligence database by keyword, discipline, or severity. Returns matching intel reports.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Search keywords' },
        discipline: { type: 'string', description: 'Filter by discipline (osint, cybint, finint, etc.)' },
        severity: { type: 'string', description: 'Filter by severity (critical, high, medium, low)' },
        limit: { type: 'number', description: 'Max results (default 10)' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params) => {
      const reports = intelRagService.searchReports(params.query as string, (params.limit as number) || 10)
      const filtered = reports.filter((r) => {
        if (params.discipline && r.discipline !== params.discipline) return false
        if (params.severity && r.severity !== params.severity) return false
        return true
      })
      return {
        output: filtered.map((r) => `[${r.severity.toUpperCase()}] ${r.title}\nDiscipline: ${r.discipline} | Source: ${r.sourceName}\n${r.content.slice(0, 300)}`).join('\n---\n'),
        data: filtered
      }
    })

    // ── Vector Search ──
    this.register({
      name: 'vector_search',
      description: 'Semantic similarity search across all intelligence data using vector embeddings.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Max results (default 8)' }
      }, required: ['query'] },
      requiresApproval: false
    }, async (params) => {
      const results = await vectorDbService.search(params.query as string, (params.limit as number) || 8)
      return {
        output: results.map((r) => `[${r.severity}] ${r.title} (score: ${r.score.toFixed(2)})\n${r.snippet}`).join('\n---\n'),
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
        'SELECT r.title, r.discipline, r.severity, r.source_name, substr(r.content, 1, 300) as snippet FROM intel_reports r JOIN intel_entities e ON r.id = e.report_id WHERE e.entity_type = ? AND e.entity_value = ? LIMIT 10'
      ).all(params.entity_type, params.entity_value) as Array<Record<string, unknown>>
      return {
        output: results.map((r) => `[${r.severity}] ${r.title}\n${r.discipline} | ${r.source_name}\n${r.snippet}`).join('\n---\n') || 'No matching reports found.',
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

    // ── Graph Query (Kuzu-powered with SQLite fallback) ──
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
      const queryType = (params.query_type as string) || 'connections'

      if (kuzuService.isReady()) {
        try {
          if (queryType === 'shortest_path' && params.target_id) {
            const result = await kuzuService.getShortestPath(params.report_id as string, params.target_id as string)
            const nodeList = result.nodes.map((n) => `${n.id.slice(0, 8)} "${n.title}" [${n.discipline}]`).join(' → ')
            return { output: result.nodes.length > 0 ? `Path: ${nodeList} (${result.links.length} hops)` : 'No path found.', data: result }
          }
          if (queryType === 'neighbors_2hop') {
            const result = await kuzuService.getNeighbors(params.report_id as string, 2)
            return { output: `Found ${result.nodes.length} nodes within 2 hops:\n${result.nodes.slice(0, 10).map((n) => `  ${n.id.slice(0, 8)} "${n.title}" [${n.discipline}/${n.severity}]`).join('\n')}`, data: result }
          }
          if (queryType === 'entity_pattern' && params.entity_value) {
            const result = await kuzuService.getPatternMatch(params.entity_type as string || 'ip', params.entity_value as string)
            return { output: `${result.nodes.length - 1} reports share entity "${params.entity_value}":\n${result.nodes.filter((n) => n.type !== 'entity').slice(0, 10).map((n) => `  ${n.id.slice(0, 8)} "${n.title}" [${n.discipline}]`).join('\n')}`, data: result }
          }
          // Default: connections
          const result = await kuzuService.getGraph({ reportId: params.report_id as string, linkType: params.link_type as string, limit: 20 })
          return { output: result.links.map((l) => `→ ${l.target.slice(0, 8)} [${l.type}] strength=${l.strength}`).join('\n') || 'No connections found.', data: result }
        } catch (err) {
          log.debug(`Kuzu graph_query failed: ${err}`)
        }
      }

      // SQLite fallback
      const links = intelEnricher.getLinks(params.report_id as string)
      const filtered = params.link_type ? links.filter((l) => l.linkType === params.link_type) : links
      return {
        output: filtered.map((l) => `→ ${l.linkedReportId.slice(0, 8)} [${l.linkType}] strength=${l.strength} "${l.reason}"`).join('\n') || 'No linked reports found.',
        data: filtered
      }
    })

    log.info(`ToolRegistry: ${this.tools.size} tools registered`)
  }
}

export const toolRegistry = new ToolRegistryImpl()
