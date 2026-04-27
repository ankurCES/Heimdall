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

// MCP server configuration (Model Context Protocol). Each entry spawns
// a child process via stdio transport; tools are auto-registered as
// `mcp:<id>:<tool>` so the agent can call them like any built-in tool.
export const McpServerConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false)
})
export const McpServersConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([])
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>

// Dark-web scanning configuration. Ahmia is clearnet-safe (no Tor needed);
// .onion fetching requires the deployer to run Tor at the configured
// SOCKS5 endpoint. The CSAM blocklist on SafeFetcher always applies.
export const DarkWebConfigSchema = z.object({
  enabled: z.boolean().default(false),
  socks5Host: z.string().default('127.0.0.1'),
  socks5Port: z.number().default(9050),
  ahmiaEnabled: z.boolean().default(true),
  darkSearchEnabled: z.boolean().default(false),
  watchTerms: z.array(z.string()).default(['ransomware', 'data leak', 'credentials', 'vulnerability'])
})
export type DarkWebConfig = z.infer<typeof DarkWebConfigSchema>

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

// Letterhead / agency identity for exported PDF/DOCX reports.
// All fields optional — default branding is "Heimdall Intelligence Platform".
// Logo is stored as a base64 PNG in the settings store; validated to <500KB
// on upload so settings reads stay cheap.
export const LetterheadConfigSchema = z.object({
  agencyName: z.string().default(''),
  agencyTagline: z.string().default(''),
  agencyShortName: z.string().default(''),
  logoBase64: z.string().default(''),
  defaultClassification: z.string().default('UNCLASSIFIED//FOR OFFICIAL USE ONLY'),
  distributionStatement: z.string().default(
    'Distribution authorized for official use only. Reproduction prohibited without originator approval.'
  ),
  footerText: z.string().default(''),
  signaturesEnabled: z.boolean().default(true)
})
export type LetterheadConfig = z.infer<typeof LetterheadConfigSchema>

export interface AppSettings {
  smtp: SmtpConfig
  telegram: TelegramConfig
  meshtastic: MeshtasticConfig
  safety: SafetyConfig
  llm: LlmConfig
  obsidian: ObsidianConfig
  letterhead: LetterheadConfig
  apiKeys: ApiKeyEntry[]
  enabledDisciplines: string[]
}
