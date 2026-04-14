import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import log from 'electron-log'
import { createSchema } from './schema'
import { runMigrations } from './migrations'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function initDatabase(): Database.Database {
  const dbPath = path.join(app.getPath('userData'), 'heimdall.db')
  log.info(`Initializing database at: ${dbPath}`)

  db = new Database(dbPath)

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
    log.info('Database closed')
  }
}
