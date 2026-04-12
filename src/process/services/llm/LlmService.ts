import { settingsService } from '../settings/SettingsService'
import type { LlmConfig, LlmConnection } from '@common/types/settings'
import log from 'electron-log'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

const SYSTEM_PROMPT = `You are Heimdall, an intelligence analyst AI assistant. You help analyze collected intelligence data from multiple disciplines (OSINT, CYBINT, FININT, SOCMINT, GEOINT, SIGINT, RUMINT, CI, Agency).

When presented with intelligence reports, you:
- Identify patterns, connections, and anomalies across disciplines
- Assess threat levels and verification scores critically
- Cross-reference information from multiple sources
- Provide actionable analysis with clear recommendations
- Flag potential misinformation or low-verification data
- Use proper intelligence analysis tradecraft

Always cite the discipline and source of information you reference. Be precise and concise.`

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
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const conn = this.getConnection(connectionId)
    if (!conn) throw new Error('No LLM connection configured or enabled. Add one in Settings > LLM.')

    const model = conn.model || conn.customModel
    if (!model) throw new Error(`No model set for connection "${conn.name}". Configure in Settings > LLM.`)

    const allMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    return this.chatOpenAICompatible(conn.baseUrl, conn.apiKey, model, allMessages, onChunk)
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
        signal: AbortSignal.timeout(120000)
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
            signal: AbortSignal.timeout(120000)
          })
        }
      }

      if (!response.ok) {
        const err = await response.text()
        throw new Error(`LLM ${response.status} at ${chatUrl}: ${err.slice(0, 200)}`)
      }

      let full = ''
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })

        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed === 'data: [DONE]') continue
          if (!trimmed.startsWith('data: ')) continue
          try {
            const data = JSON.parse(trimmed.slice(6))
            const delta = data.choices?.[0]?.delta?.content
            if (delta) {
              full += delta
              onChunk(delta)
            }
          } catch {}
        }
      }
      return full
    }

    let response = await fetch(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: false }),
      redirect: 'manual',
      signal: AbortSignal.timeout(120000)
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
          signal: AbortSignal.timeout(120000)
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
}

export const llmService = new LlmService()
