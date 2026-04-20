import { llmService, type ChatMessage } from './LlmService'
import { intelRagService } from './IntelRagService'
import { vectorDbService } from '../vectordb/VectorDbService'
import { toolRegistry } from '../tools/ToolRegistry'
import { settingsService } from '../settings/SettingsService'
import { agenticPlanStore, makeCall, type PlanPreview, type PlanStep, type ProposedToolCall } from './AgenticPlanStore'
import { refineProposedCalls } from './SearchRefiner'
import { detectFollowUp, buildContext, type QueryIntent } from './FollowUpDetector'
import { AdaptiveCrawler, type Finding, type CrawlStats, type DiscoveredImage } from './AdaptiveCrawler'
import { FileIngester, type IngestedFile } from './FileIngester'
import { ResearchImageIngester } from './ResearchImageIngester'
import { generateId } from '@common/utils/id'
import type { DarkWebConfig } from '@common/types/settings'
import type { PlanEdits } from './AgenticChatOrchestrator'
import log from 'electron-log'

/**
 * Deep Research Agent — deepagents-style recursive research pipeline.
 *
 * Key differences from AgenticChatOrchestrator:
 *   - Detects follow-ups and responds directly (no plan modal)
 *   - Auto-researches BEFORE showing the plan modal (preliminary findings)
 *   - Reactive tool selection (discovers tools from content, not upfront)
 *   - Recursive web + darkweb crawling up to depth 4
 *   - Auto-downloads + ingests files (PDF, TXT, MD, CSV, JSON, XML, XLSX)
 *   - No time cap — bounded by depth (4) + cycle detection only
 */

const PLANNER_PROMPT = `You are a deep-research planner for an intelligence platform. Given a query, decompose it into 2-4 exhaustive research tasks.

Each task should explore a different angle. Be specific about what to search for.

Respond ONLY with a JSON array:
[
  {"task": "...", "search_terms": ["term1", "term2", "term3"], "discipline": "all|osint|cybint|finint|..."},
  ...
]

User query: `

const ANALYST_PROMPT = `You are a senior all-source intelligence analyst preparing an assessment for the Director of a national intelligence agency. Your audience holds the highest clearance and expects precision, analytical rigor, and actionable conclusions — not summaries or hedging.

You have been given exhaustive research findings from multiple collection disciplines: OSINT (open-source), CYBINT (cyber), HUMINT (human intelligence via Telegram sources), IMINT (imagery), SIGINT (signals), dark-web reconnaissance (.onion sites via Tor), file ingestion (PDFs, documents), and knowledge-graph analysis.

Produce a DEFINITIVE INTELLIGENCE ASSESSMENT. Write in the style of a classified analytic product (PDB/NIE/SNIE). Every assertion must be sourced. Every judgment must carry a confidence qualifier per ICD 203 (using "almost certainly", "likely", "roughly even odds", "unlikely", "remote") — never use vague words like "might" or "could" without a probability anchor.

## REQUIRED FORMAT

### CLASSIFICATION BANNER
State: UNCLASSIFIED // FOR OFFICIAL USE ONLY (FOUO)
Date, Analyst: Heimdall Automated Intelligence Platform

### EXECUTIVE SUMMARY
2-4 sentences. The single most important takeaway first. Include the overall threat level (CRITICAL / HIGH / ELEVATED / GUARDED / LOW) and confidence level (HIGH / MODERATE / LOW).

### KEY JUDGMENTS
Numbered list. Each judgment is a standalone analytic statement with a confidence qualifier and source citation. These are the lines the Director reads first.

### DETAILED ANALYSIS
Narrative form. Walk through the evidence supporting each key judgment. Organize by theme, not by source. Cross-reference between internal intelligence, open-source reporting, dark-web indicators, and any ingested files. Use subheadings for major themes.

Cite sources inline using brackets: [OSINT: source-name], [DARKWEB: host.onion], [INTERNAL: report-title], [FILE: filename], [HUMINT: source], [CYBINT: source].

### THREAT INDICATORS & IOCs
Table or bullet list of specific, actionable indicators: IP addresses, domains, hashes, CVEs, Bitcoin addresses, .onion URLs, Telegram handles, email addresses, threat-actor names. Each with context for what it indicates.

### CONNECTIONS & NETWORK ANALYSIS
Map relationships between entities: people, organizations, infrastructure, financial flows, communication channels. Note which connections are confirmed vs. assessed.

### CHRONOLOGICAL TIMELINE
Key events in date order with source attribution. Distinguish between confirmed events and reported/assessed events.

### RECOMMENDED COLLECTION ACTIONS
Specific tasking recommendations for each intelligence discipline. What should be monitored next? What sources need development? What gaps require new collection?

### INFORMATION GAPS & ANALYTIC CAVEATS
What we don't know. Where are the blind spots? Which judgments rest on single-source reporting? Where might adversary denial & deception be at play?

### DISSEMINATION RECOMMENDATION
Who needs to see this assessment and with what urgency?

## RULES
- NEVER hedge without a probability anchor. Instead of "Iran may be involved", write "Iran is likely (moderate confidence) involved, based on [source]."
- NEVER present raw data without analysis. Every fact must serve a judgment.
- ALWAYS distinguish between FACT (confirmed by multiple sources), ASSESSMENT (analytic judgment), and SPECULATION (single-source or inferential).
- If sources conflict, present both positions and state which you assess as more credible and why.
- Length: as detailed as the evidence warrants. Do not truncate analysis for brevity. The Director expects completeness.
- Write with authority. You are the subject-matter expert.`

