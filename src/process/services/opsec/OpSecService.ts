// OpSecService — operational-security configuration + enforcement.
//
// Default-on for fresh installs. Modes are presets that bundle several
// individual toggles:
//
//   paranoid   — air-gap enforced, no cloud LLM, scrub LLM logs, no telemetry
//   strict     — cloud LLM allowed but warn, scrub LLM logs, no telemetry
//   standard   — cloud LLM allowed silently, scrub logs, no telemetry  (recommended for most)
//   permissive — everything allowed (development only — not recommended)
//
// The service exposes:
//   - get/update config
//   - airGapDetect(): scans recent collector log to verify air-gap posture
//   - scrubLlmText(): masks IPs, names, classification markings before logging
//   - shouldBlockOutbound(host): consulted by SafeFetcher
//
// Air-gap enforcement: when air_gap_enforced is on, SafeFetcher is
// expected to bind to local-network/proxy-only addresses. We don't
// actively block here; we surface warnings on the dashboard if any
// service makes a non-local call after enforcement is enabled.

import { getDatabase } from '../database'
import log from 'electron-log'

export type OpSecMode = 'paranoid' | 'strict' | 'standard' | 'permissive'

export interface OpSecConfig {
  mode: OpSecMode
  allowExternalTelemetry: boolean
  allowCloudLlm: boolean
  scrubLlmLogs: boolean
  airGapEnforced: boolean
  allowOutboundHostnames: string[]   // even when air-gap is on, these are allowed (e.g. proxy)
  warnOnExternalCalls: boolean
  updatedAt: number
}

const DEFAULT_CONFIG: OpSecConfig = {
  mode: 'paranoid',
  allowExternalTelemetry: false,
  allowCloudLlm: true,
  scrubLlmLogs: true,
  airGapEnforced: false,
  allowOutboundHostnames: [],
  warnOnExternalCalls: true,
  updatedAt: 0
}

const MODE_PRESETS: Record<OpSecMode, Partial<OpSecConfig>> = {
  paranoid: {
    allowExternalTelemetry: false,
    allowCloudLlm: false,
    scrubLlmLogs: true,
    airGapEnforced: true,
    warnOnExternalCalls: true
  },
  strict: {
    allowExternalTelemetry: false,
    allowCloudLlm: true,
    scrubLlmLogs: true,
    airGapEnforced: false,
    warnOnExternalCalls: true
  },
  standard: {
    allowExternalTelemetry: false,
    allowCloudLlm: true,
    scrubLlmLogs: true,
    airGapEnforced: false,
    warnOnExternalCalls: false
  },
  permissive: {
    allowExternalTelemetry: true,
    allowCloudLlm: true,
    scrubLlmLogs: false,
    airGapEnforced: false,
    warnOnExternalCalls: false
  }
}

