import { ipcMain } from 'electron'
import log from 'electron-log'
import { networkAnalysisService } from '../services/graph/NetworkAnalysisService'

/**
 * Theme 4 — network analysis IPC.
 *
 * Channels:
 *   network:refresh        → { id, node_count, edge_count, community_count, modularity, duration_ms }
 *   network:latest         → last successful run summary, or null
 *   network:top            ({ metric: 'pagerank'|'betweenness'|'degree'|'eigenvector', limit? }) → Metric[]
 *   network:communities    → community summaries
 *   network:node           (nodeId) → single metric row
 */
export function registerNetworkBridge(): void {
  ipcMain.handle('network:refresh', () => networkAnalysisService.refresh())

  ipcMain.handle('network:latest', () => networkAnalysisService.latestRun())

  ipcMain.handle('network:top', (_evt, args: { metric: 'pagerank' | 'betweenness' | 'degree' | 'eigenvector'; limit?: number }) => {
    if (!['pagerank', 'betweenness', 'degree', 'eigenvector'].includes(args.metric)) {
      throw new Error(`Invalid metric: ${args.metric}`)
    }
    return networkAnalysisService.top(args.metric, args.limit ?? 20)
  })

  ipcMain.handle('network:communities', () => networkAnalysisService.communities())

  ipcMain.handle('network:node', (_evt, nodeId: string) => networkAnalysisService.forNode(nodeId))

  log.info('network bridge registered')
}
