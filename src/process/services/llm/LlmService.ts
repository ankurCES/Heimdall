import { settingsService } from '../settings/SettingsService'
import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import type { LlmConfig, LlmConnection } from '@common/types/settings'
import { PromptBuilder } from './PromptBuilder'
import log from 'electron-log'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type ChatMode = 'agentic' | 'direct' | 'caveman'

export class LlmService {
  getConnections(): LlmConnection[] {
    const config = this.getConfig()
    return config?.connections?.filter((c) => c.enabled) || []
  }

  getConnection(connectionId?: string): LlmConnection | null {
    const config = this.getConfig()
    if (!config?.connections?.length) return null

    if (connectionId) {
      return config.connections.find((c) => c.id === connectionId && c.enabled) || null
    }

    // Return default or first enabled
    const defaultConn = config.connections.find((c) => c.id === config.defaultConnectionId && c.enabled)
    return defaultConn || config.connections.find((c) => c.enabled) || null
  }

  async chat(
    messages: ChatMessage[],
    connectionId?: string,
    onChunk?: (chunk: string) => void,
    mode: ChatMode = 'direct'
  ): Promise<string> {
    const conn = this.getConnection(connectionId)
    if (!conn) throw new Error('No LLM connection configured or enabled. Add one in Settings > LLM.')

    const model = conn.model || conn.customModel
    if (!model) throw new Error(`No model set for connection "${conn.name}". Configure in Settings > LLM.`)

    const systemPrompt = PromptBuilder.build(mode === 'agentic' ? 'agentic' : mode === 'caveman' ? 'caveman' : 'direct')
    let processedMessages = messages

    // Caveman mode: compress messages to save tokens
    if (mode === 'caveman') {
      processedMessages = this.compressMessages(messages)
    }

    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...processedMessages
    ]

    const result = await this.chatOpenAICompatible(conn.baseUrl, conn.apiKey, model, allMessages, onChunk)

    // Track token usage (estimate)
    this.trackUsage(conn.name, model, allMessages, result, mode)

