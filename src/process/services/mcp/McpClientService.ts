import log from 'electron-log'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { settingsService } from '../settings/SettingsService'
import { toolRegistry, type ToolDefinition } from '../tools/ToolRegistry'
import { defaultMcpServers } from './defaultServers'
import type { McpServerConfig, McpServersConfig } from '@common/types/settings'

/**
 * Model Context Protocol (MCP) client service.
 *
 * Reads `mcp.servers` from settings (or seeds defaults on first run),
 * spawns each server as a child process via stdio transport, lists its
 * exposed tools, and registers each one in the existing ToolRegistry
 * with the prefixed name `mcp:<server-id>:<tool-name>`.
 *
 * The chat agent (ToolCallingAgent) discovers tools via
 * toolRegistry.getToolSchemas() — no agent changes needed.
 *
 * HumintService.createFromSession() already harvests tool calls from
 * assistant messages by regex, so MCP tool usage automatically lands in
 * humint_reports.tool_calls_used and is searchable via humint_recall.
 *
 * Health: per-server status is tracked (connected / disconnected /
 * error) so the UI can show what's reachable without spamming logs.
 */

export type ServerStatus = 'connected' | 'disconnected' | 'error' | 'starting'

export interface McpServerHealth {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  builtin: boolean
  status: ServerStatus
  last_error: string | null
  tool_count: number
  connected_at: number | null
}

interface ConnectedClient {
  client: Client
  transport: StdioClientTransport
  config: McpServerConfig
  toolNames: string[]
}

class McpClientServiceImpl {
  private clients = new Map<string, ConnectedClient>()
  private health = new Map<string, McpServerHealth>()
  private starting = false

