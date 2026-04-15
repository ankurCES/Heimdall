import { llmService, type ChatMessage } from './LlmService'
import { toolRegistry } from '../tools/ToolRegistry'
import { intelRagService } from './IntelRagService'
import { knowledgeGraphContextService } from './KnowledgeGraphContext'
import log from 'electron-log'

const MAX_TURNS = 10
const AGENT_SYSTEM_PROMPT = `You are Heimdall, an intelligence analyst AI with access to tools. Heimdall maintains a KNOWLEDGE GRAPH of every prior analyst conclusion (HUMINT reports), curated briefing (preliminary reports), information gap, and citation link.

OPERATING PROCEDURE for any analytical question:
1. Check the knowledge graph first. Call humint_recall(query) to see what past HUMINTs already concluded. If results are relevant, cite them as [humint:<id>] and build on them — DO NOT redo the work.
2. Next, call preliminary_brief(query) for structured briefings that already synthesized intel on this topic.
3. Use graph_neighborhood(id) to expand around any interesting node; use cited_by(id) to see how a specific intel has shaped prior conclusions.
4. For specific entities (IP, CVE, country, org, threat actor, malware) use entity_lineage to get a chronological citation timeline.
5. ONLY fall back to fresh intel_search / vector_search when the knowledge graph has nothing relevant. When you do use vector_search, prefer include_linked: true so each hit comes with its graph neighbors.

Other tools:
- intel_search / vector_search — keyword and semantic retrieval
- entity_lookup — find reports by IP, CVE, country, etc.
- web_fetch — public URL content (rate-limited)
- whois_lookup, dns_resolve, cve_detail — network / vuln lookups
- shell_exec — network diagnostics (curl, dig, ping)
- create_report — save important findings
- graph_query — low-level Cypher-style graph traversal

Citation convention in your response: [humint:<uuid>] for HUMINT findings, [preliminary:<uuid>] for briefings, [id:<uuid>] for raw intel. Always explain your reasoning. After using tools, synthesize findings into a structured briefing.`