    return result
  }

  async complete(prompt: string, connectionId?: string, maxTokens: number = 1024): Promise<string> {
    const conn = this.getConnection(connectionId)
    if (!conn) throw new Error('No LLM connection configured')
    const model = conn.model || conn.customModel
    if (!model) throw new Error('No model selected')

    return this.chatOpenAICompatible(
      conn.baseUrl, conn.apiKey, model,
      [{ role: 'user', content: prompt }]
    )
  }

  /**
   * Vision-capable completion — constructs the OpenAI-compatible
   * multi-part content format (text + image_url parts) and sends to
   * the configured endpoint. Works with any endpoint that implements
   * the OpenAI vision schema: OpenAI, Anthropic via proxy, Ollama
   * with llava/bakllava/llama3.2-vision, vLLM, LM Studio, etc.
   *
   * Images are passed as full data URLs (data:image/png;base64,…) so
   * callers don't need to worry about hosting them.
   *
   * The request uses a longer timeout (300s) because vision prompts
   * on large images can take a while. Returns empty string on any
   * failure so the caller can decide whether to fall back.
   */
  async completeVision(prompt: string, imageDataUrls: string[], opts: { connectionId?: string; timeoutMs?: number } = {}): Promise<string> {
    const conn = this.getConnection(opts.connectionId)
    if (!conn) throw new Error('No LLM connection configured')
    const model = conn.model || conn.customModel
    if (!model) throw new Error('No model selected')
    if (!imageDataUrls.length) throw new Error('No images supplied')

    const baseUrl = this.normalizeBaseUrl(conn.baseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`
    const chatUrl = `${baseUrl}/chat/completions`

    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: prompt }
    ]
    for (const url of imageDataUrls) {
      parts.push({ type: 'image_url', image_url: { url } })
    }

    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: parts }],
      stream: false
    })

    log.info(`LLM vision: ${chatUrl} model=${model} images=${imageDataUrls.length}`)
    const res = await fetch(chatUrl, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300000)
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`LLM vision ${res.status}: ${err.slice(0, 300)}`)
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ''
    this.trackUsage(conn.name, model, [{ role: 'user', content: prompt }], content, 'agentic')
    return content
  }

  /** Is an LLM connection currently configured + enabled? Used to decide whether to try vision first. */
  hasUsableConnection(): boolean {
    const conn = this.getConnection()
    return !!(conn && (conn.model || conn.customModel))
  }

  private getConfig(): LlmConfig | null {
    const raw = settingsService.get<any>('llm')
    if (!raw) return null
    // Handle legacy single-connection format
    if (raw.baseUrl && !raw.connections) {
      return {
        connections: [{
          id: 'legacy',
          name: 'Default',
          baseUrl: raw.baseUrl,
          apiKey: raw.apiKey || '',
          model: raw.model || '',
          customModel: raw.customModel || '',
          enabled: true
        }],
        defaultConnectionId: 'legacy'
      }
    }
    return raw as LlmConfig
  }

  private normalizeBaseUrl(url: string): string {
    let base = url.replace(/\/+$/, '')
    // Common misconfigurations
    if (base === 'https://ollama.com' || base === 'http://ollama.com') {
      log.warn('LLM: ollama.com is the website, not API. Use https://api.ollama.com/v1 for cloud or http://localhost:11434/v1 for local')
    }
    return base
  }

  private async chatOpenAICompatible(
    rawBaseUrl: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const baseUrl = this.normalizeBaseUrl(rawBaseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const chatUrl = `${baseUrl}/chat/completions`
    log.info(`LLM chat: ${chatUrl} model=${model}`)

    const requestBody = JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: !!onChunk
    })

    if (onChunk) {
      let response = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: requestBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(300000)
      })

      // Handle redirects manually to preserve auth header
      if (response.status >= 300 && response.status < 400) {
        const redirectUrl = response.headers.get('location')
        if (redirectUrl) {
          log.info(`LLM redirected to: ${redirectUrl}`)
          response = await fetch(redirectUrl, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: AbortSignal.timeout(300000)
          })
        }
      }

      if (!response.ok) {
        const err = await response.text()
        throw new Error(`LLM ${response.status} at ${chatUrl}: ${err.slice(0, 200)}`)
      }

      let full = ''
      let sseBuffer = ''
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sseBuffer += decoder.decode(value, { stream: true })

        // Split by newlines, keep last partial line in buffer
        const lines = sseBuffer.split('\n')
        sseBuffer = lines[lines.length - 1]

        // Batch all deltas from this read into one onChunk call
        let batch = ''
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim()
          if (!line || line === 'data: [DONE]' || !line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            const delta = data.choices?.[0]?.delta?.content
            if (delta) {
              full += delta
              batch += delta
            }
          } catch {}
        }
        if (batch) onChunk(batch)
      }
      return full
    }

    let response = await fetch(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false }),
      redirect: 'manual',
      signal: AbortSignal.timeout(300000)
    })

    // Handle redirects manually to preserve auth header
    if (response.status >= 300 && response.status < 400) {
      const redirectUrl = response.headers.get('location')
      if (redirectUrl) {
        log.info(`LLM redirected to: ${redirectUrl}`)
        response = await fetch(redirectUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false }),
          signal: AbortSignal.timeout(300000)
        })
      }
    }

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`LLM ${response.status} at ${chatUrl}: ${err.slice(0, 200)}`)
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> }
    return data.choices?.[0]?.message?.content || ''
  }

  // Caveman mode: compress messages to reduce token count
  private compressMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
      if (m.role === 'system') {
        // Aggressively shorten system context
        let content = m.content
          .replace(/\*\*/g, '')           // strip bold
          .replace(/#{1,3}\s*/g, '')       // strip headings
          .replace(/\n{2,}/g, '\n')        // collapse newlines
          .replace(/\s{2,}/g, ' ')         // collapse spaces
          .replace(/Discipline:/gi, 'D:')
          .replace(/Severity:/gi, 'S:')
          .replace(/Source:/gi, 'Src:')
          .replace(/Verification:/gi, 'V:')
          .replace(/verification_score/gi, 'vscore')
          .replace(/intelligence/gi, 'intel')
          .replace(/information/gi, 'info')
          .replace(/approximately/gi, '~')
          .replace(/organizations?/gi, 'orgs')
          .replace(/government/gi, 'govt')
        // Truncate long system messages more aggressively
        if (content.length > 1000) content = content.slice(0, 1000) + '...[truncated]'
        return { ...m, content }
      }
      return m
    })
  }

  // Track token usage (estimate based on char count / 4)
  private trackUsage(connName: string, model: string, messages: ChatMessage[], response: string, mode: ChatMode): void {
    try {
      const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0)
      const completionChars = response.length
      const promptTokens = Math.ceil(promptChars / 4)
      const completionTokens = Math.ceil(completionChars / 4)

      const db = getDatabase()
      db.prepare(
        'INSERT INTO token_usage (id, connection_name, model, prompt_tokens, completion_tokens, total_tokens, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        generateId(), connName, model,
        promptTokens, completionTokens, promptTokens + completionTokens,
        mode, timestamp()
      )
    } catch (err) {
      log.debug(`Token tracking failed: ${err}`)
    }
  }

  // Get token usage stats
  getUsageStats(): {
    total: { prompt: number; completion: number; total: number }
    byModel: Array<{ model: string; total: number }>
    byMode: Array<{ mode: string; total: number }>
    recent: Array<{ model: string; mode: string; total: number; createdAt: number }>
  } {
    try {
      const db = getDatabase()
      const total = db.prepare(
        'SELECT COALESCE(SUM(prompt_tokens),0) as prompt, COALESCE(SUM(completion_tokens),0) as completion, COALESCE(SUM(total_tokens),0) as total FROM token_usage'
      ).get() as { prompt: number; completion: number; total: number }

      const byModel = db.prepare(
        'SELECT model, SUM(total_tokens) as total FROM token_usage GROUP BY model ORDER BY total DESC'
      ).all() as Array<{ model: string; total: number }>

      const byMode = db.prepare(
        'SELECT mode, SUM(total_tokens) as total FROM token_usage GROUP BY mode ORDER BY total DESC'
      ).all() as Array<{ mode: string; total: number }>

      const recent = db.prepare(
        'SELECT model, mode, total_tokens as total, created_at as createdAt FROM token_usage ORDER BY created_at DESC LIMIT 50'
      ).all() as Array<{ model: string; mode: string; total: number; createdAt: number }>

      return { total, byModel, byMode, recent }
    } catch {
      return { total: { prompt: 0, completion: 0, total: 0 }, byModel: [], byMode: [], recent: [] }
    }
  }
}

export const llmService = new LlmService()