// Patterns to redact from LLM logs when scrubLlmLogs is on. We keep this
// conservative — the goal is to prevent intel content from leaking into
// app logs, not to perfectly anonymize.
const SCRUB_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  { name: 'ip_v4', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
  { name: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[EMAIL]' },
  { name: 'classification', re: /\b(?:TOP\s+)?SECRET(?:\s*\/\/[A-Z]+)?/gi, replacement: '[CLASS]' },
  { name: 'noforn', re: /\bNOFORN\b/g, replacement: '[CLASS]' },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN]' },
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[CC]' },
  { name: 'btc', re: /\b(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g, replacement: '[BTC]' }
]

export class OpSecService {
  config(): OpSecConfig {
    const row = getDatabase().prepare(`
      SELECT mode, allow_external_telemetry AS allowExternalTelemetry,
             allow_cloud_llm AS allowCloudLlm,
             scrub_llm_logs AS scrubLlmLogs,
             air_gap_enforced AS airGapEnforced,
             allow_outbound_hostnames_json AS allowOutboundJson,
             warn_on_external_calls AS warnOnExternalCalls,
             updated_at AS updatedAt
      FROM opsec_config WHERE id = 1
    `).get() as ({ mode: string;
                   allowExternalTelemetry: number; allowCloudLlm: number;
                   scrubLlmLogs: number; airGapEnforced: number;
                   allowOutboundJson: string | null;
                   warnOnExternalCalls: number; updatedAt: number }) | undefined
    if (!row) return DEFAULT_CONFIG
    return {
      mode: row.mode as OpSecMode,
      allowExternalTelemetry: !!row.allowExternalTelemetry,
      allowCloudLlm: !!row.allowCloudLlm,
      scrubLlmLogs: !!row.scrubLlmLogs,
      airGapEnforced: !!row.airGapEnforced,
      allowOutboundHostnames: row.allowOutboundJson ? safeJson(row.allowOutboundJson, [] as string[]) : [],
      warnOnExternalCalls: !!row.warnOnExternalCalls,
      updatedAt: row.updatedAt
    }
  }

  update(patch: Partial<OpSecConfig>): OpSecConfig {
    const cur = this.config()
    let next: OpSecConfig = { ...cur, ...patch }
    // If mode changed, apply the preset
    if (patch.mode && patch.mode !== cur.mode) {
      const preset = MODE_PRESETS[patch.mode]
      next = { ...next, ...preset }
    }
    next.updatedAt = Date.now()
    getDatabase().prepare(`
      UPDATE opsec_config SET
        mode = ?, allow_external_telemetry = ?, allow_cloud_llm = ?,
        scrub_llm_logs = ?, air_gap_enforced = ?,
        allow_outbound_hostnames_json = ?, warn_on_external_calls = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      next.mode,
      next.allowExternalTelemetry ? 1 : 0,
      next.allowCloudLlm ? 1 : 0,
      next.scrubLlmLogs ? 1 : 0,
      next.airGapEnforced ? 1 : 0,
      JSON.stringify(next.allowOutboundHostnames),
      next.warnOnExternalCalls ? 1 : 0,
      next.updatedAt
    )
    log.info(`OpSec: mode=${next.mode} airGap=${next.airGapEnforced} cloudLLM=${next.allowCloudLlm} scrub=${next.scrubLlmLogs}`)
    return next
  }

  /**
   * Scrub potentially-sensitive content for safe logging. When opsec mode
   * permits, returns the input unchanged.
   */
  scrubForLogging(text: string): string {
    if (!this.config().scrubLlmLogs) return text
    let result = text
    for (const { re, replacement } of SCRUB_PATTERNS) {
      result = result.replace(re, replacement)
    }
    return result
  }

  /** Block-list check for outbound hosts. */
  shouldBlockOutbound(hostname: string): boolean {
    const cfg = this.config()
    if (!cfg.airGapEnforced) return false
    const allowList = cfg.allowOutboundHostnames
    if (allowList.length === 0) return true
    return !allowList.some((pattern) => {
      // Exact or wildcard suffix match
      if (pattern === hostname) return true
      if (pattern.startsWith('*.') && hostname.endsWith(pattern.slice(1))) return true
      if (hostname === pattern.replace(/^\*\./, '')) return true
      return false
    })
  }

  /** Quick LAN/local-host check. Treats RFC1918 + loopback as "internal". */
  isLocalAddress(host: string): boolean {
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    // RFC1918 + link-local
    if (/^10\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true
    if (/^169\.254\./.test(host)) return true
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
    return false
  }

  /**
   * Scan the audit log + recent collector activity for evidence of
   * external network calls when air-gap is supposed to be enforced.
   * Returns a list of suspected violations.
   */
  airGapPosture(): { enforced: boolean; suspectedViolations: Array<{ host: string; lastSeen: number; count: number }> } {
    const cfg = this.config()
    if (!cfg.airGapEnforced) {
      return { enforced: false, suspectedViolations: [] }
    }
    const since = Date.now() - 6 * 60 * 60 * 1000
    const violations: Array<{ host: string; lastSeen: number; count: number }> = []
    try {
      const db = getDatabase()
      const rows = db.prepare(`
        SELECT source_url AS url, MAX(created_at) AS lastSeen, COUNT(*) AS n
        FROM intel_reports
        WHERE source_url IS NOT NULL AND created_at >= ?
        GROUP BY source_url
        LIMIT 200
      `).all(since) as Array<{ url: string | null; lastSeen: number; n: number }>
      const seen = new Map<string, { lastSeen: number; count: number }>()
      for (const r of rows) {
        if (!r.url) continue
        try {
          const u = new URL(r.url)
          if (this.isLocalAddress(u.hostname)) continue
          if (this.shouldBlockOutbound(u.hostname)) {
            const existing = seen.get(u.hostname)
            seen.set(u.hostname, {
              lastSeen: Math.max(r.lastSeen, existing?.lastSeen ?? 0),
              count: r.n + (existing?.count ?? 0)
            })
          }
        } catch { /* */ }
      }
      for (const [host, info] of seen) {
        violations.push({ host, lastSeen: info.lastSeen, count: info.count })
      }
    } catch (err) {
      log.debug(`airGapPosture scan failed: ${err}`)
    }
    return { enforced: true, suspectedViolations: violations.slice(0, 50) }
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

export const opSecService = new OpSecService()
