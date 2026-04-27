import { ipcMain } from 'electron'
import log from 'electron-log'
import { safeFetcher } from '../collectors/SafeFetcher'
import { panicWipeService } from '../services/security/PanicWipeService'
import { twoPersonService } from '../services/security/TwoPersonService'
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

  // SECURITY (v1.3.2): when two-person integrity is enabled, panic-wipe
  // requires an APPROVED approval-request id. The static literal token
  // is preserved for backwards-compatible single-user deployments where
  // two-person isn't configured at all, but agency deployments will have
  // 2P enabled and the literal token alone is insufficient.
  ipcMain.handle('safety:panic_wipe', async (_evt, args: { confirmation: string; approvalRequestId?: string }) => {
    if (twoPersonService.isEnabled()) {
      if (!args?.approvalRequestId) {
        return { ok: false, error: 'two-person approval required for panic wipe' }
      }
      try {
        const verdict = twoPersonService.checkApproved(args.approvalRequestId, 'panic_wipe')
        if (!verdict.ok) return { ok: false, error: verdict.reason || 'approval not granted' }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
    return await panicWipeService.wipe(args.confirmation)
  })

  log.info('safety bridge registered')
}
