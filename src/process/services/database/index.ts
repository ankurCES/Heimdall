import Database from 'better-sqlite3-multiple-ciphers'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import log from 'electron-log'
import { createSchema } from './schema'
import { runMigrations } from './migrations'

let db: Database.Database | null = null
let dbPassphrase: string | null = null

export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'heimdall.db')
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function isDatabaseReady(): boolean {
  return db !== null
}

/**
 * Initialise (or re-initialise) the SQLite connection.
 *
 * If `passphrase` is provided, the DB is opened with SQLCipher encryption.
 * The passphrase is pushed through SQLCipher's default KDF (PBKDF2-HMAC-SHA512,
 * 256 000 iterations, 16-byte salt from the file header). A wrong passphrase
 * surfaces as a "file is not a database" error on the first real query.
 */
export function initDatabase(passphrase?: string): Database.Database {
  const dbPath = getDatabasePath()
  log.info(`Initializing database at: ${dbPath}${passphrase ? ' (encrypted)' : ''}`)

  db = new Database(dbPath)

  if (passphrase) {
    // SQLCipher: set key BEFORE any other PRAGMA / query.
    db.pragma(`key = '${passphrase.replace(/'/g, "''")}'`)
    // Probe: a wrong key makes this throw.
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get()
    } catch (err) {
      try { db.close() } catch { /* noop */ }
      db = null
      throw new Error(`Failed to unlock encrypted database: ${(err as Error).message}`)
    }
    dbPassphrase = passphrase
  }

  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 1000')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  createSchema(db)
  runMigrations(db)

  log.info('Database initialized successfully')
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    dbPassphrase = null
    log.info('Database closed')
  }
}

export function getActivePassphrase(): string | null {
  return dbPassphrase
}

/**
 * Is the file on disk encrypted? Heuristic: open it WITHOUT a key and try to
 * read sqlite_master. If that works it's plaintext; if SQLCipher rejects it
 * the file is encrypted (or corrupt — the caller should verify the marker).
 */
export function probeEncrypted(): boolean {
  const dbPath = getDatabasePath()
  if (!fs.existsSync(dbPath)) return false
  let probe: Database.Database | null = null
  try {
    probe = new Database(dbPath, { readonly: true })
    probe.prepare('SELECT count(*) FROM sqlite_master').get()
    return false
  } catch {
    return true
  } finally {
    try { probe?.close() } catch { /* noop */ }
  }
}
