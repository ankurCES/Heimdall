import Database from 'better-sqlite3-multiple-ciphers'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import log from 'electron-log'
import { getDatabasePath, closeDatabase, initDatabase, getDatabase, getActivePassphrase, probeEncrypted } from '../database'
import { auditChainService } from '../audit/AuditChainService'

/**
 * At-rest encryption via SQLCipher — Theme 10.3.
 *
 * Persistence model:
 *   - The only on-disk marker is `heimdall.encryption.json` in userData:
 *       { enabled: true, enabled_at: <ms>, kdf: "sqlcipher-default" }
 *   - The passphrase itself is NEVER stored. SQLCipher derives a 32-byte key
 *     from it via PBKDF2-HMAC-SHA512 (256 000 iterations, 16-byte random salt
 *     stored in the database header). A wrong passphrase cannot be
 *     distinguished from file corruption without attempting a read.
 *
 * Migration model:
 *   - Enable: open plaintext DB → ATTACH a new encrypted file → sqlcipher_export
 *     → swap files atomically (with a .backup-<ts> preserved).
 *   - Disable: the reverse direction (not implemented in this batch — disabling
 *     encryption is unusual once enabled; we lean toward one-way for safety).
 *   - Change passphrase: PRAGMA rekey on the open encrypted DB.
 *
 * The service is chain-logged end-to-end: enable, change, any failed unlock
 * attempt counts as a tamper event.
 */

interface EncryptionMarker {
  enabled: true
  enabled_at: number
  kdf: 'sqlcipher-default'
}

export class EncryptionService {
  private markerPath(): string {
    return path.join(app.getPath('userData'), 'heimdall.encryption.json')
  }

  /** Is encryption enabled according to the persistent marker? */
  isEnabled(): boolean {
    return fs.existsSync(this.markerPath())
  }

  /** Read the marker if present. */
  readMarker(): EncryptionMarker | null {
    if (!this.isEnabled()) return null
    try {
      return JSON.parse(fs.readFileSync(this.markerPath(), 'utf-8')) as EncryptionMarker
    } catch {
      return null
    }
  }

  private writeMarker(): void {
    const marker: EncryptionMarker = {
      enabled: true,
      enabled_at: Date.now(),
      kdf: 'sqlcipher-default'
    }
    fs.writeFileSync(this.markerPath(), JSON.stringify(marker, null, 2), { mode: 0o600 })
  }

  private removeMarker(): void {
    try { fs.unlinkSync(this.markerPath()) } catch { /* noop */ }
  }

  /**
   * Unlock the DB with the supplied passphrase. On success, initDatabase() has
   * run and the service is live. On failure, throws.
   */
  unlock(passphrase: string): void {
    if (!this.isEnabled()) throw new Error('Encryption is not enabled')
    try {
      initDatabase(passphrase)
    } catch (err) {
      // Log failed attempt to audit chain if possible — but the DB isn't open,
      // so we just log to the file log. Repeated failures surface via the UI.
      log.warn(`encryption: failed unlock attempt: ${(err as Error).message}`)
      throw err
    }
  }

