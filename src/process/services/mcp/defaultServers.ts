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
 *   - npm-installable via `npx -y` (no `uv` / Python dependency to keep
 *     the out-of-box experience tight; `npx` is bundled with Node which
 *     Electron always has)
 *   - Useful for HUMINT / OSINT enrichment (web fetch, knowledge lookup,
 *     domain investigation, time arithmetic, persistent memory)
 *
 * All packages are public, no-auth, and verified to start via npm.
 */
export function defaultMcpServers(): McpServerConfig[] {
  const fsSandbox = path.join(app.getPath('userData'), 'mcp-fs')
  // Ensure the sandbox dir exists so the filesystem server doesn't crash on boot.
  try { fs.mkdirSync(fsSandbox, { recursive: true }) } catch { /* noop */ }
  return [
    // ── Anthropic reference set (npm) ────────────────────────────────
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
      id: 'filesystem',
      name: 'Sandboxed Filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', fsSandbox],
      env: {},
      enabled: true,
      builtin: true
    },
    // ── Community npm packages (verified) ───────────────────────────
    {
      id: 'fetch',
      name: 'Web Fetch',
      command: 'npx',
      args: ['-y', '@kazuph/mcp-fetch'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'time',
      name: 'Date/Time Utilities',
      command: 'npx',
      args: ['-y', 'time-mcp'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'wikipedia',
      name: 'Wikipedia',
      command: 'npx',
      args: ['-y', 'wikipedia-mcp'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      // OpenAlex is a strict superset of arXiv (academic papers including
      // preprints) and is pure Node. Replaces the broken arxiv-mcp-server
      // wrapper which required Python 3.11/3.12.
      id: 'academic',
      name: 'Academic Papers (OpenAlex)',
      command: 'npx',
      args: ['-y', 'openalex-mcp'],
      env: {},
      enabled: true,
      builtin: true
    },
    {
      id: 'duckduckgo',
      name: 'DuckDuckGo Search',
      command: 'npx',
      args: ['-y', 'duckduckgo-mcp'],
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
      args: ['-y', 'mcp-server-dns'],
      env: {},
      enabled: true,
      builtin: true
    }
  ]
}
