import { ipcMain, BrowserWindow } from 'electron'
import log from 'electron-log'
import { workflowEngine } from '../services/workflow/WorkflowEngine'
import { nodeRegistry } from '../services/workflow/NodeRegistry'
import { seedDefaultWorkflows } from '../services/workflow/DefaultWorkflowSeeder'
import { generateId } from '@common/utils/id'

function safeBroadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* */ }
  }
}

export function registerWorkflowBridge(): void {
  // ── Node types ─────────────────────────────────────────────────────
  ipcMain.handle('workflow:node_types', () => nodeRegistry.getAllTypes())

  ipcMain.handle('workflow:register_custom_node', (_e, params: {
    type: string; label: string; description: string
    inputs: Array<{ name: string; type: string }>
    outputs: Array<{ name: string; type: string }>
    prompt: string
  }) => {
    nodeRegistry.registerCustom({
      type: params.type,
      label: params.label,
      description: params.description,
      category: 'transform',
      icon: 'Sparkles',
      color: 'border-purple-400',
      inputs: params.inputs as any,
      outputs: params.outputs as any,
      configSchema: [],
      isCustom: true,
      customPrompt: params.prompt
    })
    return { ok: true }
  })

  // ── Workflows CRUD ─────────────────────────────────────────────────
  ipcMain.handle('workflow:list', () => workflowEngine.listWorkflows())

  ipcMain.handle('workflow:get', (_e, params: { id: string }) => workflowEngine.getWorkflow(params.id))

  ipcMain.handle('workflow:save', (_e, params: {
    id?: string; name: string; description?: string
    nodes: any[]; edges: any[]; isPreset?: boolean
  }) => {
    return workflowEngine.saveWorkflow({
      id: params.id || generateId(),
      name: params.name,
      description: params.description || null,
      nodes: params.nodes,
      edges: params.edges,
      isPreset: params.isPreset || false
    })
  })

  ipcMain.handle('workflow:delete', (_e, params: { id: string }) => {
    workflowEngine.deleteWorkflow(params.id)
    return { ok: true }
  })

  // ── Execution ──────────────────────────────────────────────────────
  ipcMain.handle('workflow:execute', async (_e, params: {
    workflowId: string
    inputs?: Record<string, unknown>
    sessionId?: string
    connectionId?: string
  }) => {
    const workflow = workflowEngine.getWorkflow(params.workflowId)
    if (!workflow) return { ok: false, error: 'Workflow not found' }

    const onProgress = (nodeId: string, status: string, message?: string) => {
      safeBroadcast('workflow:node_progress', { workflowId: params.workflowId, nodeId, status, message })
    }

    const result = await workflowEngine.execute(workflow, params.inputs, onProgress, {
      sessionId: params.sessionId, connectionId: params.connectionId
    })

    safeBroadcast('workflow:run_complete', result)
    return { ok: true, result }
  })

  ipcMain.handle('workflow:runs', (_e, params: { workflowId?: string; limit?: number } = {}) => {
    return workflowEngine.listRuns(params.workflowId, params.limit)
  })

  // Seed default workflows on first boot.
  try { seedDefaultWorkflows() } catch (err) { log.debug(`workflow seeder: ${err}`) }

  log.info('Workflow bridge registered')
}
