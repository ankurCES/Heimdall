import { ipcMain } from 'electron'
import log from 'electron-log'
import { networkAnalysisService } from '../services/graph/NetworkAnalysisService'

/**
 * Theme 4 — network analysis IPC.
 */
export function registerNetworkBridge(): void {
  ipcMain.handle('network:refresh', (_evt, args?: { since?: number | null; until?: number | null }) => {
    return networkAnalysisService.refresh(args ?? undefined)
  })

  ipcMain.handle('network:latest', () => networkAnalysisService.latestRun())

  ipcMain.handle('network:top', (_evt, args: { metric: 'pagerank' | 'betweenness' | 'degree' | 'eigenvector'; limit?: number }) => {
    if (!['pagerank', 'betweenness', 'degree', 'eigenvector'].includes(args.metric)) {
      throw new Error(`Invalid metric: ${args.metric}`)
    }
    return networkAnalysisService.top(args.metric, args.limit ?? 20)
  })

  ipcMain.handle('network:communities', () => networkAnalysisService.communities())

  ipcMain.handle('network:node', (_evt, nodeId: string) => networkAnalysisService.forNode(nodeId))

  ipcMain.handle('network:search', (_evt, args: { query: string; limit?: number }) => {
    return networkAnalysisService.searchNodes(args.query, args.limit ?? 20)
  })

  ipcMain.handle('network:predict', (_evt, args: { node_id: string; limit?: number }) => {
    return networkAnalysisService.predictLinks(args.node_id, args.limit ?? 20)
  })

  log.info('network bridge registered')
}
