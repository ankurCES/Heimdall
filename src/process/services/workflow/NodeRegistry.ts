/**
 * Node registry — defines all available node types for the visual
 * workflow builder. Each node type has typed inputs/outputs, a display
 * name, an icon key, and an execute function.
 *
 * Analysts can create custom node types via the UI (stored as
 * LLM-prompt-based transform nodes with user-defined I/O).
 */

export type DataType = 'text' | 'url' | 'url[]' | 'entity[]' | 'finding[]' | 'image[]' | 'report' | 'any'

export interface NodePort {
  name: string
  type: DataType
  description?: string
}

export interface NodeTypeDefinition {
  type: string
  label: string
  description: string
  category: 'source' | 'search' | 'fetch' | 'transform' | 'analysis' | 'output' | 'control'
  icon: string         // lucide icon name
  color: string        // tailwind border color class
  inputs: NodePort[]
  outputs: NodePort[]
  configSchema: Array<{
    name: string
    type: 'string' | 'number' | 'boolean' | 'select'
    label: string
    default?: unknown
    options?: Array<{ label: string; value: string }>
  }>
  /** If true, this node type was created by the analyst (not built-in). */
  isCustom?: boolean
  /** For custom nodes: the LLM prompt template with {{input}} placeholders. */
  customPrompt?: string
}

export interface NodeExecContext {
  nodeId: string
  config: Record<string, unknown>
  inputs: Record<string, unknown>
  onProgress?: (msg: string) => void
  sessionId?: string
  connectionId?: string
}

export type NodeExecutor = (ctx: NodeExecContext) => Promise<Record<string, unknown>>

class NodeRegistryImpl {
  private types = new Map<string, NodeTypeDefinition>()
  private executors = new Map<string, NodeExecutor>()

  register(def: NodeTypeDefinition, executor: NodeExecutor): void {
    this.types.set(def.type, def)
    this.executors.set(def.type, executor)
  }

  getType(type: string): NodeTypeDefinition | undefined {
    return this.types.get(type)
  }

  getAllTypes(): NodeTypeDefinition[] {
    return Array.from(this.types.values())
  }

  getByCategory(category: NodeTypeDefinition['category']): NodeTypeDefinition[] {
    return this.getAllTypes().filter((t) => t.category === category)
  }

  getExecutor(type: string): NodeExecutor | undefined {
    return this.executors.get(type)
  }

  /** Register a custom (analyst-created) node type. Backed by an LLM prompt. */
  registerCustom(def: NodeTypeDefinition & { customPrompt: string }): void {
    const executor: NodeExecutor = async (ctx) => {
      const { llmService } = await import('../llm/LlmService')
      let prompt = def.customPrompt
      // Replace {{input_name}} placeholders with actual input values.
      for (const [key, value] of Object.entries(ctx.inputs)) {
        prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value).slice(0, 5000))
      }
      for (const [key, value] of Object.entries(ctx.config)) {
        prompt = prompt.replace(new RegExp(`\\{\\{config\\.${key}\\}\\}`, 'g'), String(value))
      }
      ctx.onProgress?.(`Running custom node "${def.label}"…`)
      const response = await llmService.completeForTask('planner', prompt, ctx.connectionId, 2000)
      return { output: response }
    }
    this.register({ ...def, isCustom: true }, executor)
  }

  unregister(type: string): void {
    this.types.delete(type)
    this.executors.delete(type)
  }
}

export const nodeRegistry = new NodeRegistryImpl()

// ── Register built-in node types ─────────────────────────────────────

// Source nodes
nodeRegistry.register({
  type: 'UserQuery', label: 'User Query', description: 'The analyst\'s query text',
  category: 'source', icon: 'MessageSquare', color: 'border-blue-400',
  inputs: [], outputs: [{ name: 'query', type: 'text' }],
  configSchema: [{ name: 'query', type: 'string', label: 'Query', default: '' }]
}, async (ctx) => ({ query: ctx.config.query || ctx.inputs.query || '' }))

