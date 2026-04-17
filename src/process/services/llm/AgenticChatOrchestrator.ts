import { llmService, type ChatMessage } from './LlmService'
import { intelRagService } from './IntelRagService'
import { vectorDbService } from '../vectordb/VectorDbService'
import { toolRegistry } from '../tools/ToolRegistry'
import { settingsService } from '../settings/SettingsService'
import { agenticPlanStore, makeCall, type PlanPreview, type PlanStep, type ProposedToolCall } from './AgenticPlanStore'
import { refineProposedCalls } from './SearchRefiner'
import { generateId } from '@common/utils/id'
import type { DarkWebConfig } from '@common/types/settings'
import log from 'electron-log'

/**
 * Agentic chat orchestrator — split into two phases that the renderer can
 * gate via a plan-approval modal:
 *
 *   buildPlan(query, history, sessionId, connectionId, opts?)
 *     → produces PlanPreview { steps, proposedCalls, … } stored in
 *       AgenticPlanStore. NO research is run, NO chunks emitted. Optionally
 *       takes `reworkFeedback` + `previousPlanId` to regenerate after the
 *       analyst rejected an earlier plan.
 *
 *   executeApprovedPlan(planId, edits, history, connectionId, onChunk)
 *     → looks up the stored plan, applies user edits (toggled-off tool
 *       calls, edited queries, approval comments), runs the surviving tool
 *       calls in parallel groups, synthesises into a briefing.
 *
 * Per-tool refined queries come from SearchRefiner (single LLM call) so
 * raw analyst phrasing like "Iran-China relations" becomes tool-aware
 * queries (Wikipedia gets canonical entity names, dark-web gets actor /
 * leak vocabulary, web search gets year-tagged news phrasing, etc.).
 */

const PLANNER_PROMPT = `You are the Planner agent in Heimdall Intelligence Platform. Given a user query about intelligence data, decompose it into 2-4 research steps.

Respond ONLY with a JSON array of steps. Each step has:
- "task": what to research
- "search_terms": array of keywords to search the intel database
- "discipline": which intelligence discipline to focus on (or "all")

Example response:
[
  {"task": "Find recent cyber attacks on critical infrastructure", "search_terms": ["cyber attack", "critical infrastructure", "breach"], "discipline": "cybint"},
  {"task": "Check for related geopolitical tensions", "search_terms": ["sanctions", "military", "conflict"], "discipline": "osint"}
]

User query: `

const ANALYST_PROMPT = `You are the Analyst agent in Heimdall Intelligence Platform. You've been given research findings from MULTIPLE sources: the internal intel database (keyword + vector search), public web fetches, dark-web (.onion) reconnaissance via Ahmia, and Model Context Protocol tools (Wikipedia, DuckDuckGo, knowledge graph, etc).

Synthesize ALL of these into a clear, actionable intelligence briefing.

Structure your response as:
1. **Key Findings** — bullet points of most important discoveries (cite each: [internal:<title>], [web:<domain>], [darkweb:<domain.onion>], [mcp:<server>])
2. **Threat Assessment** — severity level and confidence
3. **Connections** — links between different pieces of intelligence
4. **Recommended Actions** — what should be done
5. **Information Gaps** — what data is missing

Be specific, cite sources by their bracketed marker, and flag unverified information (especially anything from dark-web or unknown web sources).`

interface RawPlanStep {
  task: string
  search_terms: string[]
  discipline: string
}

/** Edits the analyst can apply to a proposed plan in the modal. */
export interface PlanEdits {
  /** Tool-call ids the analyst toggled off — they will be skipped. */
  disabledCallIds: string[]
  /** Edited queries keyed by tool-call id. Overrides the refined query. */
  editedQueries: Record<string, string>
  /** Free-text guidance forwarded to the analyst LLM as an extra system msg. */
  approvalComments?: string
}

interface IntentSignals {
  darkweb: boolean
  cves: string[]
  domains: string[]
  urls: string[]
  entityHeavy: boolean
  webGeneral: boolean
}