export class ToolCallingAgent {
  async run(
    query: string,
    conversationHistory: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void,
    onToolCall?: (toolName: string, params: unknown, result: string) => void,
    sessionId?: string
  ): Promise<string> {
    const tools = toolRegistry.getToolSchemas()
    const summary = intelRagService.getRecentSummary(24)

    // Knowledge-graph context — top HUMINT + preliminary briefings relevant to
    // the current query. Injected as a separate system message so the agent
    // cannot "forget" institutional memory exists. Capped at ~800 chars.
    let kgContext = ''
    try {
      kgContext = await knowledgeGraphContextService.getRelevantContext(query)
    } catch (err) {
      log.debug(`KG context fetch failed: ${err}`)
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      { role: 'system', content: summary }
    ]
    if (kgContext) messages.push({ role: 'system', content: kgContext })
    messages.push(...conversationHistory.slice(-10))
    messages.push({ role: 'user', content: query })

    let fullResponse = ''
    let turn = 0

    while (turn < MAX_TURNS) {
      turn++
      log.info(`ToolCallingAgent: turn ${turn}/${MAX_TURNS}`)

      // Call LLM with tools
      const conn = llmService.getConnection(connectionId)
      if (!conn) throw new Error('No LLM connection configured')

      const model = conn.model || conn.customModel
      const baseUrl = llmService['normalizeBaseUrl'](conn.baseUrl)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`

      let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          tools,
          tool_choice: 'auto',
          stream: false
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(120000)
      })

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const redir = response.headers.get('location')
        if (redir) {
          response = await fetch(redir, {
            method: 'POST', headers,
            body: JSON.stringify({
              model,
              messages: messages.map((m) => ({ role: m.role, content: m.content })),
              tools, tool_choice: 'auto', stream: false
            }),
            signal: AbortSignal.timeout(120000)
          })
        }
      }

      if (!response.ok) {
        const err = await response.text()
        // If tool calling not supported, fall back to text-based tool parsing
        if (response.status === 400 || response.status === 422) {
          log.info('ToolCallingAgent: provider doesn\'t support tools, falling back to text parsing')
          return this.textBasedToolLoop(query, messages, connectionId, onChunk, onToolCall, sessionId)
        }
        throw new Error(`LLM ${response.status}: ${err.slice(0, 200)}`)
      }

      const data = await response.json() as {
        choices: Array<{
          message: {
            role: string
            content: string | null
            tool_calls?: Array<{
              id: string
              type: 'function'
              function: { name: string; arguments: string }
            }>
          }
          finish_reason: string
        }>
      }

      const choice = data.choices?.[0]
      if (!choice) break

      const msg = choice.message
      const textContent = msg.content || ''
      const toolCalls = msg.tool_calls || []

      // Add assistant message to history
      messages.push({ role: 'assistant', content: textContent || JSON.stringify(toolCalls.map((tc) => ({ tool: tc.function.name, args: tc.function.arguments }))) })

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        if (textContent) {
          fullResponse += textContent
          onChunk?.(textContent)
        }
        break
      }

      // Emit text content before tool calls
      if (textContent) {
        fullResponse += textContent + '\n'
        onChunk?.(textContent + '\n')
      }

      // Execute tool calls
      for (const tc of toolCalls) {
        const toolName = tc.function.name
        let params: Record<string, unknown>
        try {
          params = JSON.parse(tc.function.arguments)
        } catch {
          params = {}
        }

        onChunk?.(`\n**[Tool: ${toolName}]** ${JSON.stringify(params).slice(0, 80)}...\n`)

        const result = await toolRegistry.execute(toolName, params, { sessionId })

        onChunk?.(`\`\`\`\n${result.output.slice(0, 500)}\n\`\`\`\n`)
        onToolCall?.(toolName, params, result.output)

        fullResponse += `\n[Tool: ${toolName}]\n${result.output.slice(0, 500)}\n`

        // Add tool result to messages (OpenAI format)
        messages.push({
          role: 'user' as const,
          content: `Tool result for ${toolName}:\n${result.output.slice(0, 2000)}`
        })
      }
    }

    if (turn >= MAX_TURNS) {
      onChunk?.('\n\n_Max tool-calling turns reached._\n')
    }

    return fullResponse
  }

  // Fallback for providers that don't support native tool calling
  private async textBasedToolLoop(
    query: string,
    messages: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void,
    onToolCall?: (toolName: string, params: unknown, result: string) => void,
    sessionId?: string
  ): Promise<string> {
    const toolList = toolRegistry.getToolNames().map((n) => `- ${n}`).join('\n')
    const toolPrompt = `\n\nAvailable tools:\n${toolList}\n\nTo use a tool, write: [TOOL:tool_name:{"param":"value"}]\nThe result will be provided. You can use multiple tools.`

    messages[0] = { role: 'system', content: AGENT_SYSTEM_PROMPT + toolPrompt }

    let fullResponse = ''
    let turn = 0

    while (turn < MAX_TURNS) {
      turn++

      const response = await llmService.chat(messages, connectionId, (chunk) => {
        fullResponse += chunk
        onChunk?.(chunk)
      })

      fullResponse = response

      // Parse tool calls from text: [TOOL:name:{"params"}]
      const toolPattern = /\[TOOL:(\w+):(\{[^}]+\})\]/g
      const toolMatches = [...response.matchAll(toolPattern)]

      if (toolMatches.length === 0) break

      // Execute tools
      for (const match of toolMatches) {
        const toolName = match[1]
        let params: Record<string, unknown>
        try { params = JSON.parse(match[2]) } catch { params = {} }

        onChunk?.(`\n**[Executing: ${toolName}]**\n`)
        const result = await toolRegistry.execute(toolName, params, { sessionId })
        onChunk?.(`\`\`\`\n${result.output.slice(0, 500)}\n\`\`\`\n`)
        onToolCall?.(toolName, params, result.output)

        messages.push({ role: 'assistant', content: response })
        messages.push({ role: 'user', content: `Tool result for ${toolName}:\n${result.output.slice(0, 2000)}` })
      }
    }

    return fullResponse
  }
}

export const toolCallingAgent = new ToolCallingAgent()
