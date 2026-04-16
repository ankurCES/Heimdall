import { ipcMain } from 'electron'
import log from 'electron-log'
import { mcpClientService } from '../services/mcp/McpClientService'
import type { McpServerConfig } from '@common/types/settings'

export function registerMcpBridge(): void {
  ipcMain.handle('mcp:list_servers', () => mcpClientService.listHealth())
  ipcMain.handle('mcp:list_tools', async (_e, serverId: string) =>
    await mcpClientService.listToolsFor(serverId)
  )
  ipcMain.handle('mcp:add_server', async (_e, cfg: McpServerConfig) => {
    await mcpClientService.addServer(cfg); return { ok: true }
  })
  ipcMain.handle('mcp:update_server', async (_e, args: { id: string; patch: Partial<McpServerConfig> }) => {
    await mcpClientService.updateServer(args.id, args.patch); return { ok: true }
  })
  ipcMain.handle('mcp:remove_server', async (_e, id: string) => {
    await mcpClientService.removeServer(id); return { ok: true }
  })
  ipcMain.handle('mcp:restart_server', async (_e, id?: string) => {
    await mcpClientService.restart(id); return { ok: true }
  })
  ipcMain.handle('mcp:test_server', async (_e, cfg: McpServerConfig) =>
    await mcpClientService.testServer(cfg)
  )

  log.info('mcp bridge registered')
}
