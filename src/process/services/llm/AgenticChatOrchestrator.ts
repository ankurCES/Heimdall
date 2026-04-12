import { llmService, type ChatMessage } from './LlmService'
import { intelRagService } from './IntelRagService'
import { intelEnricher } from '../enrichment/IntelEnricher'
import { getDatabase } from '../database'
import log from 'electron-log'

// Agentic orchestration for complex intelligence queries
// Inspired by ClawX multi-step reasoning pattern:
// 1. Planner — decomposes query into sub-tasks
// 2. Researcher — searches intel database for relevant data
// 3. Analyst — synthesizes findings into actionable intelligence
// 4. Reviewer — validates and quality-checks the analysis

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

const ANALYST_PROMPT = `You are the Analyst agent in Heimdall Intelligence Platform. You've been given research findings from the intel database. Synthesize them into a clear, actionable intelligence briefing.

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

    // Step 1: Plan
    onChunk?.('**[Planning]** Analyzing your query...\n\n')
    const plan = await this.plan(query, connectionId)

    if (!plan || plan.length === 0) {
      // Simple query — no agentic decomposition needed, just do RAG
      onChunk?.('**[Researching]** Searching intelligence database...\n\n')
      return this.simpleRag(query, conversationHistory, connectionId, onChunk)
    }

    // Step 2: Research each sub-task
    const findings: string[] = []
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]
      onChunk?.(`**[Researching ${i + 1}/${plan.length}]** ${step.task}\n`)

      const stepFindings = this.research(step)
      if (stepFindings) {
        findings.push(`### Research: ${step.task}\n\n${stepFindings}`)
      }
    }

    if (findings.length === 0) {
      onChunk?.('\n**[No relevant data found]** Falling back to general analysis...\n\n')
      return this.simpleRag(query, conversationHistory, connectionId, onChunk)
    }

    // Step 3: Analyze
    onChunk?.('\n**[Analyzing]** Synthesizing findings...\n\n---\n\n')
    const analysis = await this.analyze(query, findings, conversationHistory, connectionId, onChunk)

    return analysis
  }

  private async plan(query: string, connectionId?: string): Promise<PlanStep[] | null> {
    try {
      const response = await llmService.complete(
        PLANNER_PROMPT + query,
        connectionId,
        500
      )

      // Extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return null

      const steps = JSON.parse(jsonMatch[0]) as PlanStep[]
      if (!Array.isArray(steps) || steps.length === 0) return null

      log.info(`Agentic plan: ${steps.length} steps`)
      return steps.slice(0, 4) // Max 4 steps
    } catch (err) {
      log.warn(`Agentic planning failed: ${err}`)
      return null
    }
  }

  private research(step: PlanStep): string {
    const allResults: string[] = []

    for (const term of step.search_terms) {
      const reports = intelRagService.searchReports(term, 5)

      // Filter by discipline if specified
      const filtered = step.discipline === 'all'
        ? reports
        : reports.filter((r) => r.discipline === step.discipline)

      for (const report of filtered.slice(0, 3)) {
        const tags = intelEnricher.getTags(report.id)
        const tagStr = tags.length > 0 ? `\nTags: ${tags.map((t) => t.tag).join(', ')}` : ''

        allResults.push(
          `**[${report.severity.toUpperCase()}] ${report.title}**\n` +
          `Discipline: ${report.discipline} | Source: ${report.sourceName} | Verification: ${report.verificationScore}/100${tagStr}\n` +
          `${report.content.slice(0, 500)}\n`
        )
      }
    }

    if (allResults.length === 0) return ''
    return allResults.join('\n---\n')
  }

  private async analyze(
    query: string,
    findings: string[],
    history: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const summary = intelRagService.getRecentSummary(24)

    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYST_PROMPT },
      { role: 'system', content: `Current intelligence summary: ${summary}` },
      { role: 'system', content: `Research findings:\n\n${findings.join('\n\n')}` },
      ...history.slice(-6), // Last 6 messages for context
      { role: 'user', content: `Based on the research findings above, provide an intelligence briefing for: ${query}` }
    ]

    return llmService.chat(messages, connectionId, onChunk)
  }

  private async simpleRag(
    query: string,
    history: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const contextMessages = intelRagService.buildContextMessages(query)
    const summary = intelRagService.getRecentSummary(24)

    const messages: ChatMessage[] = [
      { role: 'system', content: summary },
      ...contextMessages,
      ...history.slice(-10),
      { role: 'user', content: query }
    ]

    return llmService.chat(messages, connectionId, onChunk)
  }
}

export const agenticChatOrchestrator = new AgenticChatOrchestrator()
