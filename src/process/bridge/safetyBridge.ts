import { ipcMain } from 'electron'
import log from 'electron-log'
import { safeFetcher } from '../collectors/SafeFetcher'
import { panicWipeService } from '../services/security/PanicWipeService'
import { settingsService } from '../services/settings/SettingsService'
import type { SafetyConfig } from '@common/types/settings'

/**
 * Theme 10.6 + 10.7 — air-gap status and panic-wipe IPC.
 */
export function registerSafetyBridge(): void {
  ipcMain.handle('safety:airgap_status', () => {
    const safety = settingsService.get<SafetyConfig>('safety')
    return {
      enabled: safeFetcher.isAirGapped(),
      allowlist: safety?.airGapAllowlist ?? []
    }
  })

  ipcMain.handle('safety:apply_airgap', (_evt, args: { enabled: boolean; allowlist: string[] }) => {
    safeFetcher.setAirGap(!!args.enabled, args.allowlist ?? [])
    return { ok: true }
  })

  ipcMain.handle('safety:panic_wipe_targets', () => panicWipeService.listPlannedTargets())

  ipcMain.handle('safety:panic_wipe', async (_evt, args: { confirmation: string }) => {
    return await panicWipeService.wipe(args.confirmation)
  })

  log.info('safety bridge registered')
}