function classifyIntent(query: string, plan: RawPlanStep[]): IntentSignals {
  const text = (query + ' ' + plan.map((p) => p.task + ' ' + p.search_terms.join(' ')).join(' ')).toLowerCase()
  const darkwebTerms = ['ransomware', 'leak', 'leaked', 'breach', 'breached', 'credential', 'dump', 'dark web', 'darkweb', 'onion', 'tor', 'underground', 'forum', 'marketplace', 'lockbit', 'blackcat', 'alphv', 'clop', 'extortion']
  const darkweb = darkwebTerms.some((t) => text.includes(t))
  const cves = Array.from(new Set((query.match(/CVE-\d{4}-\d{4,7}/gi) || []).map((s) => s.toUpperCase())))
  const urls = Array.from(new Set(query.match(/https?:\/\/[^\s)]+/gi) || []))
  const domainRe = /\b([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi
  const domains = Array.from(new Set((query.match(domainRe) || [])
    .filter((d) => !d.startsWith('http') && !urls.some((u) => u.includes(d)))
    .filter((d) => !['e.g', 'i.e', 'etc.al'].includes(d.toLowerCase()))))
  const properNouns = (query.match(/\b[A-Z][a-zA-Z]{3,}\b/g) || []).length
  const entityHeavy = properNouns >= 2
  const webGeneral = /latest|current|recent|today|news|happening|this week|this month/i.test(query)
  return { darkweb, cves, domains, urls, entityHeavy, webGeneral }
}

function emitToolCall(
  onChunk: ((c: string) => void) | undefined,
  tool: string,
  paramsPreview: string,
  resultPreview: string
): void {
  if (!onChunk) return
  onChunk(`\n**[Tool: ${tool}]** ${paramsPreview.slice(0, 160)}\n`)
  if (resultPreview) onChunk('```\n' + resultPreview.slice(0, 800) + '\n```\n')
}

function firstAvailable(names: string[]): string | undefined {
  return names.find((n) => toolRegistry.hasName(n))
}

function topTerm(plan: RawPlanStep[], query: string): string {
  return plan[0]?.search_terms?.[0] || query.split(/\s+/).slice(0, 6).join(' ')
}

export class AgenticChatOrchestrator {
  /**
   * BUILD a plan for analyst approval. No research happens here.
   *
   * @param opts.reworkFeedback  user's mandatory rework comment from a
   *                             previously rejected plan; the planner LLM
   *                             is told to address it.
   * @param opts.previousPlanId  if reworking, the prior plan id (we look up
   *                             its steps to give the planner concrete
   *                             "what was wrong" context).
   */
  async buildPlan(
    query: string,
    history: ChatMessage[],
    sessionId: string,
    connectionId?: string,
    opts: { reworkFeedback?: string; previousPlanId?: string } = {}
  ): Promise<PlanPreview | null> {
    log.info(`Agentic buildPlan: "${query.slice(0, 60)}…"${opts.reworkFeedback ? ` [REWORK: "${opts.reworkFeedback.slice(0, 60)}…"]` : ''}`)

    const rawSteps = await this.plan(query, connectionId, opts)
    if (!rawSteps || rawSteps.length === 0) return null

    const intent = classifyIntent(query, rawSteps)

    // Build the proposed-call list. Each call gets a stable id so the modal
    // can reference it for toggle / edit / cite in execution-time edits.
    const calls: ProposedToolCall[] = []

    // Per-step internal research (vector + keyword). Cap each step at the
    // first 3 search terms to keep the modal scannable.
    for (const step of rawSteps) {
      for (const term of step.search_terms.slice(0, 3)) {
        calls.push(makeCall(
          'vector_search',
          'internal',
          `Vector: "${term}"`,
          `Semantic search for plan step "${step.task.slice(0, 80)}"`,
          term
        ))
        calls.push(makeCall(
          'intel_search',
          'internal',
          `Intel DB: "${term}"`,
          `Keyword search (${step.discipline}) for "${step.task.slice(0, 80)}"`,
          term,
          { discipline: step.discipline }
        ))
      }
    }

    // Enrichment proposals — each only added if the intent classifier triggers.
    if (intent.darkweb) {
      calls.push(makeCall(
        'ahmia_search',
        'darkweb',
        'Ahmia dark-web search',
        'Query mentions dark-web / leak / ransomware vocabulary',
        topTerm(rawSteps, query)
      ))
    }
    for (const url of intent.urls.slice(0, 3)) {
      calls.push(makeCall(
        'web_fetch',
        'web',
        `Fetch: ${url.slice(0, 60)}`,
        'URL provided in your query',
        url
      ))
    }
    for (const cve of intent.cves.slice(0, 4)) {
      calls.push(makeCall(
        'cve_detail',
        'cve',
        `CVE detail: ${cve}`,
        'CVE id detected in your query',
        cve
      ))
    }
    for (const d of intent.domains.slice(0, 3)) {
      calls.push(makeCall('whois_lookup', 'domain', `WHOIS: ${d}`, 'Domain detected in your query', d))
      calls.push(makeCall('dns_resolve', 'domain', `DNS: ${d}`, 'Resolve A records', d, { type: 'A' }))
    }
    if (intent.entityHeavy && toolRegistry.hasName('mcp:wikipedia:search')) {
      calls.push(makeCall(
        'mcp:wikipedia:search',
        'mcp',
        'Wikipedia entity context',
        'Query is entity-heavy — Wikipedia provides canonical context',
        topTerm(rawSteps, query)
      ))
    }
    if (intent.webGeneral) {
      const ddg = firstAvailable(['mcp:duckduckgo:search', 'mcp:duckduckgo:web_search', 'mcp:fetch:fetch'])
      if (ddg) {
        const isFetch = ddg === 'mcp:fetch:fetch'
        const term = topTerm(rawSteps, query)
        calls.push(makeCall(
          ddg,
          'mcp',
          isFetch ? 'Web search via DuckDuckGo HTML' : `Web search (${ddg.split(':')[1]})`,
          'Query mentions latest / recent / current — web search for freshness',
          isFetch ? `https://duckduckgo.com/html/?q=${encodeURIComponent(term)}` : term
        ))
      }
    }

    const preview: PlanPreview = {
      planId: generateId(),
      sessionId,
      query,
      steps: rawSteps.map((s) => ({ task: s.task, searchTerms: s.search_terms, discipline: s.discipline })),
      proposedCalls: calls, // raw queries first — refinement runs in background
      reworkHistory: opts.reworkFeedback ? [{ feedback: opts.reworkFeedback, at: Date.now() }] : [],
      createdAt: Date.now()
    }

    // Carry over rework history from the previous plan so the modal can
    // show the analyst all rejection reasons accumulated so far.
    if (opts.previousPlanId) {
      const prev = agenticPlanStore.get(opts.previousPlanId)
      if (prev) preview.reworkHistory = [...prev.reworkHistory, ...preview.reworkHistory]
    }

    agenticPlanStore.put(preview, history, connectionId)
    log.info(`Agentic buildPlan: planId=${preview.planId} steps=${rawSteps.length} calls=${calls.length} (refinement in background)`)

    // BACKGROUND refinement — open modal immediately, push refined queries
    // via the chat:planRefined event when ready. The renderer merges them
    // into the modal's editable fields without losing user edits.
    void this.refineInBackground(preview.planId, query, history, rawSteps, calls, connectionId)

    return preview
  }

  /** Run SearchRefiner asynchronously; on success, update the stored plan
   *  and broadcast a chat:planRefined event. Failures are silent — the modal
   *  just keeps the raw queries. */
  private async refineInBackground(
    planId: string,
    query: string,
    history: ChatMessage[],
    rawSteps: RawPlanStep[],
    calls: ProposedToolCall[],
    connectionId?: string
  ): Promise<void> {
    try {
      const refined = await refineProposedCalls(
        query, history,
        rawSteps.map((s) => ({ task: s.task, searchTerms: s.search_terms, discipline: s.discipline })),
        calls, connectionId
      )
      const stored = agenticPlanStore.get(planId)
      if (!stored) return // user cancelled / TTL'd
      // Merge refined queries into the stored plan AND notify renderer.
      const refinedById = new Map(refined.map((c) => [c.id, c.query]))
      stored.proposedCalls = stored.proposedCalls.map((c) => {
        const q = refinedById.get(c.id)
        return q && q !== c.query ? { ...c, query: q } : c
      })
      // Broadcast to renderer.
      const { BrowserWindow } = await import('electron')
      const payload = { planId, refinedQueries: Object.fromEntries(refinedById) }
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        try { win.webContents.send('chat:planRefined', payload) } catch {}
      }
      log.info(`Agentic refinement: planId=${planId} pushed ${refinedById.size} refined queries`)
    } catch (err) {
      log.warn(`Agentic refinement failed for planId=${planId} (silent, modal keeps raw queries): ${err}`)
    }
  }

  /**
   * EXECUTE an approved plan. Pulls history from the store (set at
   * buildPlan time) so the renderer doesn't need to re-send it.
   *
   * `edits.disabledCallIds`  — calls to skip
   * `edits.editedQueries`    — query overrides
   * `edits.approvalComments` — extra guidance forwarded to the analyst LLM
   */
  async executeApprovedPlan(
    planId: string,
    edits: PlanEdits,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const plan = agenticPlanStore.get(planId)
    if (!plan) throw new Error(`Plan ${planId} not found or expired`)

    // Apply edits: drop disabled calls, override edited queries.
    const disabled = new Set(edits.disabledCallIds || [])
    const calls: ProposedToolCall[] = plan.proposedCalls
      .filter((c) => !disabled.has(c.id))
      .map((c) => {
        const override = edits.editedQueries?.[c.id]
        return override && override.trim() ? { ...c, query: override.trim() } : c
      })

    log.info(`Agentic executeApprovedPlan: planId=${planId} executing ${calls.length}/${plan.proposedCalls.length} calls (${plan.proposedCalls.length - calls.length} skipped)${edits.approvalComments ? ` [comments: "${edits.approvalComments.slice(0, 60)}…"]` : ''}`)

    // Surface plan + approval state as the very first thinking step.
    onChunk?.(`**[Plan]** Approved by analyst — ${calls.length} tool call(s) to execute`)
    if (plan.proposedCalls.length - calls.length > 0) {
      onChunk?.(`, ${plan.proposedCalls.length - calls.length} skipped`)
    }
    if (edits.approvalComments) {
      onChunk?.(`\n_Analyst guidance: ${edits.approvalComments}_`)
    }
    onChunk?.('\n\n' + this.renderPlanCheckboxes(plan.steps, calls, plan.proposedCalls.length) + '\n')

    // Surface the auto-routed model selections so the analyst sees which
    // model handles which subtask of THIS plan. Pure UI signal — does not
    // affect routing.
    try {
      const { modelRouter } = await import('./ModelRouter')
      const tasks: Array<{ task: import('./ModelRouter').TaskClass; label: string }> = [
        { task: 'analysis', label: 'Synthesis' },
        { task: 'refiner', label: 'Refinement' }
      ]
      const lines = tasks.map(({ task, label }) => {
        const r = modelRouter.selectForTask(task, plan.connectionId)
        return r ? `- ${label}: \`${r.connection.name}/${r.model}\` (${r.reason})` : `- ${label}: (none available)`
      })
      onChunk?.(`\n**[Model routing]** Auto-selected models for this plan:\n${lines.join('\n')}\n`)
    } catch { /* router unavailable — silent */ }

    // Group by `group` so we can run same-group calls in parallel.
    const byGroup: Record<string, ProposedToolCall[]> = {}
    for (const c of calls) {
      ;(byGroup[c.group] = byGroup[c.group] || []).push(c)
    }

    // Findings collected across groups for the analyst LLM.
    const findings: string[] = []

    // 1. Internal first (so the analyst always grounds in our own data).
    if (byGroup.internal?.length) {
      onChunk?.(`\n**[Researching]** ${byGroup.internal.length} internal search(es)…\n`)
      const internalFindings = await this.runInternalGroup(byGroup.internal, onChunk)
      if (internalFindings) findings.push(`### Internal database\n\n${internalFindings}`)
    }

    // 2. Each enrichment group in parallel within the group.
    for (const [groupName, label] of [
      ['darkweb', 'Dark-web reconnaissance (Ahmia)'],
      ['web', 'Public web fetches'],
      ['cve', 'CVE details'],
      ['domain', 'Domain WHOIS / DNS'],
      ['mcp', 'MCP tools (Wikipedia / DuckDuckGo / Knowledge graph)']
    ] as const) {
      const groupCalls = byGroup[groupName]
      if (!groupCalls?.length) continue
      onChunk?.(`\n**[Researching]** ${groupName} — ${groupCalls.length} call(s)…\n`)
      const groupFindings = await this.runEnrichmentGroup(groupName, groupCalls, onChunk)
      if (groupFindings) findings.push(`### ${label}\n\n${groupFindings}`)
    }

    // 3. Analyze.
    if (findings.length === 0) {
      onChunk?.('\n**[No data found]** All approved tool calls returned empty.\n\n')
      return 'No findings produced from the approved plan. Try a different query or re-run with different tool selections.'
    }
    onChunk?.(`\n**[Analyzing]** Synthesizing ${findings.length} source group(s)…\n\n---\n\n`)

    // Done with this plan — release storage.
    agenticPlanStore.remove(planId)

    return this.analyze(plan.query, findings, plan.history, plan.connectionId, onChunk, edits.approvalComments)
  }

  /** Render the approved plan as a markdown checkbox list. The
   *  ThinkingBlocks parser shows it as a `[Plan]` step with checkboxes
   *  marking skipped vs included calls. */
  private renderPlanCheckboxes(steps: PlanStep[], approved: ProposedToolCall[], totalProposed: number): string {
    const stepLines = steps.map((s, i) => `- [x] Step ${i + 1}: ${s.task}`).join('\n')
    const callLines = approved.map((c) => `- [x] ${c.tool}: \`${c.query.slice(0, 80)}\``).join('\n')
    const skipped = totalProposed - approved.length
    const skippedLine = skipped > 0 ? `\n${skipped} call(s) skipped by analyst.` : ''
    return `${stepLines}\n\nApproved tool calls:\n${callLines}${skippedLine}`
  }

  // ── INTERNAL search runners ─────────────────────────────────────────
  private async runInternalGroup(calls: ProposedToolCall[], onChunk?: (c: string) => void): Promise<string> {
    const seen = new Set<string>()
    const lines: string[] = []
    for (const c of calls) {
      if (c.tool === 'vector_search') {
        try {
          const results = await vectorDbService.search(c.query, 4)
          emitToolCall(onChunk, 'vector_search', `{"query":"${c.query}"}`,
            results.length === 0 ? '(no results)' :
            results.map((r) => `${r.title} [${r.severity}] (score=${r.score.toFixed(2)}) [id:${r.reportId}]`).join('\n'))
          for (const r of results) {
            if (seen.has(r.reportId)) continue
            seen.add(r.reportId)
            lines.push(`**[${r.severity.toUpperCase()}] ${r.title}** (vector ${r.score.toFixed(2)}) [id:${r.reportId}]\n${r.discipline} | ${r.snippet.slice(0, 400)}\n`)
          }
        } catch (err) {
          emitToolCall(onChunk, 'vector_search', `{"query":"${c.query}"}`, `error: ${(err as Error).message}`)
        }
      } else if (c.tool === 'intel_search') {
        try {
          const discipline = (c.params?.discipline as string) || 'all'
          // Plan + execute. We use planAdaptive only when the deterministic
          // pass under-delivers — first try deterministic, then re-plan with
          // LLM if results are thin.
          const { queryPlanner } = await import('../intel/QueryPlanner')
          let plan = queryPlanner.plan(c.query)
          let reports = intelRagService.searchReportsRanked(plan.ftsQuery || c.query, 6, { rawFts: !!plan.ftsQuery })

          // Adaptive escalation: if deterministic produced < 3 hits AND the
          // raw query was natural-language-ish (≥5 words), re-plan via LLM.
          const rawWordCount = c.query.split(/\s+/).filter(Boolean).length
          if (reports.length < 3 && rawWordCount >= 5) {
            try {
              const adaptive = await queryPlanner.planAdaptive(c.query, {
                resultsForDeterministic: reports.length, minResults: 3
              })
              if (adaptive.llmRefined && adaptive.ftsQuery && adaptive.ftsQuery !== plan.ftsQuery) {
                const adaptiveReports = intelRagService.searchReportsRanked(adaptive.ftsQuery, 6, { rawFts: true })
                if (adaptiveReports.length > reports.length) {
                  plan = adaptive
                  reports = adaptiveReports
                }
              }
            } catch { /* LLM unavailable — keep deterministic results */ }
          }

          const filtered = discipline === 'all' ? reports : reports.filter((r) => r.discipline === discipline)
          const matchPreview = filtered.length === 0
            ? '(no results)'
            : `${plan.meta}\n\n` + filtered.map((r) => `${r.title} [${r.severity}] (BM25=${r.score.toFixed(2)}) [id:${r.id}]`).join('\n')
          emitToolCall(onChunk, 'intel_search', `{"query":"${c.query}","discipline":"${discipline}"${plan.llmRefined ? ',"llmRefined":true' : ''}}`, matchPreview)

          for (const r of filtered) {
            if (seen.has(r.id)) continue
            seen.add(r.id)
            lines.push(`**[${r.severity.toUpperCase()}] ${r.title}** [id:${r.id}]\n${r.discipline} | ${r.sourceName} | V:${r.verificationScore}/100 | BM25=${r.score.toFixed(2)}\n${r.content.slice(0, 400)}\n`)
          }
        } catch (err) {
          emitToolCall(onChunk, 'intel_search', `{"query":"${c.query}"}`, `error: ${(err as Error).message}`)
        }
      }
    }
    return lines.slice(0, 12).join('\n---\n')
  }

  private async runEnrichmentGroup(
    groupName: string,
    calls: ProposedToolCall[],
    onChunk?: (c: string) => void
  ): Promise<string> {
    // Dark-web: respect the global toggle.
    if (groupName === 'darkweb') {
      const dw = settingsService.get<DarkWebConfig>('darkWeb')
      if (!dw?.enabled || !dw?.ahmiaEnabled) {
        emitToolCall(onChunk, 'ahmia_search', '(skipped)', 'Dark-web disabled in Settings → Dark Web')
        return ''
      }
    }

    const out: string[] = []
    // For the darkweb group: collect every onion URL returned across all
    // ahmia_search calls so we can dedupe before fetching. Only used when
    // Tor is connected — otherwise the LLM just sees the URL list and can
    // optionally invoke onion_fetch itself (it has the tool, with a clear
    // "TOR_NOT_CONNECTED" error if it tries without Tor).
    const onionUrlsPerQuery = new Map<string, Set<string>>()

    for (const c of calls) {
      const params = this.buildParams(c)
      const r = await toolRegistry.execute(c.tool, params)
      emitToolCall(onChunk, c.tool, JSON.stringify(params).slice(0, 160), r.error ? `error: ${r.error}` : r.output)
      if (!r.error && r.output) out.push(`**${c.tool}** "${c.query.slice(0, 80)}"\n${r.output.slice(0, 1500)}`)

      // Collect onion URLs from ahmia_search results for the auto-fetch step.
      if (c.tool === 'ahmia_search' && !r.error && Array.isArray(r.data)) {
        const hits = r.data as Array<{ onionUrl?: string }>
        const urls = new Set<string>()
        for (const h of hits) {
          if (h?.onionUrl && /^https?:\/\/[a-z2-7]{16,56}\.onion/i.test(h.onionUrl)) urls.add(h.onionUrl)
        }
        if (urls.size > 0) onionUrlsPerQuery.set(c.query, urls)
      }
    }

    // ── Auto onion_fetch — only when Tor is connected ──
    if (groupName === 'darkweb' && onionUrlsPerQuery.size > 0) {
      const onionContent = await this.autoFetchOnionUrls(onionUrlsPerQuery, onChunk)
      if (onionContent) out.push(onionContent)
    }

    return out.join('\n\n---\n\n')
  }

  /**
   * For each ahmia_search query that returned onion URLs, fetch the top-K
   * URLs through Tor in parallel, store each successful fetch as a
   * `[DARKWEB]` intel report tagged with the source query, and append the
   * extracted text to the orchestrator's findings.
   *
   * Tor-gated: if Tor isn't connected we emit a single skipped marker and
   * return — the LLM still has the bare URLs in the ahmia_search result
   * text and can call onion_fetch itself (it'll get a clear error).
   *
   * Caps:
   *   - 5 onion URLs per ahmia query (avoid burying the analyst LLM)
   *   - Up to 4 fetches in parallel (Tor exit-node etiquette)
   *   - 30s timeout per fetch (Tor latency)
   *   - Stored content capped at 4000 chars
   */
  private async autoFetchOnionUrls(
    onionUrlsPerQuery: Map<string, Set<string>>,
    onChunk?: (c: string) => void
  ): Promise<string> {
    const { torService } = await import('../darkweb/TorService')
    const torState = torService.getState()
    const torConnected = torState.status === 'connected_external' || torState.status === 'connected_managed'

    if (!torConnected) {
      const total = Array.from(onionUrlsPerQuery.values()).reduce((a, s) => a + s.size, 0)
      emitToolCall(onChunk, 'onion_fetch', `(skipped × ${total})`, `Tor not connected (status: ${torState.status}). The LLM has the .onion URLs in ahmia_search results — it can call onion_fetch directly after you connect Tor in Settings → Dark Web.`)
      return ''
    }

    onChunk?.(`\n**[Onion fetch]** Tor connected (${torState.socksHost}:${torState.socksPort}) — auto-fetching onion URLs from ${onionUrlsPerQuery.size} ahmia query(ies)…\n`)

    const FETCHES_PER_QUERY = 5
    const PARALLELISM = 4
    const seenGlobally = new Set<string>()
    const tasks: Array<{ query: string; url: string }> = []
    for (const [query, urls] of onionUrlsPerQuery) {
      for (const url of Array.from(urls).slice(0, FETCHES_PER_QUERY)) {
        if (seenGlobally.has(url)) continue
        seenGlobally.add(url)
        tasks.push({ query, url })
      }
    }
    if (tasks.length === 0) return ''

    const findings: string[] = []
    let stored = 0
    let failed = 0

    // Process in parallel batches to be polite to Tor exit nodes.
    for (let i = 0; i < tasks.length; i += PARALLELISM) {
      const batch = tasks.slice(i, i + PARALLELISM)
      const results = await Promise.allSettled(batch.map(async ({ query, url }) => {
        const r = await toolRegistry.execute('onion_fetch', { url, max_chars: 4000 })
        emitToolCall(onChunk, 'onion_fetch', `{"url":"${url.slice(0, 80)}"}`, r.error ? `error: ${r.error}` : r.output.slice(0, 600))
        if (r.error || !r.data) {
          failed++
          return null
        }
        const data = r.data as { hostname: string; text: string; textLength: number }
        // Persist as [DARKWEB] intel report.
        try {
          const reportId = await this.storeOnionAsIntelReport(query, url, data.hostname, data.text)
          stored++
          return { query, url, hostname: data.hostname, text: data.text, reportId }
        } catch (err) {
          log.warn(`Onion store failed for ${url}: ${err}`)
          failed++
          return { query, url, hostname: data.hostname, text: data.text, reportId: null }
        }
      }))
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value) {
          const { query, url, hostname, text, reportId } = res.value
          const idMarker = reportId ? `[id:${reportId}]` : '(not stored)'
          findings.push(`**[onion:${hostname}]** ${idMarker} (from ahmia query "${query.slice(0, 60)}")\n${text.slice(0, 1200)}`)
        }
      }
    }

    onChunk?.(`\n**[Onion fetch]** Completed: ${stored} stored as [DARKWEB] reports, ${failed} failed of ${tasks.length} attempted.\n`)
    if (findings.length === 0) return ''
    return `**Auto-fetched onion content** (${findings.length} pages):\n\n${findings.join('\n\n---\n\n')}`
  }

  /**
   * Insert a fetched onion page into intel_reports + tag it. Idempotent on
   * (url, content) — duplicate content_hash is silently ignored. Returns
   * the new report id (or the existing one if already stored).
   */
  private async storeOnionAsIntelReport(
    sourceQuery: string,
    url: string,
    hostname: string,
    text: string
  ): Promise<string> {
    const { getDatabase } = await import('../database')
    const { generateId, timestamp } = await import('@common/utils/id')
    const { createHash } = await import('crypto')
    const db = getDatabase()
    const now = timestamp()
    const trimmed = text.slice(0, 8000)
    const hash = createHash('sha256').update(url + '|' + trimmed).digest('hex')

    // Check existing by content_hash → return existing id if duplicate.
    const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash) as { id: string } | undefined
    if (existing) return existing.id

    const id = generateId()
    const title = `[DARKWEB] ${hostname}`.slice(0, 200)
    const summary = trimmed.slice(0, 240).replace(/\s+/g, ' ').trim()
    const content = `**Source query** (Ahmia → onion_fetch): "${sourceQuery}"\n**Onion URL**: ${url}\n**Fetched at**: ${new Date(now).toISOString()}\n\n---\n\n${trimmed}`

    db.prepare(
      'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, 'osint', title, content, summary, 'medium', 'chat-onion-fetch', `Onion: ${hostname}`, url, hash, 40, 0, now, now)

    // Tags: darkweb (so it's filterable in the UI), ahmia-source (provenance),
    // and a query-derived tag so analysts can pivot back to the search context.
    const queryTag = 'query:' + sourceQuery.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '')
    const tags = ['darkweb', 'ahmia-source', 'onion-fetch']
    if (queryTag.length > 6) tags.push(queryTag)
    const tagStmt = db.prepare(
      'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const tag of tags) {
      try { tagStmt.run(id, tag, 1.0, 'chat-onion-fetch', now) } catch { /* tag table may have different shape — degrade gracefully */ }
    }

    log.info(`Onion stored: [${hostname}] → report ${id} (tagged: ${tags.join(', ')})`)
    // Fire-and-forget enrichment — queue handles back-pressure.
    void this.queueDarkWebEnrichment(id)
    return id
  }

  /** Lazy import to avoid circular deps at module load. */
  private async queueDarkWebEnrichment(reportId: string): Promise<void> {
    try {
      const { darkWebEnrichmentService } = await import('../darkweb/DarkWebEnrichmentService')
      darkWebEnrichmentService.enqueue(reportId)
    } catch (err) {
      log.debug(`Orchestrator: enrichment queue failed for ${reportId}: ${err}`)
    }
    // Also queue for onion-link crawling (nested traversal).
    try {
      const { onionCrawlerService } = await import('../darkweb/OnionCrawlerService')
      onionCrawlerService.enqueue(reportId)
    } catch (err) {
      log.debug(`Orchestrator: crawler queue failed for ${reportId}: ${err}`)
    }
  }

  /** Map a proposed call's `query` + `params` into the tool-specific
   *  parameter shape that ToolRegistry.execute expects. */
  private buildParams(c: ProposedToolCall): Record<string, unknown> {
    switch (c.tool) {
      case 'web_fetch': return { url: c.query }
      case 'whois_lookup': return { domain: c.query }
      case 'dns_resolve': return { domain: c.query, type: c.params?.type ?? 'A' }
      case 'cve_detail': return { cve_id: c.query }
      case 'ahmia_search': return { query: c.query, limit: 8 }
      default:
        // MCP + generic search tools: most accept { query: ... }
        if (c.tool.startsWith('mcp:fetch:')) return { url: c.query }
        return { query: c.query, ...(c.params || {}) }
    }
  }

  private async plan(
    query: string,
    connectionId?: string,
    opts: { reworkFeedback?: string; previousPlanId?: string } = {}
  ): Promise<RawPlanStep[] | null> {
    let prompt = PLANNER_PROMPT + query
    if (opts.reworkFeedback) {
      const prev = opts.previousPlanId ? agenticPlanStore.get(opts.previousPlanId) : null
      const prevTasks = prev?.steps.map((s, i) => `  ${i + 1}. ${s.task}`).join('\n') || '  (no prior plan available)'
      prompt = `${PLANNER_PROMPT}${query}\n\nThe previous plan was REJECTED by the analyst with this feedback:\n"${opts.reworkFeedback}"\n\nPrevious plan was:\n${prevTasks}\n\nProduce a NEW plan that ADDRESSES the analyst's feedback.`
    }
    try {
      // Use the small/fast model the router selects for "planner" tasks
      // (e.g. gemma2:2b vs gemma:31b). Drops planner latency from ~90s to
      // a few seconds when a smaller model is configured.
      const meta = await llmService.completeForTaskWithMeta('planner', prompt, connectionId)
      const jsonMatch = meta.response.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return null
      const steps = JSON.parse(jsonMatch[0]) as RawPlanStep[]
      if (!Array.isArray(steps) || steps.length === 0) return null
      log.info(`Agentic plan: ${steps.length} steps via ${meta.connectionName}/${meta.model}`)
      return steps.slice(0, 4)
    } catch (err) {
      log.warn(`Agentic planning failed: ${err}`)
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
    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYST_PROMPT },
      { role: 'system', content: `Current intelligence summary: ${summary}` },
      { role: 'system', content: `Research findings (combined from ${findings.length} source group(s)):\n\n${findings.join('\n\n')}` },
    ]
    if (approvalComments) {
      messages.push({ role: 'system', content: `Analyst's approval guidance for this analysis: "${approvalComments}". Incorporate this guidance.` })
    }
    messages.push(...history.slice(-6))
    messages.push({ role: 'user', content: `Based on the research findings above, provide an intelligence briefing for: ${query}` })

    // Route to the large/strong model the router selects for "analysis" —
    // synthesis benefits from more parameters than the planner needs.
    const { response, model, connectionName } = await llmService.chatForTask('analysis', messages, onChunk, connectionId)
    log.info(`Agentic analysis: synthesised by ${connectionName}/${model}`)
    return response
  }

  // ── Legacy single-shot path ─────────────────────────────────────────
  /**
   * One-shot process — used by callers that haven't migrated to the
   * plan-then-execute flow (and as a fallback if planning fails). Builds
   * a plan internally, auto-approves it, executes immediately. No analyst
   * gating.
   */
  async process(
    query: string,
    history: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void,
    sessionId?: string
  ): Promise<string> {
    onChunk?.('**[Planning]** Analyzing your query and building a research plan…\n\n')
    const plan = await this.buildPlan(query, history, sessionId || 'unknown', connectionId)
    if (!plan) {
      onChunk?.('**[Planning]** No structured plan produced — falling back to single-pass hybrid RAG.\n')
      return this.hybridRag(query, history, connectionId, onChunk)
    }
    return this.executeApprovedPlan(plan.planId, { disabledCallIds: [], editedQueries: {} }, onChunk)
  }

  // Hybrid RAG: vector + keyword search combined. Used as a fallback when
  // planning fails or no findings come back from the structured run.
  private async hybridRag(
    query: string, history: ChatMessage[],
    connectionId?: string, onChunk?: (chunk: string) => void
  ): Promise<string> {
    let vectorContext = ''
    try {
      const vectorResults = await vectorDbService.search(query, 8)
      emitToolCall(onChunk, 'vector_search', `{"query":"${query.slice(0, 60)}"}`,
        vectorResults.length === 0 ? '(no results)' :
        vectorResults.map((r) => `${r.title} [${r.severity}] (score=${r.score.toFixed(2)})`).join('\n'))
      if (vectorResults.length > 0) {
        vectorContext = vectorResults.map((r, i) =>
          `[${i + 1}] **[${r.severity.toUpperCase()}] ${r.title}** (similarity: ${r.score.toFixed(2)})\nDiscipline: ${r.discipline}\n${r.snippet}`
        ).join('\n\n')
      }
    } catch {}

    const contextMessages = intelRagService.buildContextMessages(query)
    const summary = intelRagService.getRecentSummary(24)

    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYST_PROMPT },
      { role: 'system', content: summary },
      ...contextMessages,
      ...(vectorContext ? [{ role: 'system' as const, content: `Vector similarity search results:\n\n${vectorContext}` }] : []),
      ...history.slice(-10),
      { role: 'user', content: query }
    ]

    return llmService.chat(messages, connectionId, onChunk)
  }
}

export const agenticChatOrchestrator = new AgenticChatOrchestrator()
