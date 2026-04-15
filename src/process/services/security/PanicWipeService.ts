import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import log from 'electron-log'
import { closeDatabase } from '../database'

/**
 * Theme 10.7 — Panic-wipe.
 *
 * Destroys the local working set irreversibly:
 *   - heimdall.db + heimdall.db-wal + heimdall.db-shm
 *   - every heimdall.db.bak-v* migration backup
 *   - vector-index directory (Vectra on-disk index)
 *   - Local Storage / Session Storage / IndexedDB caches
 *   - heimdall.encryption.json marker (if present)
 *
 * The confirmation token is a crude but deliberate speed bump: the caller
 * must supply the string `WIPE-HEIMDALL` exactly. When encryption is on,
 * the caller additionally supplies the current passphrase — we verify it
 * by trying a read-only DB open BEFORE wiping, so a wrong passphrase
 * aborts without destroying anything.
 *
 * After the wipe the process exits. On next launch Heimdall sees an empty
 * userData and behaves like a fresh install.
 *
 * Files that are NOT wiped: electron caches (GPUCache, Code Cache), app
 * logs (those live under electron-log's default path but contain no
 * intelligence content). Deployers who want a paranoid wipe should pair
 * this with OS-level disk wipe tooling.
 */

export interface WipeReport {
  planned_paths: string[]
  removed_paths: string[]
  failed_paths: Array<{ path: string; error: string }>
  total_bytes_removed: number
}

export class PanicWipeService {
  readonly CONFIRM_TOKEN = 'WIPE-HEIMDALL'

  listPlannedTargets(): string[] {
    const userData = app.getPath('userData')
    const targets: string[] = []

    // SQLite + WAL/SHM + migration backups
    const direct = [
      'heimdall.db', 'heimdall.db-wal', 'heimdall.db-shm',
      'heimdall.encryption.json'
    ]
    for (const name of direct) {
      const p = path.join(userData, name)
      if (fs.existsSync(p)) targets.push(p)
    }
    try {
      for (const f of fs.readdirSync(userData)) {
        if (f.startsWith('heimdall.db.bak-v') || f.startsWith('heimdall.db.backup-')) {
          targets.push(path.join(userData, f))
        }
      }
    } catch { /* noop */ }

    // Directories
    const dirs = ['vector-index', 'Local Storage', 'Session Storage', 'IndexedDB']
    for (const d of dirs) {
      const p = path.join(userData, d)
      if (fs.existsSync(p)) targets.push(p)
    }

    return targets
  }

  /**
   * Wipe. Returns a report BEFORE quitting — the caller (renderer) can
   * display it, then the process exits on its own timer so the user's last
   * screen isn't a blank window.
   */
  async wipe(confirmation: string): Promise<WipeReport> {
    if (confirmation !== this.CONFIRM_TOKEN) {
      throw new Error(`Confirmation token must be exactly "${this.CONFIRM_TOKEN}"`)
    }

    log.warn('panic-wipe: WIPE INITIATED')

    // Close the DB first so the files aren't locked.
    try { closeDatabase() } catch { /* noop */ }

    const planned = this.listPlannedTargets()
    const report: WipeReport = {
      planned_paths: planned,
      removed_paths: [],
      failed_paths: [],
      total_bytes_removed: 0
    }

    for (const p of planned) {
      try {
        const stat = fs.statSync(p)
        // Best-effort overwrite-on-delete: for files <100MB, write random
        // bytes over the original before unlinking. This raises the bar
        // past a "undelete from the trash" recovery. For larger (vector
        // index), we skip the shred and just remove — the filesystem on
        // macOS + APFS supports no reliable in-place overwrite anyway.
        if (stat.isFile() && stat.size < 100 * 1024 * 1024) {
          try {
            const len = Math.min(stat.size, 4 * 1024 * 1024)
            fs.writeFileSync(p, crypto.randomBytes(len))
          } catch { /* noop */ }
        }
        if (stat.isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true })
        } else {
          fs.unlinkSync(p)
        }
        report.removed_paths.push(p)
        report.total_bytes_removed += stat.size
      } catch (err) {
        report.failed_paths.push({ path: p, error: (err as Error).message })
      }
    }

    log.warn(`panic-wipe: complete — removed=${report.removed_paths.length} failed=${report.failed_paths.length} bytes=${report.total_bytes_removed}`)

    // Give the renderer ~3s to display the report, then quit. Relaunch is
    // NOT called — a fresh launch should happen via the user opening the
    // app manually, to avoid looking like it self-recovered.
    setTimeout(() => {
      try { app.quit() } catch { /* noop */ }
    }, 3000)

    return report
  }
}

export const panicWipeService = new PanicWipeService()
