import { ipcMain } from 'electron'
import log from 'electron-log'
import { wargamingService } from '../services/llm/WargamingService'
import { twoPersonService } from '../services/security/TwoPersonService'

export function registerWargameBridge(): void {
  // Wargaming
  ipcMain.handle('wargame:start', async (_e, args: { scenario: string; red_objective?: string; blue_objective?: string; total_rounds?: number; classification?: string }) =>
    await wargamingService.run(args)
  )
  ipcMain.handle('wargame:get', (_e, id: string) => wargamingService.get(id))
  ipcMain.handle('wargame:rounds', (_e, runId: string) => wargamingService.getRounds(runId))
  ipcMain.handle('wargame:list', (_e, args?: { limit?: number }) => wargamingService.list(args?.limit ?? 20))

  // Two-person integrity
  ipcMain.handle('twoperson:status', () => ({
    enabled: twoPersonService.isEnabled(),
    has_passphrase: twoPersonService.hasPassphrase()
  }))
  ipcMain.handle('twoperson:set_passphrase', (_e, passphrase: string) => {
    twoPersonService.setPassphrase(passphrase); return { ok: true }
  })
  // SECURITY (v1.3.2): require the passphrase to disable. A renderer
  // compromise could otherwise call this directly and silently remove
  // the second-person gate. Falls back to permissive when no passphrase
  // is set (i.e. two-person was never properly enabled).
  ipcMain.handle('twoperson:disable', (_e, args: { passphrase?: string } = {}) => {
    if (twoPersonService.isEnabled() && twoPersonService.hasPassphrase()) {
      const passphrase = args?.passphrase || ''
      if (!passphrase) return { ok: false, error: 'passphrase required' }
      const ok = twoPersonService.verifyPassphrase(passphrase)
      if (!ok) return { ok: false, error: 'invalid passphrase' }
    }
    twoPersonService.disable()
    return { ok: true }
  })
  ipcMain.handle('twoperson:require', (_e, args: { action: string; artifact_type?: string; artifact_id?: string; classification: string }) =>
    twoPersonService.requireApproval(args)
  )
  ipcMain.handle('twoperson:approve', (_e, args: { request_id: string; passphrase: string }) =>
    twoPersonService.approve(args.request_id, args.passphrase)
  )
  ipcMain.handle('twoperson:reject', (_e, args: { request_id: string; reason: string }) => {
    twoPersonService.reject(args.request_id, args.reason); return { ok: true }
  })
  ipcMain.handle('twoperson:pending', () => twoPersonService.pending())
  ipcMain.handle('twoperson:history', (_e, args?: { limit?: number }) => twoPersonService.history(args?.limit ?? 50))

  log.info('wargame + two-person bridge registered')
}
