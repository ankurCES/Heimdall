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
  },
  {
    version: '027',
    name: 'image_exif',
    up: (db) => {
      // Theme 8.1 — Image EXIF extraction.
      //
      // image_evidence holds one row per analyzed image file (on disk or
      // by URL). EXIF/GPS/camera/timestamp fields are first-class so
      // filtered search ("images geolocated inside polygon X") is an
      // indexed query, not JSON scan.
      //
      // Linked to an intel_report when the image was found as part of
      // a report; free-standing otherwise (analyst drops an image into
      // the evidence locker manually).
      db.exec(`
        CREATE TABLE IF NOT EXISTS image_evidence (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          file_name TEXT,
          file_size INTEGER,
          mime_type TEXT,
          sha256 TEXT,
          report_id TEXT,
          latitude REAL,
          longitude REAL,
          altitude_m REAL,
          captured_at INTEGER,
          camera_make TEXT,
          camera_model TEXT,
          lens_model TEXT,
          orientation INTEGER,
          width INTEGER,
          height INTEGER,
          gps_accuracy_m REAL,
          raw_exif TEXT,
          ingested_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_image_report ON image_evidence(report_id);
        CREATE INDEX IF NOT EXISTS idx_image_captured ON image_evidence(captured_at DESC);
        CREATE INDEX IF NOT EXISTS idx_image_geo ON image_evidence(latitude, longitude);
        CREATE INDEX IF NOT EXISTS idx_image_sha ON image_evidence(sha256);
      `)
      log.info('Migration 027: image_evidence table created')
    }
  },
  {
    version: '028',
    name: 'stix_interop',
    up: (db) => {
      // Theme 7.6 — STIX 2.1 / TAXII 2.1 interoperability.
      //
      // stix_runs audits every export + import. On the import side the
      // stix_id column on imported rows lets us dedupe across repeat
      // imports of the same bundle — otherwise two imports of a 500-
      // object bundle would double every row.
      //
      // We add nullable stix_id columns to intel_reports and
      // intel_entities. Legacy rows have stix_id=NULL, which is fine.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stix_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          objects_in INTEGER,
          objects_out INTEGER,
          bundle_path TEXT,
          summary TEXT,
          duration_ms INTEGER,
          error TEXT
        );
      `)
      try { db.exec(`ALTER TABLE intel_reports ADD COLUMN stix_id TEXT`) } catch { /* idempotent */ }
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_stix_id ON intel_reports(stix_id)`) } catch { /* idempotent */ }
      try { db.exec(`ALTER TABLE intel_entities ADD COLUMN stix_id TEXT`) } catch { /* idempotent */ }
      try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_stix_id ON intel_entities(stix_id)`) } catch { /* idempotent */ }
      log.info('Migration 028: stix_runs + stix_id columns on intel_reports/intel_entities')
    }
  },
  {
    version: '029',
    name: 'memory_consolidation',
    up: (db) => {
      // Cross-cutting H — Memory consolidation.
      //
      // Nightly job compresses chat sessions into humint_reports so the
      // humint_recall tool can surface them in future conversations.
      // auto_consolidated flag lets us distinguish these rows from ones
      // an analyst explicitly recorded. consolidation_runs audits the
      // job.
      try {
        db.exec(`ALTER TABLE humint_reports ADD COLUMN auto_consolidated INTEGER NOT NULL DEFAULT 0`)
      } catch { /* idempotent */ }
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_humint_auto ON humint_reports(auto_consolidated)`)
      } catch { /* idempotent */ }
      db.exec(`
        CREATE TABLE IF NOT EXISTS consolidation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          sessions_considered INTEGER,
          sessions_consolidated INTEGER,
          humints_created INTEGER,
          duration_ms INTEGER,
          error TEXT
        );
      `)
      log.info('Migration 029: auto_consolidated column + consolidation_runs table')
    }
  },
  {
    version: '030',
    name: 'tradecraft_completeness',
    up: (db) => {
      // Theme 1.3 / 1.5 / 6.4 / 2.4 completeness.
      //
      // credibility_events logs every credibility adjustment with reason
      // (new corroboration, source demotion, deception hit…). The current
      // credibility/reliability lives on intel_reports already; this is
      // the audit trail + Bayesian update history.
      //
      // source_trust is the per-source_id reliability store. Collectors
      // already write intel_reports.source_id; this gives us one row per
      // source so degradation + demotion propagates cleanly.
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_trust (
          source_id TEXT PRIMARY KEY,
          reliability_grade TEXT NOT NULL DEFAULT 'F',
          deception_hits INTEGER NOT NULL DEFAULT 0,
          last_demoted_at INTEGER,
          demotion_reason TEXT,
          original_grade TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS credibility_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          report_id TEXT NOT NULL,
          prior_score REAL,
          new_score REAL NOT NULL,
          reason TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cred_report ON credibility_events(report_id, created_at DESC);
      `)
      log.info('Migration 030: source_trust + credibility_events tables')
    }
  },
  {
    version: '031',
    name: 'phase5_sweep',
    up: (db) => {
      // Phase 5 sweep — single migration covering batches 5C – 5J:
      //
      //   5C   intel_snapshots          — what-changed digests
      //        briefing_templates       — 9.5 DPB template editor
      //   5D   disinfo_clusters + items — J daily CIB detection
      //        insider_events           — 6.6 analyst query anomalies
      //        canary_tokens            — 6.5 honeypot token catalogue
      //   5E   reasoning_nodes          — D agent reasoning-graph
      //   5F   scenarios + forecasts    — 5.4 LLM scenario gens
      //   5G   detection_rules          — Sigma/YARA LLM output
      //   5H   misp_syncs               — 7.7 MISP bidir
      //   5I   taxii_server_runs        — 7.6 TAXII server lifecycle log
      //   5J   documents                — 8.3 OCR'd documents
      db.exec(`
        -- 5C
        CREATE TABLE IF NOT EXISTS intel_snapshots (
          id TEXT PRIMARY KEY,
          taken_at INTEGER NOT NULL,
          label TEXT,
          total_reports INTEGER NOT NULL DEFAULT 0,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS briefing_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          body_md TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- 5D
        CREATE TABLE IF NOT EXISTS disinfo_clusters (
          id TEXT PRIMARY KEY,
          signature_kind TEXT NOT NULL,
          signature_value TEXT NOT NULL,
          member_count INTEGER NOT NULL DEFAULT 0,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_disinfo_sig ON disinfo_clusters(signature_kind, signature_value);
        CREATE TABLE IF NOT EXISTS disinfo_cluster_members (
          cluster_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          PRIMARY KEY (cluster_id, report_id)
        );
        CREATE TABLE IF NOT EXISTS disinfo_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          reports_scanned INTEGER,
          clusters_found INTEGER,
          duration_ms INTEGER,
          error TEXT
        );

        CREATE TABLE IF NOT EXISTS insider_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          analyst_id TEXT NOT NULL DEFAULT 'self',
          kind TEXT NOT NULL,
          severity TEXT NOT NULL,
          detail TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_insider_created ON insider_events(created_at DESC);

        CREATE TABLE IF NOT EXISTS canary_tokens (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          attached_artifact_type TEXT,
          attached_artifact_id TEXT,
          observed_at INTEGER,
          observed_source TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL
        );

        -- 5E
        CREATE TABLE IF NOT EXISTS reasoning_nodes (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          parent_id TEXT,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reasoning_session ON reasoning_nodes(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reasoning_parent ON reasoning_nodes(parent_id);

        -- 5F
        CREATE TABLE IF NOT EXISTS scenarios (
          id TEXT PRIMARY KEY,
          topic TEXT NOT NULL,
          event_id TEXT,
          scenario_class TEXT NOT NULL,
          body_md TEXT NOT NULL,
          confidence_lo REAL,
          confidence_hi REAL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scenarios_topic ON scenarios(topic);
        CREATE TABLE IF NOT EXISTS conflict_scores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          region TEXT NOT NULL,
          bucket_at INTEGER NOT NULL,
          event_volume INTEGER NOT NULL DEFAULT 0,
          negative_sentiment_ratio REAL,
          iw_red_count INTEGER NOT NULL DEFAULT 0,
          probability_0_100 INTEGER NOT NULL,
          computed_at INTEGER NOT NULL,
          UNIQUE (region, bucket_at)
        );
        CREATE INDEX IF NOT EXISTS idx_conflict_region ON conflict_scores(region, bucket_at DESC);

        -- 5G
        CREATE TABLE IF NOT EXISTS detection_rules (
          id TEXT PRIMARY KEY,
          rule_type TEXT NOT NULL,
          name TEXT NOT NULL,
          body TEXT NOT NULL,
          source_report_id TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_detection_type ON detection_rules(rule_type, created_at DESC);

        -- 5H
        CREATE TABLE IF NOT EXISTS misp_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          events_in INTEGER,
          events_out INTEGER,
          attributes_in INTEGER,
          attributes_out INTEGER,
          endpoint TEXT,
          summary TEXT,
          duration_ms INTEGER,
          error TEXT
        );

        -- 5I
        CREATE TABLE IF NOT EXISTS taxii_server_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL,
          bind TEXT,
          collection_id TEXT,
          created_at INTEGER NOT NULL
        );

        -- 5J
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          file_name TEXT,
          file_size INTEGER,
          mime_type TEXT,
          sha256 TEXT,
          page_count INTEGER,
          ocr_text TEXT,
          ocr_confidence REAL,
          ocr_engine TEXT,
          redactions_found INTEGER NOT NULL DEFAULT 0,
          report_id TEXT,
          ingested_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_docs_sha ON documents(sha256);
        CREATE INDEX IF NOT EXISTS idx_docs_report ON documents(report_id);
      `)
      log.info('Migration 031: phase 5 sweep — 17 tables across batches 5C-5J')
    }
  },
  {
    version: '032',
    name: 'redaction_events',
    up: (db) => {
      // Theme 10.9 — US-persons / EEA-persons redaction event log.
      db.exec(`
        CREATE TABLE IF NOT EXISTS redaction_events (
          id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          original_snippet TEXT,
          offset_start INTEGER,
          offset_end INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          analyst_decision TEXT,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_redaction_report ON redaction_events(report_id);
        CREATE INDEX IF NOT EXISTS idx_redaction_status ON redaction_events(status, created_at DESC);
      `)
      log.info('Migration 032: redaction_events table created')
    }
  },
  {
    version: '033',
    name: 'wargaming_twoperson',
    up: (db) => {
      // Theme 5.5 + 10.8.
      db.exec(`
        CREATE TABLE IF NOT EXISTS wargame_runs (
          id TEXT PRIMARY KEY,
          scenario TEXT NOT NULL,
          red_objective TEXT,
          blue_objective TEXT,
          total_rounds INTEGER NOT NULL DEFAULT 3,
          status TEXT NOT NULL DEFAULT 'running',
          classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wargame_rounds (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          round_number INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          duration_ms INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wargame_rounds_run ON wargame_rounds(run_id, round_number, role);

        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          artifact_type TEXT,
          artifact_id TEXT,
          classification TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          requester TEXT NOT NULL DEFAULT 'self',
          approver TEXT,
          rejection_reason TEXT,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status, created_at DESC);
      `)
      log.info('Migration 033: wargame_runs + wargame_rounds + approval_requests tables created')
    }
  },
  {
    version: '034',
    name: 'performance_indexes',
    up: (db) => {
      // Performance indexes identified by the security + perf audit.
      // Each addresses a full-table-scan on 20K+ row tables.
      const indexes = [
        // Composite index for entity lookups (IOC pivot, entity resolution)
        'CREATE INDEX IF NOT EXISTS idx_entities_type_value ON intel_entities(entity_type, entity_value)',
        // intel_links.created_at for time-window network recompute
        'CREATE INDEX IF NOT EXISTS idx_links_created ON intel_links(created_at)',
        // Composite for deception + state-media filtering
        'CREATE INDEX IF NOT EXISTS idx_intel_source_discipline ON intel_reports(source_id, discipline)',
        // intel_reports.created_at covering index for date-range scans
        'CREATE INDEX IF NOT EXISTS idx_intel_created_disc ON intel_reports(created_at, discipline)'
      ]
      for (const sql of indexes) {
        try { db.exec(sql) } catch { /* index may already exist */ }
      }
      log.info('Migration 034: performance indexes (4 composite indexes added)')
    }
  },
  {
    version: '035',
    name: 'chat_messages_thinking_trail',
    up: (db) => {
      // Persist the full streamed "thinking" trail (planning steps,
      // tool calls, dark-web search progress, intermediate analyses) for
      // each assistant chat message so the analyst can review it later
      // via "Show thinking" on the response card. Nullable: legacy rows
      // and rows from non-streaming code paths simply have no trail.
      const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'thinking_trail')) {
        db.exec('ALTER TABLE chat_messages ADD COLUMN thinking_trail TEXT')
        log.info('Migration 035: chat_messages.thinking_trail column added')
      } else {
        log.info('Migration 035: chat_messages.thinking_trail already present, skipping')
      }
    }
  },
  {
    version: '036',
    name: 'intel_reports_fts5',
    up: (db) => {
      // FTS5 full-text index over intel_reports — replaces the LIKE-AND
      // chain in IntelRagService.searchReports with BM25-ranked search,
      // prefix matching, phrase queries, AND/OR/NOT operators, and Porter
      // stemming so "weapon" matches "weapons" / "weaponize" / "weaponry".
      //
      // Schema: external-content FTS5 table — the actual text lives in
      // intel_reports; the FTS table just stores tokens + the rowid mapping.
      // This halves the disk footprint vs. duplicating the content column.
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS intel_reports_fts USING fts5(
            title,
            content,
            summary,
            source_name,
            content='intel_reports',
            content_rowid='rowid',
            tokenize='porter unicode61 remove_diacritics 2'
          );
        `)
      } catch (err) {
        log.warn(`Migration 036: FTS5 virtual table creation failed (${err}). FTS5 may not be compiled into this SQLite build — search will fall back to LIKE.`)
        return
      }

      // Backfill: insert every existing report. On a vault with 100K+ rows
      // this can take 30-60s; surfaced via electron-log so the user sees it.
      const total = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports').get() as { c: number }).c
      const ftsTotal = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports_fts').get() as { c: number }).c
      if (ftsTotal < total) {
        log.info(`Migration 036: backfilling FTS5 index for ${total} reports (${ftsTotal} already indexed)…`)
        const start = Date.now()
        // INSERT INTO ... SELECT inside a single transaction is the fastest
        // path for FTS5 backfill — better-sqlite3 wraps it in WAL.
        db.exec(`
          INSERT INTO intel_reports_fts(rowid, title, content, summary, source_name)
          SELECT rowid,
                 COALESCE(title, ''),
                 COALESCE(content, ''),
                 COALESCE(summary, ''),
                 COALESCE(source_name, '')
          FROM intel_reports
          WHERE rowid NOT IN (SELECT rowid FROM intel_reports_fts);
        `)
        log.info(`Migration 036: FTS5 backfill complete in ${Date.now() - start}ms`)
      } else {
        log.info(`Migration 036: FTS5 already in sync (${ftsTotal} rows), no backfill needed`)
      }

      // Triggers — keep FTS in sync with intel_reports going forward.
      // BEFORE/AFTER + DELETE-INSERT pattern handles partial updates safely.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS intel_reports_fts_ai
        AFTER INSERT ON intel_reports BEGIN
          INSERT INTO intel_reports_fts(rowid, title, content, summary, source_name)
          VALUES (new.rowid,
                  COALESCE(new.title, ''),
                  COALESCE(new.content, ''),
                  COALESCE(new.summary, ''),
                  COALESCE(new.source_name, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS intel_reports_fts_ad
        AFTER DELETE ON intel_reports BEGIN
          INSERT INTO intel_reports_fts(intel_reports_fts, rowid, title, content, summary, source_name)
          VALUES ('delete', old.rowid,
                  COALESCE(old.title, ''),
                  COALESCE(old.content, ''),
                  COALESCE(old.summary, ''),
                  COALESCE(old.source_name, ''));
        END;

        CREATE TRIGGER IF NOT EXISTS intel_reports_fts_au
        AFTER UPDATE ON intel_reports BEGIN
          INSERT INTO intel_reports_fts(intel_reports_fts, rowid, title, content, summary, source_name)
          VALUES ('delete', old.rowid,
                  COALESCE(old.title, ''),
                  COALESCE(old.content, ''),
                  COALESCE(old.summary, ''),
                  COALESCE(old.source_name, ''));
          INSERT INTO intel_reports_fts(rowid, title, content, summary, source_name)
          VALUES (new.rowid,
                  COALESCE(new.title, ''),
                  COALESCE(new.content, ''),
                  COALESCE(new.summary, ''),
                  COALESCE(new.source_name, ''));
        END;
      `)
      log.info('Migration 036: FTS5 sync triggers installed')
    }
  },
  {
    version: '037',
    name: 'intel_reports_fts5_inplace_rebuild',
    up: (db) => {
      // Migration 036 created an external-content FTS5 table and tried to
      // populate it via INSERT INTO … SELECT. That pattern works for
      // INTERNAL-content FTS5 tables but is wrong for external-content
      // (content='intel_reports'): for external content the rowid mapping
      // is recorded but the term inverted-index is left empty, so MATCH
      // returns near-zero hits.
      //
      // The fix is to issue the FTS5 'rebuild' command. It re-reads every
      // source row (via the content= reference) and rebuilds the inverted
      // index in place — non-destructive, no DROP TABLE required.
      //
      // We avoid DROP TABLE here because on the encrypted SQLite build
      // (sqlite-multiple-ciphers) the previous 037 attempt corrupted the
      // database file at boot ("file is not a database"). The in-place
      // rebuild is safer + faster.
      try {
        const probe = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intel_reports_fts'").get()
        if (!probe) {
          log.info('Migration 037: intel_reports_fts table missing (likely 036 failed); skipping rebuild')
          return
        }
        const total = (db.prepare('SELECT COUNT(*) AS c FROM intel_reports').get() as { c: number }).c
        log.info(`Migration 037: in-place FTS5 inverted-index rebuild for ${total} reports…`)
        const start = Date.now()
        db.exec(`INSERT INTO intel_reports_fts(intel_reports_fts) VALUES('rebuild');`)
        log.info(`Migration 037: FTS5 rebuild complete in ${Date.now() - start}ms`)

        // Optional: also run 'optimize' to merge index segments for faster
        // MATCH queries. Cheap (<100ms on 60K rows), worth doing once.
        try {
          db.exec(`INSERT INTO intel_reports_fts(intel_reports_fts) VALUES('optimize');`)
          log.info('Migration 037: FTS5 optimize complete')
        } catch (err) {
          log.debug(`Migration 037: optimize skipped (${err})`)
        }
      } catch (err) {
        log.error(`Migration 037 failed (non-fatal — search will fall back to LIKE): ${err}`)
        // Swallow rather than throw — a botched FTS rebuild shouldn't
        // brick the whole boot. searchReports has a LIKE fallback.
      }
    }
  },
  {
    version: '038',
    name: 'darkweb_seeds_and_host_health',
    up: (db) => {
      // darkweb_seeds — curated + user-added queries that the DarkWeb
      // Explorer page sweeps to populate intel. Each row is one search
      // term with category, hit-count, and last-run metadata.
      db.exec(`
        CREATE TABLE IF NOT EXISTS darkweb_seeds (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          query TEXT NOT NULL,
          description TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          is_custom INTEGER NOT NULL DEFAULT 0,
          last_run_at INTEGER,
          last_error TEXT,
          hit_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(category, query)
        );
        CREATE INDEX IF NOT EXISTS idx_darkweb_seeds_enabled ON darkweb_seeds(enabled, category);
      `)

      // darkweb_host_health — track per-onion-hostname fetch reliability.
      // Used by the stale-onion pruner: after N consecutive failures the
      // hostname is quarantined and excluded from refresh sweeps until
      // the analyst manually un-quarantines or it succeeds via direct
      // call (e.g. ahmia returns it again in a new search).
      db.exec(`
        CREATE TABLE IF NOT EXISTS darkweb_host_health (
          hostname TEXT PRIMARY KEY,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          total_failures INTEGER NOT NULL DEFAULT 0,
          total_successes INTEGER NOT NULL DEFAULT 0,
          last_success_at INTEGER,
          last_failure_at INTEGER,
          last_error TEXT,
          quarantined INTEGER NOT NULL DEFAULT 0,
          quarantined_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dwhh_quarantined ON darkweb_host_health(quarantined);
      `)

      log.info('Migration 038: darkweb_seeds + darkweb_host_health tables created')
    }
  },
  {
    version: '039',
    name: 'telegram_intel_queue',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS telegram_intel_queue (
          id TEXT PRIMARY KEY,
          telegram_message_id INTEGER NOT NULL,
          telegram_chat_id INTEGER NOT NULL,
          sender_id INTEGER,
          sender_username TEXT,
          sender_name TEXT,
          message_date INTEGER NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'text',
          text_content TEXT,
          media_file_id TEXT,
          media_local_path TEXT,
          media_mime_type TEXT,
          urls TEXT,
          onion_urls TEXT,
          forward_from_name TEXT,
          forward_from_chat_title TEXT,
          raw_json TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          rejection_reason TEXT,
          analyst_notes TEXT,
          ingested_report_ids TEXT,
          reviewed_at INTEGER,
          reviewed_by TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(telegram_chat_id, telegram_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tiq_status ON telegram_intel_queue(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tiq_sender ON telegram_intel_queue(sender_id);
        CREATE INDEX IF NOT EXISTS idx_tiq_date ON telegram_intel_queue(message_date DESC);
      `)
      log.info('Migration 039: telegram_intel_queue table created')
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
