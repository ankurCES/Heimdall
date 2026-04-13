import { llmService, type ChatMessage } from './LlmService'
import { intelRagService } from './IntelRagService'
import { vectorDbService } from '../vectordb/VectorDbService'
import { intelEnricher } from '../enrichment/IntelEnricher'
import { getDatabase } from '../database'
import log from 'electron-log'

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

const ANALYST_PROMPT = `You are the Analyst agent in Heimdall Intelligence Platform. You've been given research findings from the intel database (keyword search + vector similarity search). Synthesize them into a clear, actionable intelligence briefing.

Structure your response as:
1. **Key Findings** — bullet points of most important discoveries
2. **Threat Assessment** — severity level and confidence
3. **Connections** — links between different pieces of intelligence
4. **Recommended Actions** — what should be done
5. **Information Gaps** — what data is missing

Be specific, cite sources and disciplines, and flag unverified information.`

interface PlanStep {
  task: string
  search_terms: string[]
  discipline: string
}

export class AgenticChatOrchestrator {
  async process(
    query: string,
    conversationHistory: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    log.info(`Agentic chat: processing query "${query.slice(0, 50)}..."`)

    onChunk?.('**[Planning]** Analyzing your query...\n\n')
    const plan = await this.plan(query, connectionId)

    if (!plan || plan.length === 0) {
      onChunk?.('**[Searching]** Vector + keyword search...\n\n')
      return this.hybridRag(query, conversationHistory, connectionId, onChunk)
    }

    // Research all sub-tasks in PARALLEL for speed
    onChunk?.(`**[Researching]** ${plan.length} steps in parallel...\n`)
    const researchResults = await Promise.all(
      plan.map(async (step, i) => {
        const stepFindings = await this.research(step)
        onChunk?.(`**[Research ${i + 1}/${plan.length}]** ${step.task} ✓\n`)
        return stepFindings ? `### Research: ${step.task}\n\n${stepFindings}` : ''
      })
    )
    const findings = researchResults.filter(Boolean)

    if (findings.length === 0) {
      onChunk?.('\n**[No data found]** Using vector search fallback...\n\n')
      return this.hybridRag(query, conversationHistory, connectionId, onChunk)
    }

    onChunk?.('\n**[Analyzing]** Synthesizing findings...\n\n---\n\n')
    return this.analyze(query, findings, conversationHistory, connectionId, onChunk)
  }

  private async plan(query: string, connectionId?: string): Promise<PlanStep[] | null> {
    try {
      const response = await llmService.complete(PLANNER_PROMPT + query, connectionId, 500)
      const jsonMatch = response.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return null
      const steps = JSON.parse(jsonMatch[0]) as PlanStep[]
      if (!Array.isArray(steps) || steps.length === 0) return null
      log.info(`Agentic plan: ${steps.length} steps`)
      return steps.slice(0, 4)
    } catch (err) {
      log.warn(`Agentic planning failed: ${err}`)
      return null
    }
  }

  private async research(step: PlanStep): Promise<string> {
    const seenIds = new Set<string>()

    // Run ALL search terms in parallel (vector + keyword for each)
    const termResults = await Promise.all(step.search_terms.map(async (term) => {
      const results: string[] = []

      // Vector search
      try {
        const vectorResults = await vectorDbService.search(term, 3)
        for (const vr of vectorResults) {
          if (seenIds.has(vr.reportId)) continue
          seenIds.add(vr.reportId)
          results.push(
            `**[${vr.severity.toUpperCase()}] ${vr.title}** (vector: ${vr.score.toFixed(2)})\n` +
            `${vr.discipline} | ${vr.snippet.slice(0, 400)}\n`
          )
        }
      } catch {}

      // Keyword search
      const reports = intelRagService.searchReports(term, 3)
      const filtered = step.discipline === 'all' ? reports : reports.filter((r) => r.discipline === step.discipline)
      for (const report of filtered) {
        if (seenIds.has(report.id)) continue
        seenIds.add(report.id)
        results.push(
          `**[${report.severity.toUpperCase()}] ${report.title}**\n` +
          `${report.discipline} | ${report.sourceName} | V:${report.verificationScore}/100\n` +
          `${report.content.slice(0, 400)}\n`
        )
      }
      return results
    }))

    const allResults = termResults.flat()
    if (allResults.length === 0) return ''
    return allResults.slice(0, 10).join('\n---\n')
  }

  private async analyze(
    query: string, findings: string[], history: ChatMessage[],
    connectionId?: string, onChunk?: (chunk: string) => void
  ): Promise<string> {
    const summary = intelRagService.getRecentSummary(24)
    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYST_PROMPT },
      { role: 'system', content: `Current intelligence summary: ${summary}` },
      { role: 'system', content: `Research findings:\n\n${findings.join('\n\n')}` },
      ...history.slice(-6),
      { role: 'user', content: `Based on the research findings above, provide an intelligence briefing for: ${query}` }
    ]
    return llmService.chat(messages, connectionId, onChunk)
  }

  // Hybrid RAG: vector + keyword search combined
  private async hybridRag(
    query: string, history: ChatMessage[],
    connectionId?: string, onChunk?: (chunk: string) => void
  ): Promise<string> {
    // Vector search
    let vectorContext = ''
    try {
      const vectorResults = await vectorDbService.search(query, 8)
      if (vectorResults.length > 0) {
        vectorContext = vectorResults.map((r, i) =>
          `[${i + 1}] **[${r.severity.toUpperCase()}] ${r.title}** (similarity: ${r.score.toFixed(2)})\nDiscipline: ${r.discipline}\n${r.snippet}`
        ).join('\n\n')
      }
    } catch {}

    // Keyword search
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
