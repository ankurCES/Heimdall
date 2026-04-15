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
  retentionDays: z.number().int().min(1).default(90),
  // Theme 10.6 — air-gap mode. When true, SafeFetcher rejects any outbound
  // fetch whose hostname isn't in airGapAllowlist (exact or DNS suffix match).
  airGapMode: z.boolean().default(false),
  airGapAllowlist: z.array(z.string()).default([])
})

export const LlmConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  customModel: z.string().default(''),
  enabled: z.boolean().default(true)
})

export const LlmConfigSchema = z.object({
  connections: z.array(LlmConnectionSchema).default([]),
  defaultConnectionId: z.string().default('')
})

export type LlmConnection = z.infer<typeof LlmConnectionSchema>
export type LlmConfig = z.infer<typeof LlmConfigSchema>

// Keep old shape for backward compat
export const LlmConfigLegacySchema = z.object({
  baseUrl: z.string().default('https://api.openai.com/v1'),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-4o-mini'),
  customModel: z.string().default(''),
  connected: z.boolean().default(false)
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