nodeRegistry.register({
  type: 'URLInput', label: 'URL Input', description: 'Specific URL to start from',
  category: 'source', icon: 'Globe', color: 'border-cyan-400',
  inputs: [], outputs: [{ name: 'url', type: 'url' }],
  configSchema: [{ name: 'url', type: 'string', label: 'URL', default: '' }]
}, async (ctx) => ({ url: ctx.config.url || '' }))

nodeRegistry.register({
  type: 'EntityInput', label: 'Entity Input', description: 'Specific entity (person, org, CVE, domain)',
  category: 'source', icon: 'Users', color: 'border-violet-400',
  inputs: [], outputs: [{ name: 'entity', type: 'text' }, { name: 'type', type: 'text' }],
  configSchema: [
    { name: 'entity', type: 'string', label: 'Entity value', default: '' },
    { name: 'entityType', type: 'select', label: 'Type', default: 'organization',
      options: [{ label: 'Person', value: 'person' }, { label: 'Organization', value: 'organization' },
        { label: 'CVE', value: 'cve' }, { label: 'Domain', value: 'domain' },
        { label: 'IP', value: 'ip' }, { label: 'Threat Actor', value: 'threat_actor' }] }
  ]
}, async (ctx) => ({ entity: ctx.config.entity || '', type: ctx.config.entityType || 'organization' }))

// Search nodes
nodeRegistry.register({
  type: 'IntelSearch', label: 'Intel Search', description: 'FTS5 database search',
  category: 'search', icon: 'Search', color: 'border-blue-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'results', type: 'finding[]' }],
  configSchema: [{ name: 'limit', type: 'number', label: 'Max results', default: 10 }]
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('intel_search', {
    query: ctx.inputs.query, limit: ctx.config.limit || 10
  })
  ctx.onProgress?.(`intel_search: ${r.error ? 'error' : 'done'}`)
  return { results: r.output }
})

