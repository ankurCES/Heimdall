import { BrowserWindow } from 'electron'
import { settingsService } from '../settings/SettingsService'
import type { LlmConfig } from '@common/types/settings'
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
  async chat(messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<string> {
    const config = settingsService.get<LlmConfig>('llm')
    if (!config?.baseUrl) throw new Error('LLM not configured — set Base URL in Settings > LLM')

    const model = config.model || config.customModel
    if (!model) throw new Error('No model selected — configure in Settings > LLM')

    const allMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    return this.chatOpenAICompatible(config.baseUrl, config.apiKey, model, allMessages, onChunk)
  }

  async complete(prompt: string, maxTokens: number = 1024): Promise<string> {
    const config = settingsService.get<LlmConfig>('llm')
    if (!config?.baseUrl) throw new Error('LLM not configured')
    const model = config.model || config.customModel
    if (!model) throw new Error('No model selected')

    return this.chatOpenAICompatible(
      config.baseUrl, config.apiKey, model,
      [{ role: 'user', content: prompt }]
    )
  }

  private async chatOpenAICompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    // Streaming
    if (onChunk) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true
        })
      })

      if (!response.ok) {
        const err = await response.text()
        throw new Error(`LLM API error ${response.status}: ${err.slice(0, 200)}`)
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

    // Non-streaming
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false
      })
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`LLM API error ${response.status}: ${err.slice(0, 200)}`)
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> }
    return data.choices?.[0]?.message?.content || ''
  }
}

export const llmService = new LlmService()
