import { z } from 'zod'

export const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string(),
  password: z.string(),
  tls: z.boolean().default(true),
  fromAddress: z.string().email(),
  defaultRecipients: z.array(z.string().email()).default([])
})

export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
  chatIds: z.array(z.string()).default([]),
  messageFormat: z.enum(['plain', 'markdown', 'html']).default('markdown')
})

export const MeshtasticConfigSchema = z.object({
  connectionType: z.enum(['tcp', 'serial', 'mqtt']).default('tcp'),
  address: z.string().default(''),
  port: z.number().int().default(4403),
  serialPath: z.string().default(''),
  mqttBroker: z.string().default(''),
  mqttTopic: z.string().default('msh/#'),
  channelIndex: z.number().int().default(0),
  enableDispatch: z.boolean().default(false),
  enableCollection: z.boolean().default(false),
  targetNodeIds: z.array(z.string()).default([])
})

export const SafetyConfigSchema = z.object({
  rateLimitPerDomain: z.number().int().min(1).default(30),
  respectRobotsTxt: z.boolean().default(true),
  proxyUrl: z.string().default(''),
  retentionDays: z.number().int().min(1).default(90)
})

export const LlmConfigSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'ollama']).default('openai'),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-4o-mini'),
  ollamaUrl: z.string().default('http://localhost:11434'),
  ollamaModel: z.string().default('llama3.2')
})

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>
export type MeshtasticConfig = z.infer<typeof MeshtasticConfigSchema>
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>
export type LlmConfig = z.infer<typeof LlmConfigSchema>

export interface ApiKeyEntry {
  service: string
  key: string
  label: string
}

export const ObsidianConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().default('https://127.0.0.1:27124'),
  vaultPath: z.string().default(''),
  syncEnabled: z.boolean().default(false),
  syncFolder: z.string().default('Heimdall')
})

export type ObsidianConfig = z.infer<typeof ObsidianConfigSchema>

export interface AppSettings {
  smtp: SmtpConfig
  telegram: TelegramConfig
  meshtastic: MeshtasticConfig
  safety: SafetyConfig
  llm: LlmConfig
  obsidian: ObsidianConfig
  apiKeys: ApiKeyEntry[]
  enabledDisciplines: string[]
}
