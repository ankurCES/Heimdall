import { ipcMain } from 'electron'
import { compartmentService } from '../services/security/CompartmentService'
import log from 'electron-log'

/**
 * IPC bridge for need-to-know compartments (Theme 10.2 + 10.5).
 */
export function registerCompartmentBridge(): void {
  ipcMain.handle('compartments:list', () => compartmentService.list())
  ipcMain.handle('compartments:list_with_grants', (_e, params: { actor?: string } = {}) => {
    return compartmentService.listWithGrantState(params.actor || 'self')
  })
  ipcMain.handle('compartments:get', (_e, params: { id: string }) => compartmentService.get(params.id))
  ipcMain.handle('compartments:create', (_e, params: { ticket: string; name: string; description?: string; color?: string }) => {
    return compartmentService.create(params)
  })
  ipcMain.handle('compartments:update', (_e, params: { id: string; patch: Record<string, unknown> }) => {
    return compartmentService.update(params.id, params.patch)
  })
  ipcMain.handle('compartments:delete', (_e, params: { id: string }) => {
    compartmentService.delete(params.id)
    return { ok: true }
  })

  // Grants
  ipcMain.handle('compartments:grant', (_e, params: { compartment_id: string; actor?: string; granted_by?: string; notes?: string }) => {
    return compartmentService.grant(params.compartment_id, {
      actor: params.actor, granted_by: params.granted_by, notes: params.notes
    })
  })
  ipcMain.handle('compartments:revoke', (_e, params: { compartment_id: string; actor?: string }) => {
    compartmentService.revoke(params.compartment_id, params.actor || 'self')
    return { ok: true }
  })
  ipcMain.handle('compartments:granted_ids', (_e, params: { actor?: string } = {}) => {
    return compartmentService.activeGrantedCompartments(params.actor || 'self')
  })

  // Per-artifact tagging
  ipcMain.handle('compartments:tag', (_e, params: { artifact_type: string; artifact_id: string; compartment_ids: string[] }) => {
    compartmentService.setArtifactCompartments(params.artifact_type, params.artifact_id, params.compartment_ids)
    return { ok: true }
  })
  ipcMain.handle('compartments:get_for_artifact', (_e, params: { artifact_type: string; artifact_id: string }) => {
    return compartmentService.getArtifactCompartments(params.artifact_type, params.artifact_id)
  })

  log.info('Compartment bridge registered')
}
