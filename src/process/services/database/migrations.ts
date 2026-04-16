import type Database from 'better-sqlite3-multiple-ciphers'
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
  },
  {
    version: '013',
    name: 'admiralty_source_rating_and_credibility',
    up: (db) => {
      // NATO STANAG 2511 / Admiralty Code two-axis intelligence rating.
      //
      //   Source reliability (A–F):
      //     A = Completely reliable    (sole authority, history of total reliability)
      //     B = Usually reliable       (history of mostly correct information)
      //     C = Fairly reliable        (some past success, occasional doubt)
      //     D = Not usually reliable   (mostly invalid in the past)
      //     E = Unreliable             (lack of authenticity / proven invalid)
      //     F = Reliability unknown    (cannot be judged)
      //
      //   Information credibility (1–6):
      //     1 = Confirmed by other independent sources
      //     2 = Probably true (logical, consistent with other intel)
      //     3 = Possibly true (reasonably logical, agrees with some intel)
      //     4 = Doubtfully true (not logical but possible, no other evidence)
      //     5 = Improbable (illogical, contradicted by other intel)
      //     6 = Truth cannot be judged
      //
      // Reports carry a combined rating like "B2" (usually-reliable source,
      // probably-true information). The flat 0–100 verification_score remains
      // for backward compat but is no longer the primary trust signal.

      // Backwards-compat: ALTER TABLE only adds nullable columns; no data loss.
      try { db.exec(`ALTER TABLE sources ADD COLUMN admiralty_reliability TEXT`) } catch {}
      try { db.exec(`ALTER TABLE sources ADD COLUMN admiralty_reliability_set_at INTEGER`) } catch {}
      try { db.exec(`ALTER TABLE intel_reports ADD COLUMN credibility INTEGER`) } catch {}
      try { db.exec(`ALTER TABLE intel_reports ADD COLUMN credibility_computed_at INTEGER`) } catch {}

      // Backfill source reliability from known defaults — start with the
      // most common 50+ seeded sources. Anything else stays NULL (= F,
      // analyst must judge). This list was distilled from the seeded
      // collectors by category — government / wire-service primaries are
      // B, well-known OSINT analysts are C, anonymous tip feeds are E,
      // F is the explicit "unknown" sentinel.
      const RELIABILITY_DEFAULTS: Array<[string, string]> = [
        // A — Completely reliable: official primary records
        ['SEC EDGAR', 'A'],
        ['UN Security Council Sanctions', 'A'],
        ['OFAC Sanctions', 'A'],
        ['NVD CVE', 'A'],
        ['CISA Cybersecurity Advisories', 'A'],
        ['CISA ICS Advisories', 'A'],
        ['Federal Register', 'A'],
        ['USGS Earthquake', 'A'],
        ['NOAA Weather', 'A'],
        ['NASA FIRMS', 'A'],
        ['NASA EONET', 'A'],
        ['GDACS', 'A'],
        ['Interpol', 'A'],
        ['FBI', 'A'],
        ['Europol', 'A'],
        ['UK FCDO', 'A'],
        ['AU DFAT', 'A'],
        // B — Usually reliable: mainstream wire services + reputable specialists
        ['Reuters', 'B'],
        ['BBC', 'B'],
        ['Al Jazeera', 'B'],
        ['NYT', 'B'],
        ['GDELT', 'B'],
        ['Krebs on Security', 'B'],
        ['Mandiant Threat Intelligence', 'B'],
        ['Cisco Talos Intelligence', 'B'],
        ['Google Project Zero', 'B'],
        ['MITRE ATT&CK', 'B'],
        ['Sigma Detection Rules', 'B'],
        ['YARA Rules', 'B'],
        ['UK NCSC Threat Reports', 'B'],
        ['US-CERT', 'B'],
        ['IODA Internet Outage', 'B'],
        ['ADS-B', 'B'],
        ['ISS Tracker', 'B'],
        ['AIS Maritime', 'B'],
        ['Yahoo Finance Commodities', 'B'],
        ['Alpaca', 'B'],
        ['MFAPI', 'B'],
        // C — Fairly reliable: enthusiast / community OSINT
        ['Bellingcat', 'C'],
        ['OSINT Defender', 'C'],
        ['Threat-Intel', 'C'],
        ['Open-Source Threat Intel Feeds', 'C'],
        ['Public Intelligence Feeds', 'C'],
        ['BleepingComputer', 'C'],
        ['Dark Reading', 'C'],
        ['The Hacker News', 'C'],
        ['Polymarket', 'C'],
        // D — Not usually reliable: state-media / known propaganda channels
        // (mark conservatively — analyst must override per-claim)
        // E — Unreliable: explicit rumor mills, anonymous tip feeds
        ['RUMINT', 'E'],
        ['Reddit r/conspiracy', 'E'],
        ['Reddit r/RBI', 'E'],
        // Reddit news-aggregation subs — fairly reliable for what they're aggregating
        ['Reddit r/worldnews', 'C'],
        ['Reddit r/geopolitics', 'C'],
        ['Reddit r/Intelligence', 'C'],
        ['Reddit r/OSINT', 'C']
      ]
      const now = timestamp()
      const upd = db.prepare(
        `UPDATE sources SET admiralty_reliability = ?, admiralty_reliability_set_at = ? WHERE admiralty_reliability IS NULL AND name LIKE ?`
      )
      let rated = 0
      for (const [pattern, rating] of RELIABILITY_DEFAULTS) {
        const r = upd.run(rating, now, `%${pattern}%`)
        rated += r.changes
      }

      // Backfill credibility on intel_reports from existing verification_score
      // as a starting point (analyst can refine via Feed UI). The mapping is
      // deliberately conservative — old scores were noisy, so most reports
      // start at "3 = possibly true" or worse.
      //
      //   verification >= 90  →  2  (probably true)
      //   verification >= 70  →  3  (possibly true)
      //   verification >= 50  →  4  (doubtfully true)
      //   verification < 50   →  5  (improbable)
      const credResult = db.prepare(`
        UPDATE intel_reports
        SET credibility = CASE
          WHEN verification_score >= 90 THEN 2
          WHEN verification_score >= 70 THEN 3
          WHEN verification_score >= 50 THEN 4
          ELSE 5
        END,
        credibility_computed_at = ?
        WHERE credibility IS NULL
      `).run(now)

      log.info(`Migration 013: rated ${rated} sources; backfilled credibility on ${credResult.changes} reports`)
    }
  },
  {
    version: '014',
    name: 'classification_and_audit_chain',
    up: (db) => {
      // ─────────────────────────────────────────────────────────────────────
      //  Classification levels (Theme 10.1)
      // ─────────────────────────────────────────────────────────────────────
      // Every analyst-facing artifact gets a classification level matching
      // the US/NATO scheme: UNCLASSIFIED < CONFIDENTIAL < SECRET < TOP SECRET.
      // The UI gates rendering by the user's clearance setting (single-user
      // for now; multi-user RBAC deferred to Theme 10.10).
      //
      // Every existing row defaults to UNCLASSIFIED so analysts can start
      // overriding upward; nothing existing gets accidentally hidden.
      const tables = [
        'intel_reports',
        'preliminary_reports',
        'humint_reports',
        'recommended_actions',
        'intel_gaps',
        'chat_sessions'
      ]
      for (const tbl of tables) {
        try { db.exec(`ALTER TABLE ${tbl} ADD COLUMN classification TEXT DEFAULT 'UNCLASSIFIED'`) } catch {}
        // Backfill anything that ended up NULL (older rows)
        db.prepare(`UPDATE ${tbl} SET classification = 'UNCLASSIFIED' WHERE classification IS NULL`).run()
      }

      // Default user clearance: UNCLASSIFIED. Settings page lets the analyst
      // bump it; export gates compare doc.classification > user.clearance.
      const now = timestamp()
      db.prepare(
        'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
      ).run('security.clearance', JSON.stringify('UNCLASSIFIED'), now)

      // ─────────────────────────────────────────────────────────────────────
      //  Hash-chained tamper-evident audit log (Theme 10.4)
      // ─────────────────────────────────────────────────────────────────────
      // Each row's hash chains over the previous row's hash. Tampering with
      // any historical row breaks the chain — verify() walks the table and
      // recomputes hashes; first mismatch is the tamper point.
      //
      // sequence is monotonic (no gaps) for cheap chain validation.
      // payload is a JSON blob of any structured details for the action.
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log_chained (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          action TEXT NOT NULL,
          actor TEXT,
          entity_type TEXT,
          entity_id TEXT,
          classification TEXT,
          payload TEXT,
          timestamp INTEGER NOT NULL,
          prev_hash TEXT NOT NULL,
          this_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_chain_seq ON audit_log_chained(sequence);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_entity ON audit_log_chained(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_ts ON audit_log_chained(timestamp DESC);
      `)

      log.info(`Migration 014: classification column added to ${tables.length} tables; audit_log_chained created with hash-chain integrity`)
    }
  },
  {
    version: '015',
    name: 'analyst_council',
    up: (db) => {
      // Multi-Agent Analyst Council (Cross-cutting A in the agency roadmap).
      //
      // Each "run" is a debate triggered by an analyst over a topic + a
      // bundle of source intel. Five specialized agent roles independently
      // reason over the input then a Synthesis agent reconciles.
      //
      //   skeptic         — finds single-source claims, hedge words,
      //                     unsupported assumptions
      //   red_team        — adopts adversary's perspective; argues against
      //                     the analyst's hypothesis on its own terms
      //   counter_intel   — flags coordinated narratives, suspicious
      //                     source overlap, deception heuristics
      //   citation_audit  — verifies every claim back to a primary source;
      //                     flags hallucinated facts
      //   synthesis       — reconciles the four into the analyst-ready
      //                     final assessment + estimative-probability
      //                     judgment in ICD 203 language
      //
      // The full transcript is itself an analytical product — fully
      // auditable, defensible in cross-examination.

      db.exec(`
        CREATE TABLE IF NOT EXISTS analyst_council_runs (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          preliminary_report_id TEXT,
          topic TEXT NOT NULL,
          input_summary TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_council_runs_session ON analyst_council_runs(session_id);
        CREATE INDEX IF NOT EXISTS idx_council_runs_prelim ON analyst_council_runs(preliminary_report_id);
        CREATE INDEX IF NOT EXISTS idx_council_runs_started ON analyst_council_runs(started_at DESC);

        CREATE TABLE IF NOT EXISTS analyst_council_outputs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL,
          conclusion TEXT,
          key_findings TEXT,
          concerns TEXT,
          confidence TEXT,
          citations TEXT,
          model_used TEXT,
          tokens_used INTEGER,
          duration_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES analyst_council_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_council_outputs_run ON analyst_council_outputs(run_id);
        CREATE INDEX IF NOT EXISTS idx_council_outputs_role ON analyst_council_outputs(role);
      `)

      log.info('Migration 015: analyst_council_runs + analyst_council_outputs tables created')
    }
  },
  {
    version: '016',
    name: 'iw_workbench_and_dpb',
    up: (db) => {
      // Indicators & Warnings (I&W) — Themes 5.1, 5.2 of the agency roadmap.
      //
      // An "event" is a high-impact scenario the analyst is watching for
      // ("conflict in Taiwan Strait", "ransomware spillover into utilities").
      // Each event has a set of indicators — observable preconditions the
      // analyst can measure. Each indicator has a query (currently
      // intel_count over keywords/discipline/severity) and Red/Amber/Green
      // thresholds. The dashboard surfaces R/A/G state per indicator and
      // an aggregate state per event.
      //
      // iw_evaluations is the time-series history — each evaluation appends
      // a row so the analyst can see how the indicator has trended over
      // days/weeks (Theme 5.3 anomaly detection will consume this later).
      db.exec(`
        CREATE TABLE IF NOT EXISTS iw_events (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          scenario_class TEXT,
          classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_iw_events_status ON iw_events(status);

        CREATE TABLE IF NOT EXISTS iw_indicators (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          query_type TEXT NOT NULL,
          query_params TEXT NOT NULL,
          red_threshold REAL,
          amber_threshold REAL,
          weight REAL NOT NULL DEFAULT 1.0,
          current_value REAL,
          current_level TEXT,
          last_evaluated_at INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (event_id) REFERENCES iw_events(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_iw_indicators_event ON iw_indicators(event_id);
        CREATE INDEX IF NOT EXISTS idx_iw_indicators_status ON iw_indicators(status);

        CREATE TABLE IF NOT EXISTS iw_evaluations (
          id TEXT PRIMARY KEY,
          indicator_id TEXT NOT NULL,
          value REAL NOT NULL,
          level TEXT NOT NULL,
          source_count INTEGER,
          evaluated_at INTEGER NOT NULL,
          FOREIGN KEY (indicator_id) REFERENCES iw_indicators(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_iw_evaluations_indicator ON iw_evaluations(indicator_id, evaluated_at DESC);
      `)

      // Daily President's Brief (Theme 9.1) — assembled snapshots of the
      // operational picture. Each brief carries its classification and an
      // optional template_name for agencies with house formats. The
      // body_md is the rendered briefing markdown; structured data is in
      // body_json so the renderer / exporter can re-render in PDF / DOCX
      // / NATO INTREP later (Theme 9.4).
      db.exec(`
        CREATE TABLE IF NOT EXISTS dpb_briefings (
          id TEXT PRIMARY KEY,
          generated_at INTEGER NOT NULL,
          classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
          template_name TEXT,
          period_hours INTEGER NOT NULL DEFAULT 24,
          body_md TEXT NOT NULL,
          body_json TEXT,
          intel_count INTEGER,
          critical_count INTEGER,
          humint_count INTEGER,
          iw_red_count INTEGER,
          iw_amber_count INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dpb_generated ON dpb_briefings(generated_at DESC);
      `)

      log.info('Migration 016: iw_events / iw_indicators / iw_evaluations + dpb_briefings tables created')
    }
  },
  {
    version: '017',
    name: 'ach_workbench',
    up: (db) => {
      // Analysis of Competing Hypotheses (ACH) — Themes 2.1, 2.2, 2.3, 2.4, 2.6
      // of the agency roadmap.
      //
      // Heuer's gold-standard methodology for analytic rigor:
      //   1. Define 3–5 mutually-exclusive hypotheses
      //   2. List every relevant piece of evidence
      //   3. Score each piece against each hypothesis:
      //        CC = strongly consistent (++) , C = consistent (+),
      //        N  = not applicable / neutral, I = inconsistent (-),
      //        II = strongly inconsistent (--)
      //   4. Pick the hypothesis with the LEAST disconfirming evidence
      //      (NOT the most confirming) — the "Heuer principle"
      //   5. Identify "diagnostic" evidence — evidence that would
      //      distinguish between hypotheses if found
      //
      // The three tables model: a session (the analyst's question), the
      // competing hypotheses, and the evidence cards. Scores are stored in
      // a separate join table (ach_scores) so we can change either side
      // without rewriting full rows.
      //
      // Every artifact carries classification + chain audit on create/
      // delete/score-change. Sessions are linked to chat sessions when the
      // analyst seeds them from a chat conversation.

      db.exec(`
        CREATE TABLE IF NOT EXISTS ach_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          question TEXT,
          chat_session_id TEXT,
          preliminary_report_id TEXT,
          classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
          status TEXT NOT NULL DEFAULT 'open',
          conclusion TEXT,
          conclusion_hypothesis_id TEXT,
          conclusion_confidence TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ach_sessions_chat ON ach_sessions(chat_session_id);
        CREATE INDEX IF NOT EXISTS idx_ach_sessions_status ON ach_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_ach_sessions_updated ON ach_sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS ach_hypotheses (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          label TEXT NOT NULL,
          description TEXT,
          source TEXT NOT NULL DEFAULT 'analyst',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES ach_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ach_hypotheses_session ON ach_hypotheses(session_id, ordinal);

        CREATE TABLE IF NOT EXISTS ach_evidence (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          claim TEXT NOT NULL,
          source_intel_id TEXT,
          source_humint_id TEXT,
          source_label TEXT,
          weight REAL NOT NULL DEFAULT 1.0,
          credibility INTEGER,
          notes TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES ach_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ach_evidence_session ON ach_evidence(session_id, ordinal);

        CREATE TABLE IF NOT EXISTS ach_scores (
          session_id TEXT NOT NULL,
          hypothesis_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          score TEXT NOT NULL,
          rationale TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (hypothesis_id, evidence_id),
          FOREIGN KEY (session_id) REFERENCES ach_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (hypothesis_id) REFERENCES ach_hypotheses(id) ON DELETE CASCADE,
          FOREIGN KEY (evidence_id) REFERENCES ach_evidence(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ach_scores_session ON ach_scores(session_id);
      `)

      log.info('Migration 017: ach_sessions / ach_hypotheses / ach_evidence / ach_scores created')
    }
  },
  {
    version: '018',
    name: 'compartments',
    up: (db) => {
      // Need-to-know compartments — Theme 10.2 + 10.5 of the agency roadmap.
      //
      // Classification levels (UNCLASSIFIED → TOP SECRET, migration 014)
      // answer "how sensitive is this?". Compartments answer the orthogonal
      // question "who needs to know about this category?".
      //
      // Real-world examples of compartments at agencies:
      //   SI    — Special Intelligence (SIGINT)
      //   TK    — Talent Keyhole (satellite imagery)
      //   G     — Gamma (especially sensitive SIGINT)
      //   HCS   — HUMINT Control System (clandestine sources)
      //   ORCON — Originator Controlled
      //   NOFORN — No Foreign Nationals
      //
      // Heimdall lets the analyst define their own compartments (since
      // real codewords are themselves classified) and grant themselves
      // tickets per-compartment.
      //
      // Visibility rule (enforced in renderer + bridges): an artifact
      // tagged with compartments [A, B] is visible only to a user holding
      // grants for ALL of A AND B (logical AND, "every compartment").
      // An artifact with no compartments is universally visible (subject
      // to classification gate).
      //
      // Each artifact stores its compartments as a JSON array of ticket
      // IDs in a new `compartments` TEXT column. Migration is purely
      // additive — every existing row defaults to '[]' (no compartment
      // restrictions).

      db.exec(`
        CREATE TABLE IF NOT EXISTS compartments (
          id TEXT PRIMARY KEY,
          ticket TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT,
          color TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compartments_ticket ON compartments(ticket);

        CREATE TABLE IF NOT EXISTS compartment_grants (
          id TEXT PRIMARY KEY,
          compartment_id TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT 'self',
          granted_at INTEGER NOT NULL,
          granted_by TEXT,
          revoked_at INTEGER,
          notes TEXT,
          FOREIGN KEY (compartment_id) REFERENCES compartments(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_compartment_grants_actor ON compartment_grants(actor, revoked_at);
      `)

      // Add `compartments TEXT` to every classified artifact table.
      const tables = [
        'intel_reports',
        'preliminary_reports',
        'humint_reports',
        'recommended_actions',
        'intel_gaps',
        'chat_sessions',
        'iw_events',
        'ach_sessions',
        'analytics_reports',
        'analyst_council_runs',
        'dpb_briefings'
      ]
      let added = 0
      for (const tbl of tables) {
        try {
          db.exec(`ALTER TABLE ${tbl} ADD COLUMN compartments TEXT NOT NULL DEFAULT '[]'`)
          added++
        } catch {
          // table doesn't exist (legacy install) or column already present — skip
        }
      }

      log.info(`Migration 018: compartments + compartment_grants tables created; compartments column added to ${added} artifact tables`)
    }
  },
  {
    version: '019',
    name: 'network_metrics',
    up: (db) => {
      // Cached centrality + community assignments — Theme 4.1 + 4.2 of the
      // agency roadmap. Computing PageRank / betweenness / Louvain on every
      // request would be wasteful; we cache the most recent run per node
      // and expose a "refresh" action in the UI.
      //
      // node_id refers to any artifact in the relationship graph — an
      // intel_report, preliminary_report, humint_report, or intel_gap.
      // node_type disambiguates across those tables. The `computed_at`
      // column is replicated per row so a partial refresh is still
      // straightforward to reason about.
      db.exec(`
        CREATE TABLE IF NOT EXISTS network_metrics (
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          degree REAL NOT NULL DEFAULT 0,
          pagerank REAL NOT NULL DEFAULT 0,
          betweenness REAL NOT NULL DEFAULT 0,
          eigenvector REAL NOT NULL DEFAULT 0,
          community_id INTEGER,
          label TEXT,
          discipline TEXT,
          computed_at INTEGER NOT NULL,
          PRIMARY KEY (node_id, node_type)
        );
        CREATE INDEX IF NOT EXISTS idx_network_metrics_pagerank ON network_metrics(pagerank DESC);
        CREATE INDEX IF NOT EXISTS idx_network_metrics_betweenness ON network_metrics(betweenness DESC);
        CREATE INDEX IF NOT EXISTS idx_network_metrics_degree ON network_metrics(degree DESC);
        CREATE INDEX IF NOT EXISTS idx_network_metrics_community ON network_metrics(community_id);

        CREATE TABLE IF NOT EXISTS network_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          node_count INTEGER,
          edge_count INTEGER,
          community_count INTEGER,
          modularity REAL,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      log.info('Migration 019: network_metrics + network_runs tables created')
    }
  },
  {
    version: '020',
    name: 'entity_resolution',
    up: (db) => {
      // Cross-domain entity resolution — Theme 4.6 of the agency roadmap.
      //
      // intel_entities holds raw extracted (type, value) pairs per report.
      // Many of those are aliases of the same real-world identity —
      // "Vladimir Putin", "V. Putin", "Putin, V." — that analytic queries
      // need to collapse. This migration adds:
      //
      //   - canonical_entities: one row per resolved identity, carrying the
      //     canonical (type, value) plus aggregate mention counts.
      //   - canonical_id column on intel_entities: pointer to the resolved
      //     identity. NULL until the resolver runs.
      //   - entity_resolution_runs: audit trail of resolver invocations
      //     (parameters, cluster count, duration, errors).
      //
      // The resolver writes canonical_id in bulk at the end of a run;
      // callers should treat NULL canonical_id as "unresolved — use raw
      // entity_value for display".

      db.exec(`
        CREATE TABLE IF NOT EXISTS canonical_entities (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          canonical_value TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          alias_count INTEGER NOT NULL DEFAULT 1,
          mention_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_canonical_type ON canonical_entities(entity_type);
        CREATE INDEX IF NOT EXISTS idx_canonical_mentions ON canonical_entities(mention_count DESC);
        CREATE INDEX IF NOT EXISTS idx_canonical_normalized ON canonical_entities(normalized_value);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_type_norm ON canonical_entities(entity_type, normalized_value);

        CREATE TABLE IF NOT EXISTS entity_resolution_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          raw_count INTEGER,
          cluster_count INTEGER,
          similarity_threshold REAL,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      // canonical_id points each raw entity at its resolved cluster head.
      // NULL until the resolver has run.
      try {
        db.exec(`ALTER TABLE intel_entities ADD COLUMN canonical_id TEXT`)
      } catch {
        // column already present — idempotent no-op
      }
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_canonical ON intel_entities(canonical_id)`)
      } catch { /* noop */ }

      log.info('Migration 020: canonical_entities + entity_resolution_runs tables + canonical_id column on intel_entities')
    }
  },
  {
    version: '021',
    name: 'deception_scoring',
    up: (db) => {
      // Counter-intelligence scoring — Theme 6.1 + 6.3 of the agency roadmap.
      //
      // Per-report linguistic deception score + flag breakdown. Scores run
      // from 0 (no flags) to 100 (heavy multiple-flag signal). Individual
      // heuristic flags are stored as a JSON array so the UI can show the
      // exact reasons.
      //
      // `source_bias_flags` holds the known-state-aligned source list with
      // per-source bias direction (pro-kremlin / pro-beijing / pro-tehran /
      // pro-pyongyang / pro-hamas / etc). Population is seeded in code on
      // first use rather than hardcoded here, so deployers can extend it
      // without a new migration.

      db.exec(`
        CREATE TABLE IF NOT EXISTS deception_scores (
          report_id TEXT PRIMARY KEY,
          overall_score REAL NOT NULL DEFAULT 0,
          flags TEXT NOT NULL DEFAULT '[]',
          word_count INTEGER NOT NULL DEFAULT 0,
          computed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_deception_score ON deception_scores(overall_score DESC);

        CREATE TABLE IF NOT EXISTS source_bias_flags (
          id TEXT PRIMARY KEY,
          match_type TEXT NOT NULL,
          match_value TEXT NOT NULL,
          bias_direction TEXT NOT NULL,
          note TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sbias_match ON source_bias_flags(match_type, match_value);

        CREATE TABLE IF NOT EXISTS counterintel_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          reports_scored INTEGER,
          avg_score REAL,
          high_flag_count INTEGER,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      log.info('Migration 021: deception_scores + source_bias_flags + counterintel_runs tables created')
    }
  },
  {
    version: '022',
    name: 'cybint',
    up: (db) => {
      // Theme 7 — CYBINT depth. MITRE ATT&CK + KEV/EPSS cache + per-report
      // mappings. The ATT&CK technique table is seeded from code on first
      // use (see CybintService.seedTechniques) so deployers can extend it
      // without a migration.
      //
      // kev_entries mirrors the CISA Known Exploited Vulnerabilities
      // catalog; synced on demand via cybintBridge.
      //
      // report_attack_map / report_cve_map are many-to-many.
      db.exec(`
        CREATE TABLE IF NOT EXISTS attack_techniques (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          tactic TEXT NOT NULL,
          description TEXT,
          is_sub INTEGER NOT NULL DEFAULT 0,
          parent_id TEXT,
          seeded_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attack_tactic ON attack_techniques(tactic);

        CREATE TABLE IF NOT EXISTS report_attack_map (
          report_id TEXT NOT NULL,
          technique_id TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          matched_via TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (report_id, technique_id)
        );
        CREATE INDEX IF NOT EXISTS idx_ram_technique ON report_attack_map(technique_id);

        CREATE TABLE IF NOT EXISTS kev_entries (
          cve_id TEXT PRIMARY KEY,
          vendor_project TEXT,
          product TEXT,
          vulnerability_name TEXT,
          date_added TEXT,
          short_description TEXT,
          required_action TEXT,
          due_date TEXT,
          known_ransomware_use INTEGER NOT NULL DEFAULT 0,
          cwes TEXT,
          notes TEXT,
          fetched_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_kev_vendor ON kev_entries(vendor_project);
        CREATE INDEX IF NOT EXISTS idx_kev_ransomware ON kev_entries(known_ransomware_use);

        CREATE TABLE IF NOT EXISTS cybint_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          items_processed INTEGER,
          items_written INTEGER,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      log.info('Migration 022: attack_techniques + report_attack_map + kev_entries + cybint_runs tables created')
    }
  },
  {
    version: '023',
    name: 'prompt_injection_screening',
    up: (db) => {
      // Theme F (cross-cutting) — prompt-injection ingest screener.
      //
      // Every intel_reports row flagged by the screener gets a row in
      // injection_flags with the matched rule(s), severity, and an
      // action taken (quarantine / annotate). The main process tags
      // high-severity rows as quarantined=1 on intel_reports so the
      // agent orchestrator can filter them out of LLM context.
      db.exec(`
        CREATE TABLE IF NOT EXISTS injection_flags (
          report_id TEXT PRIMARY KEY,
          severity TEXT NOT NULL,
          action TEXT NOT NULL,
          matched_rules TEXT NOT NULL DEFAULT '[]',
          flagged_at INTEGER NOT NULL,
          released_at INTEGER,
          released_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_inj_severity ON injection_flags(severity);
        CREATE INDEX IF NOT EXISTS idx_inj_action ON injection_flags(action);

        CREATE TABLE IF NOT EXISTS injection_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          reports_scanned INTEGER,
          reports_flagged INTEGER,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      // quarantined boolean on intel_reports so LLM paths can WHERE it out.
      try {
        db.exec(`ALTER TABLE intel_reports ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0`)
      } catch { /* idempotent */ }
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_quarantined ON intel_reports(quarantined)`)
      } catch { /* idempotent */ }

      log.info('Migration 023: injection_flags + injection_runs + quarantined column')
    }
  },
  {
    version: '024',
    name: 'overnight_cycle',
    up: (db) => {
      // Cross-cutting B — Autonomous overnight collection cycle.
      //
      // Adds an expires_at column to watch_terms so the overnight cycle
      // can spawn short-lived targeted terms (24h by default) without
      // permanently polluting the analyst's watchlist.
      //
      // overnight_runs tracks each cycle: identified gaps, generated
      // terms, reports collected, and DPB id produced.
      try {
        db.exec(`ALTER TABLE watch_terms ADD COLUMN expires_at INTEGER`)
      } catch { /* idempotent */ }
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_watch_terms_expiry ON watch_terms(expires_at)`)
      } catch { /* idempotent */ }

      db.exec(`
        CREATE TABLE IF NOT EXISTS overnight_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          gaps_considered INTEGER,
          terms_spawned INTEGER,
          reports_collected INTEGER,
          dpb_id TEXT,
          summary TEXT,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      log.info('Migration 024: watch_terms.expires_at + overnight_runs table')
    }
  },
  {
    version: '025',
    name: 'geofences',
    up: (db) => {
      // Theme 3.2 — Geofence alerts.
      //
      // Analyst draws a circular zone on the map (center + radius_km) with
      // optional discipline + severity filters. Any intel_reports row with
      // coordinates inside the zone that also matches the filters produces
      // a geofence_alert row. Alerts are append-only so a fired alert
      // survives even if the report is later updated.
      //
      // Circle-only for this batch; polygon support comes with leaflet-draw
      // in a later feature.
      db.exec(`
        CREATE TABLE IF NOT EXISTS geofences (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          center_lat REAL NOT NULL,
          center_lng REAL NOT NULL,
          radius_km REAL NOT NULL,
          discipline_filter TEXT,
          severity_filter TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_geofences_enabled ON geofences(enabled);

        CREATE TABLE IF NOT EXISTS geofence_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          geofence_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          distance_km REAL NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (geofence_id, report_id)
        );
        CREATE INDEX IF NOT EXISTS idx_gfa_fence ON geofence_alerts(geofence_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_gfa_report ON geofence_alerts(report_id);

        CREATE TABLE IF NOT EXISTS geofence_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          fences_scanned INTEGER,
          reports_scanned INTEGER,
          alerts_created INTEGER,
          duration_ms INTEGER,
          error TEXT
        );
      `)

      log.info('Migration 025: geofences + geofence_alerts + geofence_runs tables created')
    }
  },
  {
    version: '026',
    name: 'anomalies',
    up: (db) => {
      // Theme 5.3 — Anomaly detection on time-series signals.
      //
      // Stores detected anomalies so the UI can show a historical list
      // rather than recomputing on every view. An anomaly is a daily
      // bucket whose modified-z-score against the trailing-window
      // baseline crosses the threshold. Signals covered so far:
      //   report_volume — daily intel_reports count, optionally
      //                   filtered by discipline.
      //   watch_hits    — daily sum of watch_terms.hits.
      //
      // The same run may detect multiple anomalies across multiple
      // signals; UNIQUE (signal, bucket_at) keeps repeat scans idempotent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS anomalies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal TEXT NOT NULL,
          signal_label TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          value REAL NOT NULL,
          baseline_median REAL NOT NULL,
          baseline_mad REAL NOT NULL,
          modified_z REAL NOT NULL,
          direction TEXT NOT NULL,
          severity TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (signal, bucket_at)
        );
        CREATE INDEX IF NOT EXISTS idx_anomalies_signal ON anomalies(signal, bucket_at DESC);
        CREATE INDEX IF NOT EXISTS idx_anomalies_severity ON anomalies(severity);

        CREATE TABLE IF NOT EXISTS anomaly_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          signals_scanned INTEGER,
          anomalies_found INTEGER,
          duration_ms INTEGER,
          error TEXT
        );
      `)
      log.info('Migration 026: anomalies + anomaly_runs tables created')
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
