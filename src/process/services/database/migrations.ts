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
  },
  {
    version: '008',
    name: 'consolidate_humint_per_session',
    up: (db) => {
      // Enforce the invariant that each chat session has at most one HUMINT
      // report. Before this migration, repeated "Record HUMINT" clicks on the
      // same session created duplicate humint_reports + intel_reports rows with
      // duplicate graph edges. Consolidate those duplicates into the oldest
      // (canonical) row per session so graph nodes stay stable.
      const dupGroups = db.prepare(`
        SELECT session_id, COUNT(*) AS c
        FROM humint_reports
        WHERE session_id IS NOT NULL AND session_id != ''
        GROUP BY session_id
        HAVING c > 1
      `).all() as Array<{ session_id: string; c: number }>

      let consolidated = 0
      let rowsMerged = 0

      for (const group of dupGroups) {
        const rows = db.prepare(
          'SELECT id, analyst_notes, findings, source_report_ids, tool_calls_used, created_at, updated_at FROM humint_reports WHERE session_id = ? ORDER BY created_at ASC'
        ).all(group.session_id) as Array<{
          id: string; analyst_notes: string; findings: string;
          source_report_ids: string | null; tool_calls_used: string | null;
          created_at: number; updated_at: number
        }>

        if (rows.length < 2) continue
        const canonical = rows[0]
        const duplicates = rows.slice(1)

        // Merge source_report_ids + tool_calls_used from all rows (deduped)
        const mergedSourceIds = new Set<string>()
        const mergedTools = new Set<string>()
        for (const r of rows) {
          try {
            for (const s of JSON.parse(r.source_report_ids || '[]')) mergedSourceIds.add(s)
            for (const t of JSON.parse(r.tool_calls_used || '[]')) mergedTools.add(t)
          } catch {}
        }

        // Use the latest analyst_notes + findings (most recent row) as canonical content
        const latest = rows[rows.length - 1]
        const latestUpdatedAt = Math.max(...rows.map((r) => r.updated_at || r.created_at))

        db.prepare(`
          UPDATE humint_reports
          SET analyst_notes = ?, findings = ?,
              source_report_ids = ?, tool_calls_used = ?, updated_at = ?
          WHERE id = ?
        `).run(
          latest.analyst_notes,
          latest.findings,
          JSON.stringify(Array.from(mergedSourceIds)),
          JSON.stringify(Array.from(mergedTools)),
          latestUpdatedAt,
          canonical.id
        )

        // Redirect intel_links from each duplicate → canonical
        for (const dup of duplicates) {
          // Links where the duplicate is the source → re-point to canonical
          db.prepare(
            'UPDATE OR IGNORE intel_links SET source_report_id = ? WHERE source_report_id = ?'
          ).run(canonical.id, dup.id)
          // Links where the duplicate is the target → re-point to canonical
          db.prepare(
            'UPDATE OR IGNORE intel_links SET target_report_id = ? WHERE target_report_id = ?'
          ).run(canonical.id, dup.id)
          // Clean up any that became self-links after re-point
          db.prepare(
            'DELETE FROM intel_links WHERE source_report_id = target_report_id'
          ).run()
          // Clean up any residual rows that violated UPDATE OR IGNORE's uniqueness
          db.prepare('DELETE FROM intel_links WHERE source_report_id = ? OR target_report_id = ?').run(dup.id, dup.id)

          // Move tags from duplicate → canonical (INSERT OR IGNORE dedupes)
          db.prepare(
            'UPDATE OR IGNORE intel_tags SET report_id = ? WHERE report_id = ?'
          ).run(canonical.id, dup.id)
          db.prepare('DELETE FROM intel_tags WHERE report_id = ?').run(dup.id)

          // Move entities from duplicate → canonical
          db.prepare(
            'UPDATE OR IGNORE intel_entities SET report_id = ? WHERE report_id = ?'
          ).run(canonical.id, dup.id)
          db.prepare('DELETE FROM intel_entities WHERE report_id = ?').run(dup.id)

          // Delete duplicate intel_report (mirror row created by HumintService)
          db.prepare('DELETE FROM intel_reports WHERE id = ?').run(dup.id)
          // Delete duplicate humint_report
          db.prepare('DELETE FROM humint_reports WHERE id = ?').run(dup.id)

          rowsMerged++
        }
        consolidated++
      }

      log.info(`Migration 008: consolidated ${rowsMerged} duplicate HUMINT reports across ${consolidated} sessions`)
    }
  },
  {
    version: '009',
    name: 'backfill_preliminary_source_links',
    up: (db) => {
      // Earlier versions of chatBridge.ts used a truncated UUID regex
      // (matched only the first 16 chars of a UUID) and capped source links
      // at 10 per preliminary report. The net effect: preliminary_reports
      // rows had `source_report_ids` JSON filled with garbage fragments, and
      // the preliminary→intel edges in intel_links pointed at ids that do
      // not exist in intel_reports.
      //
      // This migration re-scans the chat_messages that produced each
      // preliminary report, extracts FULL UUIDs, verifies each against the
      // live intel_reports set, and:
      //   1. Rewrites preliminary_reports.source_report_ids with the
      //      verified id list.
      //   2. Inserts preliminary_reference intel_links for every verified
      //      citation that is not already linked.
      const FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

      const prelims = db.prepare(
        'SELECT id, session_id FROM preliminary_reports WHERE session_id IS NOT NULL AND session_id != \'\''
      ).all() as Array<{ id: string; session_id: string }>

      let rewrittenReports = 0
      let linksAdded = 0

      for (const prelim of prelims) {
        const candidates = new Set<string>()

        // Pull all assistant messages for the session — the old regex ran
        // against these already, but missed full UUIDs; new regex fixes that.
        const msgs = db.prepare(
          "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at"
        ).all(prelim.session_id) as Array<{ content: string }>
        for (const m of msgs) {
          const matches = m.content.match(FULL_UUID_RE) || []
          for (const uuid of matches) candidates.add(uuid)
        }

        // Also scan tool_call_logs — the agent's search tool results now
        // include [id:<uuid>] markers, but even older rows occasionally
        // contain stringified JSON with full UUIDs. This is a lossy signal
        // for sessions predating the tool-output fix, but it catches any
        // report ids that happened to appear in tool result text.
        try {
          const logs = db.prepare(
            "SELECT result FROM tool_call_logs WHERE session_id = ? AND tool_name IN ('vector_search', 'intel_search', 'entity_lookup', 'graph_query') AND result IS NOT NULL"
          ).all(prelim.session_id) as Array<{ result: string }>
          for (const l of logs) {
            const matches = (l.result || '').match(FULL_UUID_RE) || []
            for (const uuid of matches) candidates.add(uuid)
          }
        } catch {}

        if (candidates.size === 0) continue

        // Verify each candidate exists in intel_reports
        const ids = Array.from(candidates)
        const verified = (db.prepare(
          `SELECT id FROM intel_reports WHERE id IN (${ids.map(() => '?').join(',')})`
        ).all(...ids) as Array<{ id: string }>).map((r) => r.id)
        if (verified.length === 0) continue

        // Overwrite the stored source_report_ids JSON with the verified set
        db.prepare('UPDATE preliminary_reports SET source_report_ids = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(verified.slice(0, 200)), timestamp(), prelim.id)
        rewrittenReports++

        // Insert preliminary_reference links that aren't already present
        for (const srcId of verified.slice(0, 200)) {
          const existing = db.prepare(
            'SELECT 1 FROM intel_links WHERE source_report_id = ? AND target_report_id = ? AND link_type = ?'
          ).get(prelim.id, srcId, 'preliminary_reference')
          if (existing) continue
          db.prepare(
            "INSERT INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).run(
            `mig9_${prelim.id.slice(0, 8)}_${srcId.slice(0, 8)}_${linksAdded}`,
            prelim.id, srcId, 'preliminary_reference', 0.8,
            'Backfilled: source intel for preliminary report',
            timestamp()
          )
          linksAdded++
        }
      }

      log.info(`Migration 009: rewrote source_report_ids on ${rewrittenReports} preliminary reports, added ${linksAdded} preliminary→intel links`)
    }
  },
  {
    version: '010',
    name: 'backfill_preliminary_source_links_from_tool_logs',
    up: (db) => {
      // Migration 009 scanned only chat_messages for UUIDs, but the LLM
      // typically cites intel by name, not by id, so its responses rarely
      // contain full UUIDs. The authoritative source of which intel was
      // surfaced to the LLM is tool_call_logs — vector_search / intel_search
      // / entity_lookup results list the reports that matched the query.
      //
      // This migration re-does the backfill using tool_call_logs as the
      // primary signal, with assistant messages as a fallback.
      const FULL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

      const prelims = db.prepare(
        'SELECT id, session_id FROM preliminary_reports WHERE session_id IS NOT NULL AND session_id != \'\''
      ).all() as Array<{ id: string; session_id: string }>

      let rewrittenReports = 0
      let linksAdded = 0

      for (const prelim of prelims) {
        const candidates = new Set<string>()

        // Primary: tool_call_logs for the session
        try {
          const logs = db.prepare(
            "SELECT result FROM tool_call_logs WHERE session_id = ? AND tool_name IN ('vector_search', 'intel_search', 'entity_lookup', 'graph_query') AND result IS NOT NULL"
          ).all(prelim.session_id) as Array<{ result: string }>
          for (const l of logs) {
            const matches = (l.result || '').match(FULL_UUID_RE) || []
            for (const uuid of matches) candidates.add(uuid)
          }
        } catch {}

        // Secondary: assistant messages
        const msgs = db.prepare(
          "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at"
        ).all(prelim.session_id) as Array<{ content: string }>
        for (const m of msgs) {
          const matches = m.content.match(FULL_UUID_RE) || []
          for (const uuid of matches) candidates.add(uuid)
        }

        if (candidates.size === 0) continue

        // Verify against intel_reports
        const ids = Array.from(candidates)
        const verified = (db.prepare(
          `SELECT id FROM intel_reports WHERE id IN (${ids.map(() => '?').join(',')})`
        ).all(...ids) as Array<{ id: string }>).map((r) => r.id)
        if (verified.length === 0) continue

        // Merge with any ids already in preliminary_reports.source_report_ids
        // so we don't accidentally shrink the list for any report that was
        // already correctly populated.
        let existing: string[] = []
        try {
          const row = db.prepare('SELECT source_report_ids FROM preliminary_reports WHERE id = ?').get(prelim.id) as { source_report_ids: string | null } | undefined
          if (row?.source_report_ids) existing = JSON.parse(row.source_report_ids)
        } catch {}
        const merged = Array.from(new Set([...existing, ...verified])).slice(0, 200)

        db.prepare('UPDATE preliminary_reports SET source_report_ids = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(merged), timestamp(), prelim.id)
        rewrittenReports++

        for (const srcId of merged) {
          const existingLink = db.prepare(
            'SELECT 1 FROM intel_links WHERE source_report_id = ? AND target_report_id = ? AND link_type = ?'
          ).get(prelim.id, srcId, 'preliminary_reference')
          if (existingLink) continue
          db.prepare(
            'INSERT INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            `mig10_${prelim.id.slice(0, 8)}_${srcId.slice(0, 8)}_${linksAdded}`,
            prelim.id, srcId, 'preliminary_reference', 0.8,
            'Backfilled: source intel for preliminary report (via tool_call_logs)',
            timestamp()
          )
          linksAdded++
        }
      }

      log.info(`Migration 010: rewrote source_report_ids on ${rewrittenReports} preliminary reports (tool_logs scan), added ${linksAdded} preliminary→intel links`)
    }
  },
  {
    version: '011',
    name: 'sync_preliminary_source_ids_to_intel_links',
    up: (db) => {
      // Several existing preliminary_reports have a valid source_report_ids
      // JSON array (20+ ids) but only 10 matching preliminary_reference rows
      // in intel_links — a direct consequence of the old .slice(0, 10) cap
      // in chatBridge.ts. This migration reads source_report_ids for every
      // preliminary report and inserts any missing preliminary_reference
      // links, verifying each target exists in intel_reports so we never
      // write a dangling edge.
      const prelims = db.prepare(
        "SELECT id, source_report_ids FROM preliminary_reports WHERE source_report_ids IS NOT NULL AND source_report_ids != '[]'"
      ).all() as Array<{ id: string; source_report_ids: string }>

      const insertStmt = db.prepare(
        "INSERT INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      const existsLinkStmt = db.prepare(
        'SELECT 1 FROM intel_links WHERE source_report_id = ? AND target_report_id = ? AND link_type = ?'
      )

      let touched = 0
      let added = 0
      for (const prelim of prelims) {
        let ids: string[] = []
        try { ids = JSON.parse(prelim.source_report_ids || '[]') } catch {}
        if (ids.length === 0) continue

        // Verify each target exists in intel_reports
        const placeholders = ids.map(() => '?').join(',')
        const verified = (db.prepare(
          `SELECT id FROM intel_reports WHERE id IN (${placeholders})`
        ).all(...ids) as Array<{ id: string }>).map((r) => r.id)
        if (verified.length === 0) continue

        let addedForThis = 0
        for (const srcId of verified) {
          if (existsLinkStmt.get(prelim.id, srcId, 'preliminary_reference')) continue
          insertStmt.run(
            `mig11_${prelim.id.slice(0, 8)}_${srcId.slice(0, 8)}_${added}`,
            prelim.id, srcId, 'preliminary_reference', 0.8,
            'Backfilled from source_report_ids column',
            timestamp()
          )
          added++
          addedForThis++
        }
        if (addedForThis > 0) touched++
      }
      log.info(`Migration 011: added ${added} missing preliminary→intel links across ${touched} preliminary reports`)
    }
  },
  {
    version: '012',
    name: 'remove_kuzu_remnants',
    up: (db) => {
      // Kuzu graph DB removed in v0.4. The native module was dormant for the
      // app's entire history (every code path falls back to SQLite) and added
      // ~80 MB of native binaries plus a rebuild step. This migration cleans
      // up the orphan settings rows + the never-populated graph_sync_log
      // table so the schema reflects reality.
      const r1 = db.prepare("DELETE FROM settings WHERE key IN ('graphSync.enabled', 'graphSync.lastSynced')").run()
      const r2 = db.prepare("DROP TABLE IF EXISTS graph_sync_log").run()
      log.info(`Migration 012: removed ${r1.changes} kuzu settings rows; dropped graph_sync_log table (${r2.changes} effect)`)
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
