import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import type { McpServerConfig } from '@common/types/settings'

/**
 * Curated default MCP servers seeded on first launch when settings has
 * no `mcp.servers` entries.
 *
 * Selection rules:
 *   - No authentication / API keys required
 *   - stdio transport (covered by official SDK out of the box)
 *   - Useful for HUMINT / OSINT enrichment (web fetch, knowledge lookup,
 *     domain investigation)
 *
 * Servers using `uvx` need `uv` (https://github.com/astral-sh/uv) on PATH;
 * if missing, the McpClientService marks the server as 'error' with a
 * clear message rather than failing app boot.
 */
export function defaultMcpServers(): McpServerConfig[] {
  const fsSandbox = path.join(app.getPath('userData'), 'mcp-fs')
  // Ensure the sandbox dir exists so the filesystem server doesn't crash on boot.
  try { fs.mkdirSync(fsSandbox, { recursive: true }) } catch { /* noop */ }
  return [
    // ── Anthropic reference set ──────────────────────────────────────
    {
      id: 'fetch',
      name: 'Web Fetch',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'memory',
      name: 'Persistent Knowledge Graph',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'time',
      name: 'Date/Time Utilities',
      command: 'uvx',
      args: ['mcp-server-time'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'filesystem',
      name: 'Sandboxed Filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', fsSandbox],
      env: {},
      enabled: true,
      builtin: true
    },
    // ── Research / OSINT ────────────────────────────────────────────
    {
      id: 'wikipedia',
      name: 'Wikipedia',
      command: 'npx',
      args: ['-y', 'mcp-server-wikipedia'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'arxiv',
      name: 'arXiv Papers',
      command: 'npx',
      args: ['-y', 'arxiv-mcp-server'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'whois',
      name: 'Domain WHOIS',
      command: 'npx',
      args: ['-y', 'whois-mcp'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'dns',
      name: 'DNS Lookup',
      command: 'npx',
      args: ['-y', 'dns-mcp'],
      env: {},
      enabled: true,
      builtin: true
    }
  ]
}
