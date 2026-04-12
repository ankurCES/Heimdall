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
    if (!config) throw new Error('LLM not configured')

    const allMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    switch (config.provider) {
      case 'openai':
        return this.chatOpenAI(config, allMessages, onChunk)
      case 'anthropic':
        return this.chatAnthropic(config, allMessages, onChunk)
      case 'ollama':
        return this.chatOllama(config, allMessages, onChunk)
      default:
        throw new Error(`Unknown LLM provider: ${config.provider}`)
    }
  }

  private async chatOpenAI(config: LlmConfig, messages: ChatMessage[], onChunk?: (chunk: string)=> void): Promise<string> {
    const apiKey = config.apiKey || settingsService.get<string>('apikeys.openai')
    if (!apiKey) throw new Error('OpenAI API key not configured')

    const OpenAI = (await import('openai')).default
    const client = new OpenAI({ apiKey })

    if (onChunk) {
      const stream = await client.chat.completions.create({
        model: config.model || 'gpt-4o-mini',
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true
      })

      let full = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || ''
        if (delta) {
          full += delta
          onChunk(delta)
        }
      }
      return full
    }

    const response = await client.chat.completions.create({
      model: config.model || 'gpt-4o-mini',
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    })
    return response.choices[0]?.message?.content || ''
  }

  private async chatAnthropic(config: LlmConfig, messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<string> {
    const apiKey = config.apiKey || settingsService.get<string>('apikeys.anthropic')
    if (!apiKey) throw new Error('Anthropic API key not configured')

    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey })

    const systemMsg = messages.find((m) => m.role === 'system')?.content || ''
    const chatMsgs = messages.filter((m) => m.role !== 'system')

    if (onChunk) {
      const stream = await client.messages.stream({
        model: config.model || 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemMsg,
        messages: chatMsgs.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      })

      let full = ''
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          full += event.delta.text
          onChunk(event.delta.text)
        }
      }
      return full
    }

    const response = await client.messages.create({
      model: config.model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemMsg,
      messages: chatMsgs.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    })
    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.type === 'text' ? textBlock.text : ''
  }

  private async chatOllama(config: LlmConfig, messages: ChatMessage[], onChunk?: (chunk: string) => void): Promise<string> {
    const baseUrl = config.ollamaUrl || 'http://localhost:11434'
    const model = config.ollamaModel || 'llama3.2'

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: !!onChunk
      })
    })

    if (!response.ok) throw new Error(`Ollama error: ${response.status}`)

    if (onChunk && response.body) {
      let full = ''
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            if (data.message?.content) {
              full += data.message.content
              onChunk(data.message.content)
            }
          } catch {}
        }
      }
      return full
    }

    const data = await response.json() as { message: { content: string } }
    return data.message?.content || ''
  }
}

export const llmService = new LlmService()
