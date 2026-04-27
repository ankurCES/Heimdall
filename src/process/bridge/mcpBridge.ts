import { ipcMain } from 'electron'
import log from 'electron-log'
import { mcpClientService } from '../services/mcp/McpClientService'
import { twoPersonService } from '../services/security/TwoPersonService'
import type { McpServerConfig } from '@common/types/settings'

// SECURITY (v1.3.2 — finding C3): renderer-supplied MCP commands could
// previously spawn arbitrary local executables. We now restrict to a
// hard-coded allow-list of process launchers; any path outside this list
// requires a two-person approval AND must be an absolute path inside
// /usr/local/bin, /opt/homebrew/bin, or the userData directory.
//
// The allow-list covers the standard MCP runtimes (npx, uvx, deno, node,
// python, sh, bash) used by the Anthropic reference servers.
const ALLOWED_LAUNCHERS = new Set([
  'npx', 'uvx', 'pnpx', 'yarn',     // package-runner launchers
  'deno', 'node', 'bun',             // JS runtimes
  'python', 'python3', 'uv',         // Python runtimes
  'docker', 'podman'                 // container runners (themselves sandbox)
])

// Narrow allow-list of safe env keys that can be passed through. Anything
// else is dropped (prevents PATH/LD_PRELOAD/DYLD injection).
const SAFE_ENV_KEYS = new Set([
  'NODE_ENV', 'NODE_OPTIONS', 'PYTHONPATH', 'PATH',  // PATH is conservative — see below
  'HOME', 'USER', 'LANG', 'LC_ALL',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',             // common LLM env
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION',
  'GITHUB_TOKEN', 'GITLAB_TOKEN',
  'HEIMDALL_USERDATA'
])

function validateMcpConfig(cfg: McpServerConfig | undefined, opts: { approvalRequestId?: string } = {}):
  { ok: true; sanitized: McpServerConfig } | { ok: false; error: string } {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' }
  if (!cfg.command || typeof cfg.command !== 'string') return { ok: false, error: 'command (string) required' }
  if (!cfg.id || typeof cfg.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(cfg.id)) {
    return { ok: false, error: 'id must match /^[a-zA-Z0-9_-]+$/' }
  }

  const command = cfg.command.trim()
  // Reject obvious injection patterns
  if (/[;&|<>`$()\n\r]/.test(command)) return { ok: false, error: 'command contains shell metacharacters' }

  // basename of the command — what's actually being executed
  const launcherName = command.split('/').pop() || ''

  // Allow the small set of well-known launchers OR an absolute path under
  // a vetted prefix WITH a fresh two-person approval.
  const isLauncher = ALLOWED_LAUNCHERS.has(launcherName) || ALLOWED_LAUNCHERS.has(command)
  const isAbsoluteSafePath = command.startsWith('/usr/local/bin/')
    || command.startsWith('/opt/homebrew/bin/')
    || command.startsWith('/usr/bin/')

  if (!isLauncher) {
    if (!isAbsoluteSafePath) {
      return { ok: false, error: `command "${command}" not on allow-list (npx/uvx/node/python/...) and not an absolute path under /usr/{local,bin} or /opt/homebrew/bin` }
    }
    // Absolute path → require fresh two-person approval if 2P enabled
    if (twoPersonService.isEnabled()) {
      if (!opts.approvalRequestId) {
        return { ok: false, error: `two-person approval required to register custom MCP command: ${command}` }
      }
      const verdict = twoPersonService.checkApproved(opts.approvalRequestId, 'mcp:add_server')
      if (!verdict.ok) return { ok: false, error: verdict.reason || 'approval not granted' }
    }
  }

  // Validate args — must all be strings, no shell metachars
  const args = Array.isArray(cfg.args) ? cfg.args : []
  for (const a of args) {
    if (typeof a !== 'string') return { ok: false, error: 'all args must be strings' }
    if (a.length > 2000) return { ok: false, error: 'arg too long (>2000 chars)' }
  }

  // Filter env to safe keys only
  const env: Record<string, string> = {}
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v !== 'string') continue
      if (SAFE_ENV_KEYS.has(k)) env[k] = v
      else log.warn(`mcp: dropping unsafe env key "${k}" from MCP config "${cfg.id}"`)
    }
  }

  return {
    ok: true,
    sanitized: {
      ...cfg,
      command,
      args,
      env
    } as McpServerConfig
  }
}

export function registerMcpBridge(): void {
  ipcMain.handle('mcp:list_servers', () => mcpClientService.listHealth())
  ipcMain.handle('mcp:list_tools', async (_e, serverId: string) =>
    await mcpClientService.listToolsFor(serverId)
  )

  // SECURITY: validated via allow-list + (when 2P enabled) approval gate
  ipcMain.handle('mcp:add_server', async (_e, args: { config: McpServerConfig; approvalRequestId?: string } | McpServerConfig) => {
    // Backwards-compat: accept either { config, approvalRequestId } or raw config
    const cfg = (args as { config?: McpServerConfig }).config || (args as McpServerConfig)
    const approvalRequestId = (args as { approvalRequestId?: string }).approvalRequestId
    const v = validateMcpConfig(cfg, { approvalRequestId })
    if (!v.ok) return { ok: false, error: v.error }
    try {
      await mcpClientService.addServer(v.sanitized)
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err) } }
  })

  ipcMain.handle('mcp:update_server', async (_e, args: { id: string; patch: Partial<McpServerConfig>; approvalRequestId?: string }) => {
    // If patch changes command, re-validate the resulting config
    if (args.patch.command || args.patch.args || args.patch.env) {
      try {
        const existing = mcpClientService.listHealth().find((s) => s.id === args.id)
        if (existing) {
          const merged = { ...existing, ...args.patch } as McpServerConfig
          const v = validateMcpConfig(merged, { approvalRequestId: args.approvalRequestId })
          if (!v.ok) return { ok: false, error: v.error }
          await mcpClientService.updateServer(args.id, v.sanitized)
          return { ok: true }
        }
      } catch (err) { return { ok: false, error: String(err) } }
    }
    await mcpClientService.updateServer(args.id, args.patch)
    return { ok: true }
  })

  ipcMain.handle('mcp:remove_server', async (_e, id: string) => {
    await mcpClientService.removeServer(id); return { ok: true }
  })
  ipcMain.handle('mcp:restart_server', async (_e, id?: string) => {
    await mcpClientService.restart(id); return { ok: true }
  })

  ipcMain.handle('mcp:test_server', async (_e, args: { config: McpServerConfig; approvalRequestId?: string } | McpServerConfig) => {
    const cfg = (args as { config?: McpServerConfig }).config || (args as McpServerConfig)
    const approvalRequestId = (args as { approvalRequestId?: string }).approvalRequestId
    const v = validateMcpConfig(cfg, { approvalRequestId })
    if (!v.ok) return { ok: false, error: v.error }
    try { return await mcpClientService.testServer(v.sanitized) }
    catch (err) { return { ok: false, error: String(err) } }
  })

  log.info('mcp bridge registered (with v1.3.2 security validation)')
}