interface RawPlanStep {
  task: string
  search_terms: string[]
  discipline: string
}

/** Research findings collected during auto-research phase. */
export interface PreliminaryFindings {
  internalHits: number
  webPagesCrawled: number
  darkwebPagesCrawled: number
  filesDownloaded: number
  filesIngested: number
  cvesResolved: number
  domainsResolved: number
  actorsDetected: string[]
  imagesDiscovered: number
  crawlStats: CrawlStats
  downloadedFiles: IngestedFile[]
  /** Truncated text summaries of top findings for the modal. */
  topFindings: Array<{ source: string; title: string; snippet: string; relevance: number }>
}

export class DeepResearchAgent {
  /**
   * Classify the query — returns 'follow_up' or 'new_topic'.
   * Called by chatBridge to decide whether to show the plan modal.
   */
  classifyQuery(
    query: string,
    history: ChatMessage[]
  ): { intent: QueryIntent; confidence: number; reason: string } {
    const ctx = buildContext(history.map((m) => ({ role: m.role, content: m.content })))
    return detectFollowUp(query, ctx)
  }

  /**
   * Handle a follow-up query directly — no plan modal, no auto-research.
   * Uses hybrid RAG + inline tool calls for fast response.
   */
  async handleFollowUp(
    query: string,
    history: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    onChunk?.('**[Follow-up]** Responding directly (no plan needed)…\n\n')

    // Hybrid RAG: vector + keyword search.
    let vectorContext = ''
    try {
      const results = await vectorDbService.search(query, 6)
      if (results.length > 0) {
        vectorContext = results.map((r, i) =>
          `[${i + 1}] ${r.title} (${r.severity}, score=${r.score.toFixed(2)})\n${r.snippet}`
        ).join('\n\n')
        onChunk?.(`**[Tool: vector_search]** ${results.length} hits\n`)
      }
    } catch { /* vector DB may be corrupt */ }

    const contextMessages = intelRagService.buildContextMessages(query)
    const summary = intelRagService.getRecentSummary(24)

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are Heimdall, an intelligence analyst. Answer the follow-up question using the provided context and prior conversation. Be concise but thorough.' },
      { role: 'system', content: summary },
      ...contextMessages,
      ...(vectorContext ? [{ role: 'system' as const, content: `Relevant intelligence:\n\n${vectorContext}` }] : []),
      ...history.slice(-8),
      { role: 'user', content: query }
    ]