  /**
   * Read settings, seed defaults if empty. On every call, also reconcile
   * builtin server command+args against the current defaultMcpServers()
   * — this catches the case where an older app version seeded a server
   * with a broken command (e.g. uvx) that we've since replaced. The
   * user's `enabled` toggle is preserved.
   */
  private getServerConfigs(): McpServerConfig[] {
    const cfg = settingsService.get<McpServersConfig>('mcp.servers')
    const defaults = defaultMcpServers()
    const defaultsById = new Map(defaults.map((d) => [d.id, d]))

    let servers: McpServerConfig[]
    if (cfg && Array.isArray(cfg.servers) && cfg.servers.length > 0) {
      servers = cfg.servers
    } else {
      // First run — seed all defaults.
      servers = defaults
      settingsService.set('mcp.servers', { servers })
      log.info(`mcp: seeded ${defaults.length} default servers`)
      return servers
    }

    // Reconcile: for any builtin server in storage, refresh command+args
    // from the current defaults if they differ. Preserves enabled flag.
    let changed = false
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i]
      if (!s.builtin) continue
      const def = defaultsById.get(s.id)
      if (!def) continue
      if (s.command !== def.command || JSON.stringify(s.args) !== JSON.stringify(def.args)) {
        log.info(`mcp: reconciling builtin server "${s.id}" — ${s.command} ${s.args.join(' ')} → ${def.command} ${def.args.join(' ')}`)
        servers[i] = { ...def, enabled: s.enabled }
        changed = true
      }
    }
    // Remove any builtin entries no longer in the current defaults (e.g. a
    // server was renamed or replaced in a new app version). Custom (non-
    // builtin) entries are preserved.
    const beforeLen = servers.length
    servers = servers.filter((s) => !s.builtin || defaultsById.has(s.id))
    if (servers.length !== beforeLen) {
      changed = true
      log.info(`mcp: removed ${beforeLen - servers.length} stale builtin server(s)`)
    }
    // Add any new builtins that aren't in storage yet (e.g. after upgrade).
    for (const def of defaults) {
      if (!servers.find((s) => s.id === def.id)) {
        servers.push(def)
        changed = true
        log.info(`mcp: added new builtin server "${def.id}"`)
      }
    }
    if (changed) settingsService.set('mcp.servers', { servers })
    return servers
  }

  /** Start (or restart) all enabled servers. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.starting) return
    this.starting = true
    try {
      await this.stop()
      const configs = this.getServerConfigs()
      for (const cfg of configs) {
        if (!cfg.enabled) {
          this.health.set(cfg.id, this.makeHealth(cfg, 'disconnected', null, 0))
          continue
        }
        await this.startOne(cfg)
      }
      log.info(`mcp: started ${this.clients.size}/${configs.length} server(s)`)
    } finally {
      this.starting = false
    }
  }

  private async startOne(cfg: McpServerConfig): Promise<void> {
    this.health.set(cfg.id, this.makeHealth(cfg, 'starting', null, 0))
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...process.env as Record<string, string>, ...cfg.env }
      })
      const client = new Client({ name: 'heimdall', version: '0.8.0' }, {
        capabilities: {}
      })
      await client.connect(transport)

      // List tools exposed by the server.
      const list = await client.listTools()
      const toolNames: string[] = []
      for (const tool of list.tools) {
        const fullName = `mcp:${cfg.id}:${tool.name}`
        const def: ToolDefinition = {
          name: fullName,
          description: `[MCP/${cfg.id}] ${tool.description ?? tool.name}`.slice(0, 1000),
          // Coerce the MCP tool schema (JSON-Schema) into the registry's expected shape.
          parameters: (tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema as Record<string, unknown>
            : { type: 'object', properties: {} }) as ToolDefinition['parameters'],
          requiresApproval: false
        }
        toolRegistry.register(def, async (params) => {
          try {
            const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> })
            // Normalise content into a single string for the chat surface.
            const text = (result.content as Array<{ type: string; text?: string }> | undefined)
              ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text)
              .join('\n') ?? ''
            return { output: text || JSON.stringify(result), data: result }
          } catch (err) {
            return { output: '', error: (err as Error).message }
          }
        })
        toolNames.push(fullName)
      }

      this.clients.set(cfg.id, { client, transport, config: cfg, toolNames })
      this.health.set(cfg.id, this.makeHealth(cfg, 'connected', null, toolNames.length))
      log.info(`mcp: started ${cfg.id} — ${toolNames.length} tool(s) registered`)
    } catch (err) {
      const msg = (err as Error).message
      log.warn(`mcp: failed to start ${cfg.id}: ${msg}`)
      this.health.set(cfg.id, this.makeHealth(cfg, 'error', msg, 0))
    }
  }

  /** Stop one or all servers and unregister their tools. */
  async stop(serverId?: string): Promise<void> {
    const ids = serverId ? [serverId] : Array.from(this.clients.keys())
    for (const id of ids) {
      const c = this.clients.get(id)
      if (!c) continue
      // Unregister tools.
      for (const name of c.toolNames) {
        try { toolRegistry.unregister?.(name) } catch { /* not all registries support */ }
      }
      try { await c.client.close() } catch { /* noop */ }
      this.clients.delete(id)
      const h = this.health.get(id)
      if (h) this.health.set(id, { ...h, status: 'disconnected', tool_count: 0 })
    }
  }

  /** Restart one server by id (or all if no id). */
  async restart(serverId?: string): Promise<void> {
    if (serverId) {
      const cfg = this.getServerConfigs().find((s) => s.id === serverId)
      await this.stop(serverId)
      if (cfg && cfg.enabled) await this.startOne(cfg)
    } else {
      await this.start()
    }
  }

  listHealth(): McpServerHealth[] {
    // Make sure every configured server has a health entry, even if not started.
    const configs = this.getServerConfigs()
    for (const cfg of configs) {
      if (!this.health.has(cfg.id)) {
        this.health.set(cfg.id, this.makeHealth(cfg, cfg.enabled ? 'disconnected' : 'disconnected', null, 0))
      }
    }
    return Array.from(this.health.values())
  }

  /** Return tool schemas for a connected server (for the UI tool list). */
  async listToolsFor(serverId: string): Promise<Array<{ name: string; description: string }>> {
    const c = this.clients.get(serverId)
    if (!c) return []
    try {
      const list = await c.client.listTools()
      return list.tools.map((t) => ({ name: t.name, description: t.description ?? '' }))
    } catch (err) {
      log.warn(`mcp: listToolsFor(${serverId}) failed: ${(err as Error).message}`)
      return []
    }
  }

  /** Add a custom server (writes settings + starts it). */
  async addServer(cfg: McpServerConfig): Promise<void> {
    const all = this.getServerConfigs()
    if (all.some((s) => s.id === cfg.id)) {
      throw new Error(`Server id "${cfg.id}" already exists`)
    }
    all.push({ ...cfg, builtin: false })
    settingsService.set('mcp.servers', { servers: all })
    if (cfg.enabled) await this.startOne(cfg)
  }

  async updateServer(id: string, patch: Partial<McpServerConfig>): Promise<void> {
    const all = this.getServerConfigs()
    const idx = all.findIndex((s) => s.id === id)
    if (idx === -1) throw new Error(`Server id "${id}" not found`)
    const next: McpServerConfig = { ...all[idx], ...patch, id, builtin: all[idx].builtin }
    all[idx] = next
    settingsService.set('mcp.servers', { servers: all })
    await this.restart(id)
  }

  async removeServer(id: string): Promise<void> {
    const all = this.getServerConfigs().filter((s) => s.id !== id)
    settingsService.set('mcp.servers', { servers: all })
    await this.stop(id)
    this.health.delete(id)
  }

  /** Test a config without persisting — spawn, listTools, close. */
  async testServer(cfg: McpServerConfig): Promise<{ ok: boolean; error?: string; tool_count?: number }> {
    let transport: StdioClientTransport | null = null
    let client: Client | null = null
    try {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...process.env as Record<string, string>, ...cfg.env }
      })
      client = new Client({ name: 'heimdall-test', version: '0.8.0' }, { capabilities: {} })
      await client.connect(transport)
      const list = await client.listTools()
      return { ok: true, tool_count: list.tools.length }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      try { if (client) await client.close() } catch { /* noop */ }
    }
  }

  private makeHealth(cfg: McpServerConfig, status: ServerStatus, error: string | null, toolCount: number): McpServerHealth {
    return {
      id: cfg.id,
      name: cfg.name,
      command: cfg.command,
      args: cfg.args,
      enabled: cfg.enabled,
      builtin: cfg.builtin,
      status,
      last_error: error,
      tool_count: toolCount,
      connected_at: status === 'connected' ? Date.now() : null
    }
  }
}

export const mcpClientService = new McpClientServiceImpl()
