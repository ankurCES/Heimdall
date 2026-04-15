import type Database from 'better-sqlite3'
import { app } from 'electron'
import { copyFileSync, existsSync } from 'fs'
import path from 'path'
import { timestamp } from '@common/utils/id'
import { PRESET_REPORTS } from '@common/analytics/presets'
import log from 'electron-log'

interface Migration {
  version: string
  name: string
  up: (db: Database.Database) => void
}

const migrations: Migration[] = [
  {
    version: '001',
    name: 'baseline_schema_tracking',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: '002',
    name: 'graph_sync_tracking',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_sync_log (
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (table_name, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_graph_sync_table ON graph_sync_log(table_name);
      `)
    }
  },
  {
    version: '003',
    name: 'kuzu_metadata',
    up: (db) => {
      const now = timestamp()
      db.prepare(
        'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      ).run('graphSync.lastSynced', '0', now)
      db.prepare(
        'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      ).run('graphSync.enabled', 'true', now)
    }
  },
  {
    version: '004',
    name: 'market_quotes_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_quotes (
          id TEXT PRIMARY KEY,
          ticker TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          price REAL NOT NULL,
          change_pct REAL NOT NULL,
          change_abs REAL,
          prev_close REAL,
          currency TEXT,
          recorded_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_market_quotes_ticker ON market_quotes(ticker, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_market_quotes_recorded ON market_quotes(recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_market_quotes_category ON market_quotes(category);
      `)
    }
  },
  {
    version: '005',
    name: 'fix_apikey_placeholders_in_source_configs',
    up: (db) => {
      // Migrate existing source configs that still have placeholder API key strings
      // (YOUR_KEY_ID, YOUR_SECRET, YOUR_API_KEY_HERE) to use settings:apikeys.X refs.
      // This applies to any source created before the settings-resolver feature shipped.
      const sources = db.prepare(
        "SELECT id, name, config FROM sources WHERE config LIKE '%YOUR_KEY_ID%' OR config LIKE '%YOUR_SECRET%' OR config LIKE '%YOUR_API_KEY_HERE%'"
      ).all() as Array<{ id: string; name: string; config: string }>

      let migrated = 0
      for (const src of sources) {
        try {
          const cfg = JSON.parse(src.config)
          if (!cfg.headers || typeof cfg.headers !== 'object') continue

          let modified = false
          for (const [hName, hValue] of Object.entries(cfg.headers as Record<string, string>)) {
            if (hValue === 'YOUR_KEY_ID') {
              cfg.headers[hName] = 'settings:apikeys.alpaca_key_id'
              modified = true
            } else if (hValue === 'YOUR_SECRET') {
              cfg.headers[hName] = 'settings:apikeys.alpaca_secret'
              modified = true
            } else if (hValue === 'YOUR_API_KEY_HERE') {
              cfg.headers[hName] = 'settings:apikeys.otx'
              modified = true
            }
          }
          if (modified) {
            db.prepare('UPDATE sources SET config = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(cfg), timestamp(), src.id)
            migrated++
          }
        } catch {}
      }
      log.info(`Migration 005: updated ${migrated} source configs to use settings:apikeys refs`)
    }
  },
  {
    version: '006',
    name: 'alpaca_dedicated_collector_types',
    up: (db) => {
      // Convert existing Alpaca sources from generic 'api-endpoint' to dedicated
      // 'alpaca-stock' / 'alpaca-crypto' collector types so symbols can be parsed
      // from JSON object keys (which generic ApiEndpointCollector can't do).
      const stockSrc = db.prepare(
        "SELECT id, config FROM sources WHERE name LIKE '%Alpaca: Stock%' AND type = 'api-endpoint'"
      ).get() as { id: string; config: string } | undefined
      if (stockSrc) {
        const newConfig = JSON.stringify({ symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'SPY', 'QQQ'] })
        db.prepare('UPDATE sources SET type = ?, config = ?, updated_at = ? WHERE id = ?')
          .run('alpaca-stock', newConfig, timestamp(), stockSrc.id)
      }

      const cryptoSrc = db.prepare(
        "SELECT id, config FROM sources WHERE name LIKE '%Alpaca: Crypto%' AND type = 'api-endpoint'"
      ).get() as { id: string; config: string } | undefined
      if (cryptoSrc) {
        const newConfig = JSON.stringify({ symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'] })
        db.prepare('UPDATE sources SET type = ?, config = ?, updated_at = ? WHERE id = ?')
          .run('alpaca-crypto', newConfig, timestamp(), cryptoSrc.id)
      }

      const updated = (stockSrc ? 1 : 0) + (cryptoSrc ? 1 : 0)
      log.info(`Migration 006: converted ${updated} Alpaca sources to dedicated collector types`)
    }
  },
  {
    version: '007',
    name: 'analytics_reports',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analytics_reports (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          icon TEXT,
          layout TEXT NOT NULL,
          widgets TEXT NOT NULL,
          global_filters TEXT,
          is_preset INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_reports_updated ON analytics_reports(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_analytics_reports_preset ON analytics_reports(is_preset);
      `)

      const now = timestamp()
      const insert = db.prepare(`
        INSERT OR IGNORE INTO analytics_reports
          (id, name, description, icon, layout, widgets, global_filters, is_preset, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `)
      let seeded = 0
      for (const preset of PRESET_REPORTS) {
        const result = insert.run(
          preset.id,
          preset.name,
          preset.description || null,
          preset.icon || null,
          JSON.stringify(preset.layout),
          JSON.stringify(preset.widgets),
          JSON.stringify(preset.globalFilters || {}),
          now,
          now
        )
        if (result.changes > 0) seeded++
      }
      log.info(`Migration 007: analytics_reports table created, seeded ${seeded} preset(s)`)
    }
  }
]

function backupDatabase(dbPath: string, version: string): void {
  const backupPath = `${dbPath}.bak-v${version}`
  if (!existsSync(backupPath)) {
    try {
      copyFileSync(dbPath, backupPath)
      log.info(`Database backup created: ${backupPath}`)
    } catch (err) {
      log.warn(`Failed to create DB backup: ${err}`)
    }
  }
}

export function runMigrations(db: Database.Database): void {
  // Ensure schema_migrations table exists (migration 001 bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>)
      .map((r) => r.version)
  )

  const pending = migrations.filter((m) => !applied.has(m.version))

  if (pending.length === 0) {
    log.debug('No pending database migrations')
    return
  }

  log.info(`Running ${pending.length} database migration(s)...`)

  // Backup before first pending migration
  const dbPath = path.join(app.getPath('userData'), 'heimdall.db')
  backupDatabase(dbPath, pending[0].version)

  for (const migration of pending) {
    log.info(`Applying migration ${migration.version}: ${migration.name}`)
    const now = timestamp()

    const runMigration = db.transaction(() => {
      migration.up(db)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, now)
    })

    try {
      runMigration()
      log.info(`Migration ${migration.version} applied successfully`)
    } catch (err) {
      log.error(`Migration ${migration.version} failed: ${err}`)
      throw err // Stop on failure — the transaction will roll back
    }
  }

  log.info('All migrations applied')
}