nodeRegistry.register({
  type: 'WebSearch', label: 'Web Search', description: 'DuckDuckGo web search',
  category: 'search', icon: 'Globe', color: 'border-cyan-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'results', type: 'finding[]' }, { name: 'urls', type: 'url[]' }],
  configSchema: [{ name: 'maxResults', type: 'number', label: 'Max results', default: 5 }]
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const ddg = ['mcp:duckduckgo:search', 'mcp:duckduckgo:web_search'].find((n) => toolRegistry.hasName(n))
  if (!ddg) return { results: '(DuckDuckGo not available)', urls: [] }
  const r = await toolRegistry.execute(ddg, { query: ctx.inputs.query, max_results: ctx.config.maxResults || 5 })
  const urls = (r.output?.match(/https?:\/\/[^\s"'<>\])}]+/gi) || []).slice(0, 10)
  return { results: r.output, urls }
})

nodeRegistry.register({
  type: 'DarkWebSearch', label: 'Dark Web Search', description: 'Ahmia .onion search',
  category: 'search', icon: 'Moon', color: 'border-fuchsia-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'results', type: 'finding[]' }, { name: 'onionUrls', type: 'url[]' }],
  configSchema: [{ name: 'limit', type: 'number', label: 'Max results', default: 8 }]
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('ahmia_search', { query: ctx.inputs.query, limit: ctx.config.limit || 8 })
  const onionUrls = Array.isArray(r.data) ? (r.data as Array<{ onionUrl?: string }>).map((h) => h.onionUrl).filter(Boolean) : []
  return { results: r.output, onionUrls }
})

// Fetch nodes
nodeRegistry.register({
  type: 'WebFetch', label: 'Web Fetch', description: 'Fetch a URL',
  category: 'fetch', icon: 'Download', color: 'border-green-400',
  inputs: [{ name: 'url', type: 'url' }],
  outputs: [{ name: 'content', type: 'text' }, { name: 'urls', type: 'url[]' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('web_fetch', { url: ctx.inputs.url })
  const urls = r.data ? (r.data as { extractedUrls?: string[] }).extractedUrls || [] : []
  return { content: r.output, urls }
})

nodeRegistry.register({
  type: 'OnionFetch', label: 'Onion Fetch', description: 'Fetch .onion URL via Tor',
  category: 'fetch', icon: 'Shield', color: 'border-fuchsia-400',
  inputs: [{ name: 'url', type: 'url' }],
  outputs: [{ name: 'content', type: 'text' }, { name: 'urls', type: 'url[]' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('onion_fetch', { url: ctx.inputs.url, max_chars: 5000 })
  const urls = r.data ? (r.data as { extractedUrls?: string[] }).extractedUrls || [] : []
  return { content: r.output, urls }
})

// Transform nodes
nodeRegistry.register({
  type: 'ExtractEntities', label: 'Extract Entities', description: 'NER on text',
  category: 'transform', icon: 'Users', color: 'border-amber-400',
  inputs: [{ name: 'text', type: 'text' }],
  outputs: [{ name: 'entities', type: 'entity[]' }],
  configSchema: []
}, async (ctx) => {
  const text = String(ctx.inputs.text || '')
  const entities: Array<{ type: string; value: string }> = []
  const patterns: Array<[string, RegExp]> = [
    ['cve', /CVE-\d{4}-\d{4,7}/gi], ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
    ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g], ['domain', /\b([a-z0-9-]+\.)+[a-z]{2,6}\b/gi],
    ['btc', /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g], ['onion', /[a-z2-7]{16,56}\.onion/gi]
  ]
  for (const [type, re] of patterns) {
    for (const m of text.match(re) || []) entities.push({ type, value: m })
  }
  return { entities: JSON.stringify(entities) }
})

nodeRegistry.register({
  type: 'Summarize', label: 'Summarize', description: 'LLM text summarization',
  category: 'transform', icon: 'FileText', color: 'border-amber-400',
  inputs: [{ name: 'text', type: 'text' }],
  outputs: [{ name: 'summary', type: 'text' }],
  configSchema: [{ name: 'maxLength', type: 'number', label: 'Max words', default: 200 }]
}, async (ctx) => {
  const { llmService } = await import('../llm/LlmService')
  const response = await llmService.completeForTask('summary',
    `Summarize the following in ${ctx.config.maxLength || 200} words or less:\n\n${String(ctx.inputs.text).slice(0, 5000)}`,
    ctx.connectionId)
  return { summary: response }
})

nodeRegistry.register({
  type: 'ThreatAssessment', label: 'Threat Assessment', description: 'Rate threat level 1-10',
  category: 'analysis', icon: 'AlertTriangle', color: 'border-red-400',
  inputs: [{ name: 'text', type: 'text' }],
  outputs: [{ name: 'score', type: 'text' }, { name: 'assessment', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { llmService } = await import('../llm/LlmService')
  const response = await llmService.completeForTask('planner',
    `Rate the threat level of this content on a 1-10 scale.\n\nContent:\n${String(ctx.inputs.text).slice(0, 3000)}\n\nRespond with JSON: {"score": N, "label": "low|medium|high|critical", "rationale": "..."}`,
    ctx.connectionId, 200)
  try {
    const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}')
    return { score: String(parsed.score || 0), assessment: parsed.rationale || response }
  } catch { return { score: '0', assessment: response } }
})

// Output nodes
nodeRegistry.register({
  type: 'Briefing', label: 'Intelligence Briefing', description: 'Generate analyst briefing',
  category: 'output', icon: 'FileText', color: 'border-emerald-400',
  inputs: [{ name: 'findings', type: 'text' }],
  outputs: [{ name: 'briefing', type: 'text' }],
  configSchema: [{ name: 'style', type: 'select', label: 'Style', default: 'cia',
    options: [{ label: 'CIA/PDB', value: 'cia' }, { label: 'Military', value: 'military' }, { label: 'Executive', value: 'executive' }] }]
}, async (ctx) => {
  const { llmService } = await import('../llm/LlmService')
  const { response } = await llmService.chatForTask('analysis', [
    { role: 'system', content: 'You are a senior intelligence analyst. Produce a definitive intelligence briefing from the provided findings.' },
    { role: 'user', content: `Findings:\n${String(ctx.inputs.findings).slice(0, 8000)}\n\nProduce a ${ctx.config.style || 'CIA/PDB'}-style intelligence briefing.` }
  ], undefined, ctx.connectionId)
  return { briefing: response }
})

// Control flow
nodeRegistry.register({
  type: 'Merge', label: 'Merge', description: 'Combine outputs from multiple branches',
  category: 'control', icon: 'GitMerge', color: 'border-slate-400',
  inputs: [{ name: 'input1', type: 'any' }, { name: 'input2', type: 'any' }, { name: 'input3', type: 'any' }],
  outputs: [{ name: 'merged', type: 'text' }],
  configSchema: [{ name: 'separator', type: 'string', label: 'Separator', default: '\n\n---\n\n' }]
}, async (ctx) => {
  const sep = String(ctx.config.separator || '\n\n---\n\n')
  const parts = [ctx.inputs.input1, ctx.inputs.input2, ctx.inputs.input3]
    .filter(Boolean).map(String)
  return { merged: parts.join(sep) }
})

// ── Compound nodes (agent pipeline building blocks) ────────────────

nodeRegistry.register({
  type: 'Planner', label: 'Research Planner', description: 'LLM decomposes query into 2-4 research tasks',
  category: 'analysis', icon: 'Brain', color: 'border-violet-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'tasks', type: 'text' }, { name: 'taskCount', type: 'text' }],
  configSchema: [{ name: 'maxTasks', type: 'number', label: 'Max tasks', default: 4 }]
}, async (ctx) => {
  const { llmService } = await import('../llm/LlmService')
  const query = String(ctx.inputs.query || '')
  const prompt = `You are a deep-research planner. Decompose this query into 2-${ctx.config.maxTasks || 4} exhaustive research tasks.\n\nRespond ONLY with JSON array:\n[{"task":"...","search_terms":["..."],"discipline":"all|osint|cybint|..."}]\n\nQuery: ${query}`
  ctx.onProgress?.('Planning research tasks…')
  const raw = await llmService.completeForTaskWithMeta('planner', prompt, ctx.connectionId)
  const match = raw.response.match(/\[[\s\S]*\]/)
  const tasks = match ? JSON.parse(match[0]) : []
  return { tasks: JSON.stringify(tasks), taskCount: String(tasks.length) }
})

nodeRegistry.register({
  type: 'ForEachTask', label: 'For Each Task', description: 'Iterates over planner task list, runs connected nodes per task',
  category: 'control', icon: 'RefreshCw', color: 'border-slate-400',
  inputs: [{ name: 'tasks', type: 'text' }],
  outputs: [{ name: 'currentTask', type: 'text' }, { name: 'searchTerms', type: 'text' }, { name: 'allResults', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  // ForEachTask is a control-flow node — in the current engine it just
  // passes through the task list. The workflow engine's future loop
  // support will iterate properly. For now, concatenate all tasks.
  const tasks = (() => { try { return JSON.parse(String(ctx.inputs.tasks)) } catch { return [] } })() as Array<{ task: string; search_terms: string[] }>
  const combined = tasks.map((t: any) => `${t.task}: ${(t.search_terms || []).join(', ')}`).join('\n')
  const terms = tasks.flatMap((t: any) => t.search_terms || []).join(' ')
  return { currentTask: combined, searchTerms: terms, allResults: '' }
})

nodeRegistry.register({
  type: 'AdaptiveCrawl', label: 'Adaptive Crawl', description: 'Recursive web + darkweb crawl with signal-density scoring',
  category: 'fetch', icon: 'GitBranch', color: 'border-green-400',
  inputs: [{ name: 'urls', type: 'url[]' }, { name: 'taskContext', type: 'text' }],
  outputs: [{ name: 'findings', type: 'finding[]' }, { name: 'fileUrls', type: 'url[]' }, { name: 'imageUrls', type: 'url[]' }],
  configSchema: [
    { name: 'budget', type: 'number', label: 'Crawl budget (credits)', default: 50 },
    { name: 'maxBranches', type: 'number', label: 'Max branches per page', default: 3 }
  ]
}, async (ctx) => {
  const { AdaptiveCrawler } = await import('../llm/AdaptiveCrawler')
  const crawler = new AdaptiveCrawler(ctx.onProgress ? (c) => ctx.onProgress!(c) : undefined, (ctx.config.budget as number) || 50)
  crawler.setTaskContext(String(ctx.inputs.taskContext || ''), ctx.connectionId)
  const urls = (() => { try { return JSON.parse(String(ctx.inputs.urls || '[]')) } catch { return [] } })() as string[]
  const allFindings: string[] = []
  for (const url of urls.slice(0, 5)) {
    const findings = await crawler.crawl(url, 0)
    for (const f of findings) {
      if (!f.isFile) allFindings.push(`[${f.isOnion ? 'darkweb' : 'web'}:${f.hostname}] ${f.title}\n${f.content.slice(0, 300)}`)
    }
  }
  const stats = crawler.getStats()
  const images = crawler.getDiscoveredImages().map((i) => i.url)
  return {
    findings: allFindings.join('\n\n---\n\n'),
    fileUrls: JSON.stringify(stats.urlsExplored.filter((u) => /\.(pdf|txt|md|csv|json|xml|xlsx|doc|docx)$/i.test(u))),
    imageUrls: JSON.stringify(images)
  }
})

nodeRegistry.register({
  type: 'ImageDiscovery', label: 'Image Discovery', description: 'Download + vision-analyze images found during research',
  category: 'fetch', icon: 'Image', color: 'border-pink-400',
  inputs: [{ name: 'imageUrls', type: 'url[]' }, { name: 'taskContext', type: 'text' }],
  outputs: [{ name: 'results', type: 'text' }, { name: 'count', type: 'text' }],
  configSchema: [{ name: 'maxImages', type: 'number', label: 'Max images', default: 10 }]
}, async (ctx) => {
  const { ResearchImageIngester } = await import('../llm/ResearchImageIngester')
  const ingester = new ResearchImageIngester(ctx.sessionId || 'workflow')
  ingester.setTaskContext(String(ctx.inputs.taskContext || ''))
  const urls = (() => { try { return JSON.parse(String(ctx.inputs.imageUrls || '[]')) } catch { return [] } })() as string[]
  let count = 0
  for (const url of urls.slice(0, (ctx.config.maxImages as number) || 10)) {
    const r = await ingester.ingest({ url, sourcePageUrl: '', altText: null, estimatedRelevance: 'medium' }, ctx.onProgress ? (c) => ctx.onProgress!(c) : undefined)
    if (r) count++
  }
  return { results: `${count} images ingested`, count: String(count) }
})

nodeRegistry.register({
  type: 'FileDiscovery', label: 'File Discovery', description: 'Download + ingest files (PDF, TXT, etc.)',
  category: 'fetch', icon: 'FileDown', color: 'border-amber-400',
  inputs: [{ name: 'fileUrls', type: 'url[]' }, { name: 'taskContext', type: 'text' }],
  outputs: [{ name: 'results', type: 'text' }, { name: 'count', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { FileIngester } = await import('../llm/FileIngester')
  const ingester = new FileIngester(ctx.sessionId || 'workflow')
  const urls = (() => { try { return JSON.parse(String(ctx.inputs.fileUrls || '[]')) } catch { return [] } })() as string[]
  let count = 0
  for (const url of urls.slice(0, 10)) {
    const r = await ingester.ingest(url, ctx.onProgress ? (c) => ctx.onProgress!(c) : undefined)
    if (r) count++
  }
  return { results: `${count} files ingested`, count: String(count) }
})

nodeRegistry.register({
  type: 'ReactiveDiscovery', label: 'Reactive Discovery', description: 'Auto-resolve CVEs, domains, actors from content',
  category: 'analysis', icon: 'Zap', color: 'border-amber-400',
  inputs: [{ name: 'text', type: 'text' }],
  outputs: [{ name: 'enriched', type: 'text' }, { name: 'cves', type: 'text' }, { name: 'domains', type: 'text' }, { name: 'actors', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const text = String(ctx.inputs.text || '')
  const cves = Array.from(new Set(text.match(/CVE-\d{4}-\d{4,7}/gi) || [])).slice(0, 5)
  const domains = Array.from(new Set(text.match(/\b([a-z0-9-]+\.)+[a-z]{2,6}\b/gi) || []))
    .filter((d) => !['e.g', 'i.e', 'github.com', 'google.com', 'wikipedia.org'].includes(d.toLowerCase())).slice(0, 5)
  const ACTORS = ['lockbit', 'alphv', 'blackcat', 'conti', 'clop', 'akira', 'revil', 'lazarus', 'apt28', 'apt29']
  const actors = ACTORS.filter((a) => text.toLowerCase().includes(a))

  const parts: string[] = []
  for (const cve of cves) {
    try {
      const r = await toolRegistry.execute('cve_detail', { cve_id: cve.toUpperCase() })
      if (!r.error) parts.push(`[CVE] ${r.output.slice(0, 300)}`)
      ctx.onProgress?.(`Resolved ${cve}`)
    } catch { /* */ }
  }
  for (const d of domains.slice(0, 3)) {
    try {
      const r = await toolRegistry.execute('whois_lookup', { domain: d })
      if (!r.error) parts.push(`[WHOIS:${d}] ${r.output.slice(0, 200)}`)
    } catch { /* */ }
  }
  return {
    enriched: parts.join('\n\n'),
    cves: cves.join(', '),
    domains: domains.join(', '),
    actors: actors.join(', ')
  }
})

nodeRegistry.register({
  type: 'FollowUpCheck', label: 'Follow-Up Check', description: 'Classifies query as new topic or follow-up',
  category: 'control', icon: 'GitFork', color: 'border-slate-400',
  inputs: [{ name: 'query', type: 'text' }, { name: 'history', type: 'text' }],
  outputs: [{ name: 'intent', type: 'text' }, { name: 'confidence', type: 'text' }, { name: 'query', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { detectFollowUp, buildContext } = await import('../llm/FollowUpDetector')
  const history = (() => { try { return JSON.parse(String(ctx.inputs.history || '[]')) } catch { return [] } })()
  const result = detectFollowUp(String(ctx.inputs.query || ''), buildContext(history))
  return { intent: result.intent, confidence: String(result.confidence), query: String(ctx.inputs.query || '') }
})

nodeRegistry.register({
  type: 'VectorSearch', label: 'Vector Search', description: 'Semantic similarity search',
  category: 'search', icon: 'Brain', color: 'border-violet-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'results', type: 'finding[]' }],
  configSchema: [{ name: 'limit', type: 'number', label: 'Max results', default: 8 }]
}, async (ctx) => {
  const { vectorDbService } = await import('../vectordb/VectorDbService')
  try {
    const results = await vectorDbService.search(String(ctx.inputs.query || ''), (ctx.config.limit as number) || 8)
    return { results: results.map((r) => `[${r.severity}] ${r.title} (score=${r.score.toFixed(2)})\n${r.snippet}`).join('\n---\n') }
  } catch { return { results: '(vector search failed)' } }
})

nodeRegistry.register({
  type: 'CVELookup', label: 'CVE Lookup', description: 'Look up CVE details from NVD',
  category: 'search', icon: 'Bug', color: 'border-red-400',
  inputs: [{ name: 'cveId', type: 'text' }],
  outputs: [{ name: 'details', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('cve_detail', { cve_id: String(ctx.inputs.cveId || '') })
  return { details: r.output }
})

nodeRegistry.register({
  type: 'WhoisLookup', label: 'WHOIS Lookup', description: 'RDAP/WHOIS for a domain',
  category: 'search', icon: 'Globe', color: 'border-emerald-400',
  inputs: [{ name: 'domain', type: 'text' }],
  outputs: [{ name: 'whois', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('whois_lookup', { domain: String(ctx.inputs.domain || '') })
  return { whois: r.output }
})

nodeRegistry.register({
  type: 'DnsResolve', label: 'DNS Resolve', description: 'Resolve DNS records',
  category: 'search', icon: 'Network', color: 'border-emerald-400',
  inputs: [{ name: 'domain', type: 'text' }],
  outputs: [{ name: 'records', type: 'text' }],
  configSchema: [{ name: 'type', type: 'select', label: 'Record type', default: 'A',
    options: [{ label: 'A', value: 'A' }, { label: 'AAAA', value: 'AAAA' }, { label: 'MX', value: 'MX' }, { label: 'NS', value: 'NS' }, { label: 'TXT', value: 'TXT' }] }]
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('dns_resolve', { domain: String(ctx.inputs.domain || ''), type: ctx.config.type || 'A' })
  return { records: r.output }
})

nodeRegistry.register({
  type: 'AhmiaSearch', label: 'Ahmia Search', description: 'Dark-web .onion search via Ahmia',
  category: 'search', icon: 'Moon', color: 'border-fuchsia-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'results', type: 'text' }, { name: 'onionUrls', type: 'url[]' }],
  configSchema: [{ name: 'limit', type: 'number', label: 'Max results', default: 8 }]
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('ahmia_search', { query: String(ctx.inputs.query || ''), limit: ctx.config.limit || 8 })
  const urls = Array.isArray(r.data) ? (r.data as Array<{ onionUrl?: string }>).map((h) => h.onionUrl).filter(Boolean) : []
  return { results: r.output, onionUrls: JSON.stringify(urls) }
})

nodeRegistry.register({
  type: 'WikipediaSearch', label: 'Wikipedia Search', description: 'Wikipedia entity context via MCP',
  category: 'search', icon: 'BookOpen', color: 'border-blue-400',
  inputs: [{ name: 'query', type: 'text' }],
  outputs: [{ name: 'content', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  if (!toolRegistry.hasName('mcp:wikipedia:search')) return { content: '(Wikipedia MCP not connected)' }
  const r = await toolRegistry.execute('mcp:wikipedia:search', { query: String(ctx.inputs.query || '') })
  return { content: r.output }
})

nodeRegistry.register({
  type: 'EntityLookup', label: 'Entity Lookup', description: 'Find reports by entity (IP, CVE, domain, etc.)',
  category: 'search', icon: 'Users', color: 'border-violet-400',
  inputs: [{ name: 'entityType', type: 'text' }, { name: 'entityValue', type: 'text' }],
  outputs: [{ name: 'results', type: 'finding[]' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('entity_lookup', {
    entity_type: String(ctx.inputs.entityType || 'ip'),
    entity_value: String(ctx.inputs.entityValue || '')
  })
  return { results: r.output }
})

nodeRegistry.register({
  type: 'ShellExec', label: 'Shell Command', description: 'Execute an allowed shell command (curl, dig, nslookup, etc.)',
  category: 'fetch', icon: 'Terminal', color: 'border-slate-400',
  inputs: [{ name: 'command', type: 'text' }],
  outputs: [{ name: 'output', type: 'text' }],
  configSchema: []
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('shell_exec', { command: String(ctx.inputs.command || '') })
  return { output: r.output }
})

nodeRegistry.register({
  type: 'CreateReport', label: 'Create Report', description: 'Save findings as an intel report in the database',
  category: 'output', icon: 'FilePlus', color: 'border-emerald-400',
  inputs: [{ name: 'title', type: 'text' }, { name: 'content', type: 'text' }],
  outputs: [{ name: 'reportId', type: 'text' }],
  configSchema: [
    { name: 'discipline', type: 'select', label: 'Discipline', default: 'osint',
      options: [{ label: 'OSINT', value: 'osint' }, { label: 'CYBINT', value: 'cybint' }, { label: 'FININT', value: 'finint' }, { label: 'HUMINT', value: 'humint' }, { label: 'IMINT', value: 'imint' }] },
    { name: 'severity', type: 'select', label: 'Severity', default: 'medium',
      options: [{ label: 'Critical', value: 'critical' }, { label: 'High', value: 'high' }, { label: 'Medium', value: 'medium' }, { label: 'Low', value: 'low' }] }
  ]
}, async (ctx) => {
  const { toolRegistry } = await import('../tools/ToolRegistry')
  const r = await toolRegistry.execute('create_report', {
    title: String(ctx.inputs.title || 'Untitled'),
    content: String(ctx.inputs.content || ''),
    discipline: ctx.config.discipline || 'osint',
    severity: ctx.config.severity || 'medium'
  })
  return { reportId: r.output }
})

nodeRegistry.register({
  type: 'Condition', label: 'Condition', description: 'If/else branching based on content',
  category: 'control', icon: 'GitFork', color: 'border-slate-400',
  inputs: [{ name: 'value', type: 'text' }, { name: 'condition', type: 'text' }],
  outputs: [{ name: 'trueOutput', type: 'text' }, { name: 'falseOutput', type: 'text' }],
  configSchema: [{ name: 'operator', type: 'select', label: 'Operator', default: 'contains',
    options: [{ label: 'Contains', value: 'contains' }, { label: 'Equals', value: 'equals' }, { label: 'Greater than', value: 'gt' }, { label: 'Less than', value: 'lt' }] }]
}, async (ctx) => {
  const value = String(ctx.inputs.value || '')
  const condition = String(ctx.inputs.condition || '')
  let matches = false
  switch (ctx.config.operator) {
    case 'contains': matches = value.toLowerCase().includes(condition.toLowerCase()); break
    case 'equals': matches = value === condition; break
    case 'gt': matches = parseFloat(value) > parseFloat(condition); break
    case 'lt': matches = parseFloat(value) < parseFloat(condition); break
  }
  return { trueOutput: matches ? value : '', falseOutput: matches ? '' : value }
})

// ── Auto-register MCP tools as workflow nodes ──────────────────────
// This runs lazily when the node registry is first queried — by then
// the MCP servers have started and their tools are in ToolRegistry.

let mcpNodesRegistered = false

/** Call this after MCP servers are up to expose all MCP tools as
 *  workflow nodes. Each tool becomes a node with its schema's params
 *  as inputs and a single 'output' text port. */
export async function registerMcpToolNodes(): Promise<void> {
  if (mcpNodesRegistered) return
  mcpNodesRegistered = true

  const { toolRegistry } = await import('../tools/ToolRegistry')
  const schemas = toolRegistry.getToolSchemas()
  for (const schema of schemas) {
    const toolName = schema.function.name
    // Skip tools already registered as explicit nodes.
    if (nodeRegistry.getType(toolName) || nodeRegistry.getType(toolName.replace(/[^a-zA-Z0-9]/g, '_'))) continue

    const params = (schema.function.parameters as any)?.properties || {}
    const required = (schema.function.parameters as any)?.required || []
    const inputs: NodePort[] = Object.entries(params).map(([name, def]: [string, any]) => ({
      name, type: 'text' as DataType, description: def?.description || name
    }))

    const nodeType = `tool_${toolName.replace(/[^a-zA-Z0-9]/g, '_')}`
    const isMcp = toolName.startsWith('mcp:')
    const label = isMcp ? toolName.replace('mcp:', '').replace(/:/g, ' → ') : toolName.replace(/_/g, ' ')

    nodeRegistry.register({
      type: nodeType,
      label: `🔧 ${label}`,
      description: schema.function.description?.slice(0, 100) || toolName,
      category: isMcp ? 'search' : 'fetch',
      icon: isMcp ? 'Sparkles' : 'Wrench',
      color: isMcp ? 'border-amber-400' : 'border-cyan-400',
      inputs,
      outputs: [{ name: 'output', type: 'text' }],
      configSchema: []
    }, async (ctx) => {
      const callParams: Record<string, unknown> = {}
      for (const [key] of Object.entries(params)) {
        if (ctx.inputs[key] !== undefined) callParams[key] = ctx.inputs[key]
      }
      ctx.onProgress?.(`Calling ${toolName}…`)
      const r = await toolRegistry.execute(toolName, callParams, { sessionId: ctx.sessionId })
      return { output: r.output || '' }
    })
  }
}
