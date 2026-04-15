import type Database from 'better-sqlite3-multiple-ciphers'

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intel_reports (
      id TEXT PRIMARY KEY,
      discipline TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
      source_id TEXT NOT NULL,
      source_url TEXT,
      source_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      verification_score INTEGER NOT NULL DEFAULT 50,
      reviewed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intel_discipline ON intel_reports(discipline);
    CREATE INDEX IF NOT EXISTS idx_intel_severity ON intel_reports(severity);
    CREATE INDEX IF NOT EXISTS idx_intel_created ON intel_reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_intel_hash ON intel_reports(content_hash);
    CREATE INDEX IF NOT EXISTS idx_intel_source ON intel_reports(source_id);
    CREATE INDEX IF NOT EXISTS idx_intel_reviewed ON intel_reports(reviewed);

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      discipline TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      schedule TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_collected_at INTEGER,
      last_error TEXT,
      error_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      intel_report_id TEXT,
      channel TEXT NOT NULL CHECK(channel IN ('email','telegram','meshtastic')),
      recipient TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
      error TEXT,
      sent_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      details TEXT,
      source_url TEXT,
      http_status INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT 'default',
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);

    -- Enrichment: tags assigned to reports
    CREATE TABLE IF NOT EXISTS intel_tags (
      report_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'auto',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (report_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_tags_tag ON intel_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_tags_report ON intel_tags(report_id);

    -- Enrichment: named entities extracted from reports
    CREATE TABLE IF NOT EXISTS intel_entities (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type ON intel_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_value ON intel_entities(entity_value);
    CREATE INDEX IF NOT EXISTS idx_entities_report ON intel_entities(report_id);

    -- Enrichment: links between reports (shared entities, temporal, causal)
    CREATE TABLE IF NOT EXISTS intel_links (
      id TEXT PRIMARY KEY,
      source_report_id TEXT NOT NULL,
      target_report_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      strength REAL NOT NULL DEFAULT 0.5,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_links_source ON intel_links(source_report_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON intel_links(target_report_id);
    CREATE INDEX IF NOT EXISTS idx_links_type ON intel_links(link_type);

    -- Add enriched flag to intel_reports if not exists
    CREATE INDEX IF NOT EXISTS idx_intel_updated ON intel_reports(updated_at);

    -- Token usage tracking
    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      connection_name TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'direct',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_created ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_model ON token_usage(model);

    -- IMINT frames
    CREATE TABLE IF NOT EXISTS imint_frames (
      id TEXT PRIMARY KEY,
      report_id TEXT,
      source_name TEXT NOT NULL,
      frame_path TEXT NOT NULL,
      analysis TEXT,
      detected_events TEXT,
      latitude REAL,
      longitude REAL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_imint_report ON imint_frames(report_id);
    CREATE INDEX IF NOT EXISTS idx_imint_created ON imint_frames(created_at);

    -- Meshtastic node tracking
    CREATE TABLE IF NOT EXISTS meshtastic_nodes (
      node_id TEXT PRIMARY KEY,
      long_name TEXT,
      short_name TEXT,
      hardware_model TEXT,
      last_heard INTEGER,
      latitude REAL,
      longitude REAL,
      battery_level INTEGER,
      snr REAL,
      channel INTEGER,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_mesh_nodes_seen ON meshtastic_nodes(last_seen);

    -- Sync dedup log
    CREATE TABLE IF NOT EXISTS sync_log (
      type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (type, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_type ON sync_log(type);

    -- Preliminary reports (from chat intelligence briefings)
    CREATE TABLE IF NOT EXISTS preliminary_reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      chat_message_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'preliminary',
      source_report_ids TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prelim_session ON preliminary_reports(session_id);

    -- Information gaps identified in preliminary reports
    CREATE TABLE IF NOT EXISTS intel_gaps (
      id TEXT PRIMARY KEY,
      preliminary_report_id TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gaps_prelim ON intel_gaps(preliminary_report_id);
    CREATE INDEX IF NOT EXISTS idx_gaps_status ON intel_gaps(status);

    -- Recommended actions from preliminary reports
    CREATE TABLE IF NOT EXISTS recommended_actions (
      id TEXT PRIMARY KEY,
      preliminary_report_id TEXT NOT NULL,
      action TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_actions_prelim ON recommended_actions(preliminary_report_id);
    CREATE INDEX IF NOT EXISTS idx_actions_status ON recommended_actions(status);

    -- HUMINT reports
    CREATE TABLE IF NOT EXISTS humint_reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      analyst_notes TEXT,
      findings TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      source_report_ids TEXT,
      tool_calls_used TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_humint_session ON humint_reports(session_id);

    -- Watch terms for targeted intelligence collection
    CREATE TABLE IF NOT EXISTS watch_terms (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      category TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      enabled INTEGER NOT NULL DEFAULT 1,
      hits INTEGER NOT NULL DEFAULT 0,
      last_hit_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_watch_enabled ON watch_terms(enabled);
    CREATE INDEX IF NOT EXISTS idx_watch_source ON watch_terms(source);

    -- Tool call logs for audit trail and Obsidian sync
    CREATE TABLE IF NOT EXISTS tool_call_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      params TEXT,
      result TEXT,
      execution_time_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_call_logs(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_call_logs(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_call_logs(created_at);
  `)
}
