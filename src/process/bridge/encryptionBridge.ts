import { ipcMain, app } from 'electron'
import log from 'electron-log'
import { encryptionService } from '../services/security/EncryptionService'

/**
 * IPC surface for at-rest encryption (Theme 10.3).
 *
 * Channels:
 *   encryption:status           → { enabled, enabled_at, db_unlocked, ... }
 *   encryption:unlock           (passphrase)       → { ok: true } | throws
 *   encryption:enable           (passphrase)       → { ok: true }
 *   encryption:change           (old, new)         → { ok: true }
 *
 * `encryption:unlock` is the ONLY channel that is registered BEFORE the
 * full bridge set — the main process defers registering everything else
 * until the DB is unlocked. (See process/index.ts.)
 */

export function registerEncryptionBridge(): void {
  ipcMain.handle('encryption:status', () => {
    return encryptionService.status()
  })

  ipcMain.handle('encryption:unlock', async (_evt, passphrase: string) => {
    await encryptionService.unlock(passphrase)
    return { ok: true }
  })

  ipcMain.handle('encryption:enable', (_evt, passphrase: string) => {
    encryptionService.enable(passphrase)
    return { ok: true }
  })

  ipcMain.handle('encryption:change', (_evt, args: { old: string; next: string }) => {
    encryptionService.changePassphrase(args.old, args.next)
    return { ok: true }
  })

  // A deliberate no-op channel the renderer can call after successful unlock
  // to request the main process to finish deferred init and reload the window.
  ipcMain.handle('encryption:finish_boot', () => {
    // Main process watches for this via a separate mechanism; here we just
    // acknowledge — the boot continuation lives in process/index.ts.
    app.emit('heimdall-unlocked')
    return { ok: true }
  })

  log.info('encryption bridge registered')
}