    const { response } = await llmService.chatForTask('chat', messages, onChunk, connectionId)
    return response
  }

  /**
   * Build a plan WITH preliminary auto-research. This is the heavy phase
   * — runs all research before returning the plan for analyst approval.
   * No time cap; bounded by depth (4) + cycle detection.
   */
  async buildPlanWithResearch(
    query: string,
    history: ChatMessage[],
    sessionId: string,
    connectionId?: string,
    onChunk?: (chunk: string) => void,
    opts: { reworkFeedback?: string; previousPlanId?: string } = {}
  ): Promise<{ preview: PlanPreview; findings: PreliminaryFindings } | null> {
    log.info(`DeepResearchAgent: buildPlanWithResearch "${query.slice(0, 60)}…"`)

    // Phase 1: Plan.
    onChunk?.('**[Planning]** Decomposing query into research tasks…\n')
    const rawSteps = await this.plan(query, connectionId, opts)
    if (!rawSteps || rawSteps.length === 0) return null

    onChunk?.(`**[Plan]** ${rawSteps.length} research tasks:\n${rawSteps.map((s, i) => `  ${i + 1}. ${s.task}`).join('\n')}\n\n`)

    // Phase 2: Auto-research (exhaustive, no time cap).
    const crawler = new AdaptiveCrawler(onChunk)
    const fileIngester = new FileIngester(sessionId)
    const imageIngester = new ResearchImageIngester(sessionId)
    const allFindings: string[] = []
    const findings: PreliminaryFindings = {
      internalHits: 0, webPagesCrawled: 0, darkwebPagesCrawled: 0,
      filesDownloaded: 0, filesIngested: 0, cvesResolved: 0,
      domainsResolved: 0, actorsDetected: [], imagesDiscovered: 0,
      crawlStats: crawler.getStats(),
      downloadedFiles: [], topFindings: []
    }

    // Per-task research loop with reactive tool discovery.
    for (let i = 0; i < rawSteps.length; i++) {
      const step = rawSteps[i]
      onChunk?.(`\n**[Research ${i + 1}/${rawSteps.length}]** ${step.task}\n`)
      crawler.setTaskContext(step.task + ' ' + step.search_terms.join(' '), connectionId)

      // Core searches — always run.
      const taskFindings: string[] = []

      // FTS5 intel_search.
      for (const term of step.search_terms.slice(0, 3)) {
        try {
          const reports = intelRagService.searchReportsRanked(term, 5)
          if (reports.length > 0) {
            onChunk?.(`**[Tool: intel_search]** "${term}" → ${reports.length} hits\n`)
            findings.internalHits += reports.length
            for (const r of reports) {
              taskFindings.push(`[internal] ${r.title} (${r.severity}) — ${r.content.slice(0, 300)}`)
              findings.topFindings.push({
                source: 'internal', title: r.title,
                snippet: r.content.slice(0, 200), relevance: Math.abs(r.score)
              })
            }
          }
        } catch { /* */ }
      }

      // Vector search.
      try {
        const results = await vectorDbService.search(step.search_terms[0] || step.task, 5)
        if (results.length > 0) {
          onChunk?.(`**[Tool: vector_search]** ${results.length} semantic hits\n`)
          for (const r of results) {
            taskFindings.push(`[vector] ${r.title} (score=${r.score.toFixed(2)}) — ${r.snippet.slice(0, 300)}`)
          }
        }
      } catch { /* vector DB may be corrupt */ }

      // Web search (DuckDuckGo via MCP).
      const ddg = this.firstAvailable(['mcp:duckduckgo:search', 'mcp:duckduckgo:web_search'])
      if (ddg) {
        try {
          const r = await toolRegistry.execute(ddg, { query: step.search_terms.join(' '), max_results: 5 })
          if (!r.error && r.output) {
            onChunk?.(`**[Tool: ${ddg}]** "${step.search_terms.join(' ')}"\n`)
            taskFindings.push(`[web:duckduckgo] ${r.output.slice(0, 1000)}`)

            // Extract URLs from DuckDuckGo results and crawl them.
            const urls = (r.output.match(/https?:\/\/[^\s"'<>\])}]+/gi) || [])
              .map((u: string) => u.replace(/[.,;:!?)}\]'"]+$/, ''))
              .filter((u: string) => !/duckduckgo\.com/i.test(u))
              .slice(0, 3)
            for (const url of urls) {
              const crawlFindings = await crawler.crawl(url, 0)
              for (const f of crawlFindings) {
                if (f.isFile) {
                  const ingested = await fileIngester.ingest(f.url, onChunk)
                  if (ingested) {
                    findings.filesDownloaded++
                    if (ingested.vectorId) findings.filesIngested++
                  }
                } else {
                  taskFindings.push(`[web:${f.hostname}] ${f.title} — ${f.content.slice(0, 300)}`)
                  findings.webPagesCrawled++
                  findings.topFindings.push({
                    source: f.isOnion ? 'darkweb' : 'web', title: f.title,
                    snippet: f.content.slice(0, 200), relevance: f.relevanceScore
                  })
                }
              }
            }
          }
        } catch { /* */ }
      }

      // Wikipedia (for entity context).
      if (toolRegistry.hasName('mcp:wikipedia:search')) {
        try {
          const r = await toolRegistry.execute('mcp:wikipedia:search', { query: step.search_terms[0] || step.task })
          if (!r.error && r.output) {
            onChunk?.(`**[Tool: mcp:wikipedia:search]** "${step.search_terms[0]}"\n`)
            taskFindings.push(`[mcp:wikipedia] ${r.output.slice(0, 800)}`)
          }
        } catch { /* */ }
      }

      // Dark-web search (Ahmia + auto onion_fetch + recursive crawl).
      const dw = settingsService.get<DarkWebConfig>('darkWeb')
      if (dw?.enabled && dw?.ahmiaEnabled) {
        try {
          const r = await toolRegistry.execute('ahmia_search', { query: step.search_terms[0] || step.task, limit: 8 })
          if (!r.error && Array.isArray(r.data)) {
            const hits = r.data as Array<{ onionUrl?: string; title?: string }>
            onChunk?.(`**[Tool: ahmia_search]** "${step.search_terms[0]}" → ${hits.length} .onion results\n`)

            // Crawl top onion URLs with recursive depth.
            const onionUrls = hits
              .map((h) => h.onionUrl)
              .filter((u): u is string => !!u && /\.onion/i.test(u))
              .slice(0, 5)
            for (const url of onionUrls) {
              const crawlFindings = await crawler.crawl(url, 0)
              for (const f of crawlFindings) {
                if (f.isOnion) findings.darkwebPagesCrawled++
                if (f.isFile) {
                  const ingested = await fileIngester.ingest(f.url, onChunk)
                  if (ingested) {
                    findings.filesDownloaded++
                    if (ingested.vectorId) findings.filesIngested++
                  }
                } else {
                  taskFindings.push(`[darkweb:${f.hostname}] ${f.title} — ${f.content.slice(0, 300)}`)
                  findings.topFindings.push({
                    source: 'darkweb', title: f.title,
                    snippet: f.content.slice(0, 200), relevance: f.relevanceScore
                  })
                }
              }
            }
          }
        } catch { /* */ }
      }

      // Reactive tool discovery — scan findings for entities.
      await this.reactiveDiscovery(taskFindings, crawler, onChunk, findings)

      if (taskFindings.length > 0) {
        allFindings.push(`### Research task ${i + 1}: ${step.task}\n\n${taskFindings.join('\n\n---\n\n')}`)
      }
    }

    // Ingest discovered images (after all tasks complete).
    const discoveredImages = crawler.getDiscoveredImages()
    if (discoveredImages.length > 0) {
      onChunk?.(`\n**[Image ingestion]** ${discoveredImages.length} images discovered, ingesting…\n`)
      imageIngester.setTaskContext(query)
      for (const img of discoveredImages.slice(0, 20)) {
        await imageIngester.ingest(img, onChunk)
      }
    }

    // Update stats.
    findings.crawlStats = crawler.getStats()
    findings.imagesDiscovered = discoveredImages.length
    findings.downloadedFiles = fileIngester.getFiles()
    findings.topFindings.sort((a, b) => b.relevance - a.relevance)
    findings.topFindings = findings.topFindings.slice(0, 20)

    onChunk?.(`\n**[Research complete]** ${findings.internalHits} internal + ${findings.webPagesCrawled} web + ${findings.darkwebPagesCrawled} darkweb + ${findings.filesDownloaded} files\n`)

    // Phase 3: Build proposed tool calls for the approval modal.
    // These are ADDITIONAL deep-dives the agent suggests based on what
    // it found during auto-research. The analyst can toggle them.
    const proposedCalls = this.buildProposedCalls(rawSteps, findings, query)

    // Refine queries in background (non-blocking).
    const preview: PlanPreview = {
      planId: generateId(),
      sessionId,
      query,
      steps: rawSteps.map((s) => ({ task: s.task, searchTerms: s.search_terms, discipline: s.discipline })),
      proposedCalls,
      reworkHistory: opts.reworkFeedback ? [{ feedback: opts.reworkFeedback, at: Date.now() }] : [],
      createdAt: Date.now()
    }

    if (opts.previousPlanId) {
      const prev = agenticPlanStore.get(opts.previousPlanId)
      if (prev) preview.reworkHistory = [...prev.reworkHistory, ...preview.reworkHistory]
    }

    // Store the auto-research findings alongside the plan so executeApproved
    // can include them in the analyst synthesis.
    agenticPlanStore.put(preview, history, connectionId)
    // Store findings as extra data on the plan (extend the store).
    ;(agenticPlanStore as any)._findings = (agenticPlanStore as any)._findings || new Map()
    ;(agenticPlanStore as any)._findings.set(preview.planId, { allFindings, findings })

    log.info(`DeepResearchAgent: plan ${preview.planId} ready — ${rawSteps.length} steps, ${proposedCalls.length} proposed calls, findings: ${findings.internalHits} internal / ${findings.webPagesCrawled} web / ${findings.darkwebPagesCrawled} darkweb / ${findings.filesDownloaded} files`)

    return { preview, findings }
  }

  /**
   * Execute the approved plan. Runs any remaining proposed tool calls
   * the analyst approved, then synthesizes ALL findings (auto-research
   * + execution-phase) into the final briefing.
   */
  async executeApproved(
    planId: string,
    edits: PlanEdits,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const plan = agenticPlanStore.get(planId)
    if (!plan) throw new Error(`Plan ${planId} not found or expired`)

    // Retrieve auto-research findings.
    const storedFindings = (agenticPlanStore as any)._findings?.get(planId) as {
      allFindings: string[]; findings: PreliminaryFindings
    } | undefined
    const allFindings = storedFindings?.allFindings || []

    // Apply edits.
    const disabled = new Set(edits.disabledCallIds || [])
    const calls = plan.proposedCalls
      .filter((c) => !disabled.has(c.id))
      .map((c) => {
        const override = edits.editedQueries?.[c.id]
        return override?.trim() ? { ...c, query: override.trim() } : c
      })

    onChunk?.(`**[Executing]** ${calls.length} approved tool call(s)…\n`)

    // Execute approved calls.
    const crawler = new AdaptiveCrawler(onChunk)
    for (const c of calls) {
      const params = this.buildParams(c)
      onChunk?.(`\n**[Tool: ${c.tool}]** ${JSON.stringify(params).slice(0, 120)}\n`)
      try {
        const r = await toolRegistry.execute(c.tool, params)
        if (!r.error && r.output) {
          onChunk?.('```\n' + r.output.slice(0, 600) + '\n```\n')
          allFindings.push(`**${c.tool}** "${c.query.slice(0, 80)}"\n${r.output.slice(0, 1500)}`)

          // If the result contains URLs, recursively crawl them.
          if (c.group === 'web' || c.group === 'mcp') {
            const urls = (r.output.match(/https?:\/\/[^\s"'<>\])}]+/gi) || [])
              .slice(0, 2)
            for (const url of urls) {
              crawler.setTaskContext(c.query)
              await crawler.crawl(url, 0)
            }
          }
        } else if (r.error) {
          onChunk?.(`  → error: ${r.error.slice(0, 80)}\n`)
        }
      } catch (err) {
        onChunk?.(`  → error: ${(err as Error).message.slice(0, 80)}\n`)
      }
    }

    // Add any crawler findings from the execution phase.
    for (const f of crawler.getFindings()) {
      if (!f.isFile) {
        allFindings.push(`[${f.isOnion ? 'darkweb' : 'web'}:${f.hostname}] ${f.title}\n${f.content.slice(0, 500)}`)
      }
    }

    if (allFindings.length === 0) {
      return 'No findings produced from the research. Try a different query or add more tool calls.'
    }

    // Synthesize.
    onChunk?.(`\n**[Analyzing]** Synthesizing ${allFindings.length} finding group(s)…\n\n---\n\n`)
    const result = await this.analyze(plan.query, allFindings, plan.history, plan.connectionId, onChunk, edits.approvalComments)

    // Cleanup.
    agenticPlanStore.remove(planId)
    ;(agenticPlanStore as any)._findings?.delete(planId)

    return result
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /** Reactive tool discovery — scan findings for entities worth following up. */
  private async reactiveDiscovery(
    findings: string[],
    crawler: AdaptiveCrawler,
    onChunk?: (chunk: string) => void,
    stats?: PreliminaryFindings
  ): Promise<void> {
    const allText = findings.join('\n')

    // CVEs.
    const cves = Array.from(new Set(allText.match(/CVE-\d{4}-\d{4,7}/gi) || []))
    for (const cve of cves.slice(0, 3)) {
      try {
        const r = await toolRegistry.execute('cve_detail', { cve_id: cve.toUpperCase() })
        if (!r.error) {
          onChunk?.(`**[Auto-discovered: cve_detail]** ${cve}\n`)
          findings.push(`[cve] ${r.output.slice(0, 500)}`)
          if (stats) stats.cvesResolved++
        }
      } catch { /* */ }
    }

    // Domains.
    const domainRe = /\b([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,6}\b/gi
    const domains = Array.from(new Set(allText.match(domainRe) || []))
      .filter((d) => !['e.g', 'i.e', 'etc.al', 'github.com', 'google.com', 'wikipedia.org'].includes(d.toLowerCase()))
      .slice(0, 3)
    for (const d of domains) {
      try {
        const r = await toolRegistry.execute('whois_lookup', { domain: d })
        if (!r.error) {
          onChunk?.(`**[Auto-discovered: whois_lookup]** ${d}\n`)
          findings.push(`[domain:${d}] ${r.output.slice(0, 300)}`)
          if (stats) stats.domainsResolved++
        }
      } catch { /* */ }
    }

    // Threat actors.
    const ACTORS = ['lockbit', 'alphv', 'blackcat', 'conti', 'clop', 'akira', 'revil',
      'black basta', 'medusa', 'royal', 'bianlian', 'rhysida', 'lazarus', 'apt28', 'apt29']
    const textLower = allText.toLowerCase()
    const detected = ACTORS.filter((a) => textLower.includes(a))
    if (stats && detected.length > 0) {
      stats.actorsDetected = [...new Set([...stats.actorsDetected, ...detected])]
    }
  }

  private buildProposedCalls(
    steps: RawPlanStep[],
    findings: PreliminaryFindings,
    query: string
  ): ProposedToolCall[] {
    const calls: ProposedToolCall[] = []

    // Suggest additional web searches if web crawl found < 5 pages.
    if (findings.webPagesCrawled < 5) {
      const ddg = this.firstAvailable(['mcp:duckduckgo:search', 'mcp:duckduckgo:web_search'])
      if (ddg) {
        calls.push(makeCall(ddg, 'web', 'Additional web search',
          'Auto-research found few web pages — suggest broader search',
          query.split(/\s+/).slice(0, 6).join(' ')))
      }
    }

    // Suggest darkweb if not already searched.
    if (findings.darkwebPagesCrawled === 0 && toolRegistry.hasName('ahmia_search')) {
      calls.push(makeCall('ahmia_search', 'darkweb', 'Dark-web search',
        'No dark-web results in auto-research — suggest explicit search',
        steps[0]?.search_terms?.[0] || query.split(/\s+/).slice(0, 4).join(' ')))
    }

    // Suggest Wikipedia for detected actors.
    if (findings.actorsDetected.length > 0 && toolRegistry.hasName('mcp:wikipedia:search')) {
      for (const actor of findings.actorsDetected.slice(0, 2)) {
        calls.push(makeCall('mcp:wikipedia:search', 'mcp', `Wikipedia: ${actor}`,
          `Threat actor "${actor}" detected in findings`,
          actor))
      }
    }

    return calls
  }

  private buildParams(c: ProposedToolCall): Record<string, unknown> {
    switch (c.tool) {
      case 'web_fetch': return { url: c.query }
      case 'whois_lookup': return { domain: c.query }
      case 'dns_resolve': return { domain: c.query, type: c.params?.type ?? 'A' }
      case 'cve_detail': return { cve_id: c.query }
      case 'ahmia_search': return { query: c.query, limit: 8 }
      default:
        if (c.tool.startsWith('mcp:fetch:')) return { url: c.query }
        return { query: c.query, ...(c.params || {}) }
    }
  }

  private firstAvailable(names: string[]): string | undefined {
    return names.find((n) => toolRegistry.hasName(n))
  }

  private async plan(
    query: string,
    connectionId?: string,
    opts: { reworkFeedback?: string; previousPlanId?: string } = {}
  ): Promise<RawPlanStep[] | null> {
    let prompt = PLANNER_PROMPT + query
    if (opts.reworkFeedback) {
      const prev = opts.previousPlanId ? agenticPlanStore.get(opts.previousPlanId) : null
      const prevTasks = prev?.steps.map((s, i) => `  ${i + 1}. ${s.task}`).join('\n') || '  (none)'
      prompt += `\n\nPrevious plan was REJECTED with feedback: "${opts.reworkFeedback}"\nPrevious tasks:\n${prevTasks}\n\nProduce a NEW plan addressing the feedback.`
    }
    try {
      const meta = await llmService.completeForTaskWithMeta('planner', prompt, connectionId)
      const jsonMatch = meta.response.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return null
      const steps = JSON.parse(jsonMatch[0]) as RawPlanStep[]
      if (!Array.isArray(steps) || steps.length === 0) return null
      log.info(`DeepResearchAgent plan: ${steps.length} steps via ${meta.connectionName}/${meta.model}`)
      return steps.slice(0, 4)
    } catch (err) {
      log.warn(`DeepResearchAgent planning failed: ${err}`)
      return null
    }
  }

  private async analyze(
    query: string,
    findings: string[],
    history: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void,
    approvalComments?: string
  ): Promise<string> {
    const summary = intelRagService.getRecentSummary(24)
    // Cap findings to fit within LLM context. Each finding is truncated
    // to 600 chars; max 15 groups. This keeps the total payload under ~12K
    // tokens which fits comfortably in 4K-32K context models.
    const truncatedFindings = findings
      .slice(0, 15)
      .map((f) => f.slice(0, 600))
      .join('\n\n---\n\n')
    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYST_PROMPT },
      { role: 'system', content: `Current intelligence summary: ${summary}` },
      { role: 'system', content: `Research findings (${Math.min(findings.length, 15)} of ${findings.length} groups shown):\n\n${truncatedFindings}` },
    ]
    if (approvalComments) {
      messages.push({ role: 'system', content: `Analyst guidance: "${approvalComments}". Incorporate this.` })
    }
    messages.push(...history.slice(-6))
    messages.push({ role: 'user', content: `Based on all research findings, provide a definitive intelligence briefing for: ${query}` })

    const { response, model, connectionName } = await llmService.chatForTask('analysis', messages, onChunk, connectionId)
    log.info(`DeepResearchAgent analysis: synthesised by ${connectionName}/${model}`)
    return response
  }
}

export const deepResearchAgent = new DeepResearchAgent()