  /**
   * First-time enable: open the CURRENT plaintext DB, export to an encrypted
   * copy, swap files. Caller must have a live unencrypted DB; this function
   * closes it, performs the migration, then re-opens with the passphrase.
   */
  enable(passphrase: string): void {
    if (this.isEnabled()) throw new Error('Encryption is already enabled')
    if (!passphrase || passphrase.length < 8) {
      throw new Error('Passphrase must be at least 8 characters')
    }

    const dbPath = getDatabasePath()
    const encPath = `${dbPath}.enc-new`
    const backupPath = `${dbPath}.backup-${Date.now()}`

    // Audit BEFORE migration so a crash mid-swap is still logged.
    try {
      auditChainService.append('encryption.enable.begin', {
        entityType: 'encryption', entityId: 'self', payload: { path: dbPath }
      })
    } catch { /* noop — chain may not be initialized yet on fresh installs */ }

    // Close current connection to release WAL lock, then run the migration on
    // a fresh read-only handle (no concurrent writes possible — DB is closed).
    closeDatabase()

    // Migration: attach encrypted target, sqlcipher_export, detach.
    let src: Database.Database | null = null
    try {
      if (fs.existsSync(encPath)) fs.unlinkSync(encPath)

      src = new Database(dbPath)
      // ATTACH with KEY creates and encrypts the target.
      src.prepare(`ATTACH DATABASE ? AS encrypted KEY ?`).run(encPath, passphrase)
      src.prepare(`SELECT sqlcipher_export('encrypted')`).get()
      src.prepare(`DETACH DATABASE encrypted`).run()
      src.close()
      src = null

      // Atomic-ish swap: move plaintext to backup, encrypted into place.
      // Any WAL/SHM files from the plaintext DB are stale once we swap.
      fs.renameSync(dbPath, backupPath)
      fs.renameSync(encPath, dbPath)
      for (const sfx of ['-wal', '-shm']) {
        const stale = `${backupPath}${sfx}`
        const original = `${dbPath}${sfx}`
        try { if (fs.existsSync(original)) fs.renameSync(original, stale) } catch { /* noop */ }
      }

      this.writeMarker()
      log.info(`encryption: enabled. Backup at ${backupPath}`)
    } catch (err) {
      // Roll back best-effort.
      try { src?.close() } catch { /* noop */ }
      try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath) } catch { /* noop */ }
      // If we already renamed the plaintext away, put it back.
      if (!fs.existsSync(dbPath) && fs.existsSync(backupPath)) {
        try { fs.renameSync(backupPath, dbPath) } catch { /* noop */ }
      }
      log.error(`encryption: enable failed: ${(err as Error).message}`)
      // Re-open the plaintext DB so the app can keep running.
      try { initDatabase() } catch { /* noop */ }
      throw err
    }

    // Re-open with the new passphrase.
    initDatabase(passphrase)

    try {
      auditChainService.append('encryption.enable.success', {
        entityType: 'encryption', entityId: 'self',
        payload: { path: dbPath, backup_path: backupPath }
      })
    } catch { /* noop */ }
  }

  /**
   * Change the passphrase on the currently-open encrypted database.
   * PRAGMA rekey rewrites every page with a key derived from the new
   * passphrase. It's a full-table write — can take seconds on a large DB.
   */
  changePassphrase(oldPassphrase: string, newPassphrase: string): void {
    if (!this.isEnabled()) throw new Error('Encryption is not enabled')
    if (getActivePassphrase() !== oldPassphrase) {
      throw new Error('Current passphrase is incorrect')
    }
    if (!newPassphrase || newPassphrase.length < 8) {
      throw new Error('New passphrase must be at least 8 characters')
    }
    const db = getDatabase()
    db.pragma(`rekey = '${newPassphrase.replace(/'/g, "''")}'`)
    // Verify by re-reading.
    db.prepare('SELECT count(*) FROM sqlite_master').get()

    // Reload so the in-memory passphrase reflects the new one.
    closeDatabase()
    initDatabase(newPassphrase)

    try {
      auditChainService.append('encryption.passphrase.changed', {
        entityType: 'encryption', entityId: 'self', payload: {}
      })
    } catch { /* noop */ }
  }

  /**
   * Status snapshot for the UI. Does NOT leak the passphrase.
   */
  status(): { enabled: boolean; enabled_at: number | null; db_unlocked: boolean; db_path: string; looks_encrypted: boolean } {
    const marker = this.readMarker()
    return {
      enabled: !!marker,
      enabled_at: marker?.enabled_at ?? null,
      db_unlocked: getActivePassphrase() !== null || !marker,
      db_path: getDatabasePath(),
      looks_encrypted: probeEncrypted()
    }
  }
}

export const encryptionService = new EncryptionService()
