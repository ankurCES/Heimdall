// AlertEscalationService — operational alert routing for the v1.2.x ops
// foundation. Differs from the existing AlertEngine in two ways:
//
//   1. It consumes from the `alerts` table directly (not from intel reports)
//      so any service can fire an alert by inserting a row.
//   2. It routes by SEVERITY and SOURCE GLOB rather than per-report rules.
//
// Polls every 30s for unacknowledged alerts, applies matching escalation
// rules, dispatches to the configured channels via the existing
// dispatcher infrastructure, and records the escalation timestamp.
//
// Re-escalates if a high/critical alert is still unacknowledged after
// `escalation_after_minutes` minutes (default 15).

import { getDatabase } from '../../database'
import { generateId } from '@common/utils/id'
import { TelegramDispatcher } from '../dispatchers/TelegramDispatcher'
import { EmailDispatcher } from '../dispatchers/EmailDispatcher'
import { MeshtasticDispatcher } from '../dispatchers/MeshtasticDispatcher'
import log from 'electron-log'

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical'
export type AlertChannel = 'telegram' | 'email' | 'meshtastic' | 'webhook' | 'desktop'

export interface EscalationRule {
  id: string
  name: string
  enabled: boolean
  matchSeverity: AlertSeverity[]
  matchSourceGlob: string | null
  channels: AlertChannel[]
  channelConfig: Record<string, unknown>
  quietHours: { start: string; end: string; tz?: string } | null
  createdAt: number
  updatedAt: number
}

export interface OnCallConfig {
  primaryTelegramChatId: string | null
  primaryEmail: string | null
  primaryMeshtasticNode: string | null
  escalationAfterMinutes: number
}

interface OpAlertRow {
  id: string
  severity: string | null
  source: string | null
  title: string | null
  body: string | null
  payload: string | null
  created_at: number
  escalated_at: number | null
  acknowledged_at: number | null
}

export class AlertEscalationService {
  private timer: NodeJS.Timeout | null = null
  private telegram = new TelegramDispatcher()
  private email = new EmailDispatcher()
  private meshtastic = new MeshtasticDispatcher()
  private polling = false

  start(intervalMs: number = 30_000): void {
    if (this.timer) return
    log.info(`AlertEscalation: started (interval ${intervalMs}ms)`)
    setTimeout(() => this.poll().catch((e) => log.warn(`escalation initial: ${e}`)), 15_000)
    this.timer = setInterval(() => this.poll().catch((e) => log.warn(`escalation: ${e}`)), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async poll(): Promise<{ scanned: number; dispatched: number }> {
    if (this.polling) return { scanned: 0, dispatched: 0 }
    this.polling = true
    try {
      const db = getDatabase()
      const onCall = this.getOnCallConfig()
      const rules = this.listRules().filter((r) => r.enabled)
      if (rules.length === 0) return { scanned: 0, dispatched: 0 }

      // Pull unacknowledged ops alerts (severity is non-null = ops alert)
      const unack = db.prepare(`
        SELECT id, severity, source, title, body, payload, created_at,
               escalated_at, acknowledged_at
        FROM alerts
        WHERE severity IS NOT NULL AND acknowledged_at IS NULL
        ORDER BY created_at DESC
        LIMIT 200
      `).all() as OpAlertRow[]

      const escalateAfterMs = (onCall.escalationAfterMinutes ?? 15) * 60 * 1000
      let dispatched = 0

      for (const alert of unack) {
        const isFirst = alert.escalated_at === null
        const needsRepeat = alert.escalated_at !== null
          && Date.now() - alert.escalated_at >= escalateAfterMs
          && (alert.severity === 'high' || alert.severity === 'critical')
        if (!isFirst && !needsRepeat) continue

        const matchingRules = rules.filter((rule) =>
          rule.matchSeverity.includes((alert.severity || 'low') as AlertSeverity)
          && this.sourceMatches(alert.source, rule.matchSourceGlob)
          && !this.inQuietHours(rule)
        )
        if (matchingRules.length === 0) continue

        const channels = new Set<AlertChannel>()
        for (const rule of matchingRules) {
          for (const ch of rule.channels) channels.add(ch)
        }

        for (const ch of channels) {
          await this.dispatchToChannel(ch, alert, onCall)
        }

        // Mark as escalated
        db.prepare(`UPDATE alerts SET escalated_at = ? WHERE id = ?`)
          .run(Date.now(), alert.id)
        dispatched++
        log.info(`AlertEscalation: dispatched ${alert.severity} alert "${alert.title?.slice(0, 50)}" to ${Array.from(channels).join(', ')}`)
      }

      return { scanned: unack.length, dispatched }
    } finally {
      this.polling = false
    }
  }

  private sourceMatches(source: string | null, glob: string | null): boolean {
    if (!glob) return true
    if (!source) return false
    const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
    return re.test(source)
  }

  private inQuietHours(rule: EscalationRule): boolean {
    if (!rule.quietHours) return false
    const now = new Date()
    const [sh, sm] = rule.quietHours.start.split(':').map(Number)
    const [eh, em] = rule.quietHours.end.split(':').map(Number)
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin
    // Crosses midnight
    return nowMin >= startMin || nowMin < endMin
  }

  private async dispatchToChannel(
    channel: AlertChannel,
    alert: OpAlertRow,
    onCall: OnCallConfig
  ): Promise<void> {
    const subject = `[${alert.severity?.toUpperCase()}] ${alert.title ?? 'Heimdall alert'}`
    const body = (alert.body ?? '') + (alert.source ? `\n\nSource: ${alert.source}` : '')
    try {
      if (channel === 'telegram') {
        await this.telegram.sendCustom?.(subject, body)
      } else if (channel === 'email') {
        await this.email.sendCustom?.(subject, body)
      } else if (channel === 'meshtastic') {
        await this.meshtastic.sendCustom?.(subject + '\n' + body.slice(0, 200))
      } else if (channel === 'desktop') {
        // Notification via main process — handled by NotificationListener in renderer
        const { BrowserWindow } = await import('electron')
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          try { win.webContents.send('alert:incoming', { severity: alert.severity, title: alert.title, body }) }
          catch { /* */ }
        }
      } else if (channel === 'webhook') {
        // Caller provides URL via channelConfig; deferred until we have a UI.
      }
      void onCall
    } catch (err) {
      log.warn(`AlertEscalation dispatch ${channel} failed: ${err}`)
    }
  }

  // ── Rule CRUD ────────────────────────────────────────────────────────

  listRules(): EscalationRule[] {
    const rows = getDatabase().prepare(`
      SELECT id, name, enabled, match_severity_json AS matchSeverityJson,
             match_source_glob AS matchSourceGlob, channels_json AS channelsJson,
             channel_config_json AS channelConfigJson, quiet_hours_json AS quietHoursJson,
             created_at AS createdAt, updated_at AS updatedAt
      FROM alert_escalation_rules ORDER BY name
    `).all() as Array<{
      id: string; name: string; enabled: number;
      matchSeverityJson: string; matchSourceGlob: string | null;
      channelsJson: string; channelConfigJson: string | null;
      quietHoursJson: string | null; createdAt: number; updatedAt: number
    }>
    return rows.map((r) => ({
      id: r.id, name: r.name, enabled: !!r.enabled,
      matchSeverity: safeJson(r.matchSeverityJson, [] as AlertSeverity[]),
      matchSourceGlob: r.matchSourceGlob,
      channels: safeJson(r.channelsJson, [] as AlertChannel[]),
      channelConfig: safeJson(r.channelConfigJson ?? '{}', {} as Record<string, unknown>),
      quietHours: r.quietHoursJson ? safeJson(r.quietHoursJson, null as EscalationRule['quietHours']) : null,
      createdAt: r.createdAt, updatedAt: r.updatedAt
    }))
  }

  createRule(rule: Omit<EscalationRule, 'id' | 'createdAt' | 'updatedAt'>): EscalationRule {
    const id = generateId()
    const now = Date.now()
    getDatabase().prepare(`
      INSERT INTO alert_escalation_rules
        (id, name, enabled, match_severity_json, match_source_glob,
         channels_json, channel_config_json, quiet_hours_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, rule.name, rule.enabled ? 1 : 0,
      JSON.stringify(rule.matchSeverity),
      rule.matchSourceGlob,
      JSON.stringify(rule.channels),
      JSON.stringify(rule.channelConfig),
      rule.quietHours ? JSON.stringify(rule.quietHours) : null,
      now, now
    )
    return this.listRules().find((r) => r.id === id)!
  }

  updateRule(id: string, patch: Partial<EscalationRule>): EscalationRule | null {
    const fields: string[] = []
    const params: unknown[] = []
    if ('name' in patch && patch.name !== undefined) { fields.push('name = ?'); params.push(patch.name) }
    if ('enabled' in patch && patch.enabled !== undefined) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0) }
    if (patch.matchSeverity) { fields.push('match_severity_json = ?'); params.push(JSON.stringify(patch.matchSeverity)) }
    if ('matchSourceGlob' in patch) { fields.push('match_source_glob = ?'); params.push(patch.matchSourceGlob ?? null) }
    if (patch.channels) { fields.push('channels_json = ?'); params.push(JSON.stringify(patch.channels)) }
    if (patch.channelConfig) { fields.push('channel_config_json = ?'); params.push(JSON.stringify(patch.channelConfig)) }
    if ('quietHours' in patch) { fields.push('quiet_hours_json = ?'); params.push(patch.quietHours ? JSON.stringify(patch.quietHours) : null) }
    if (fields.length === 0) return this.listRules().find((r) => r.id === id) ?? null
    fields.push('updated_at = ?'); params.push(Date.now())
    params.push(id)
    getDatabase().prepare(`UPDATE alert_escalation_rules SET ${fields.join(', ')} WHERE id = ?`).run(...params)
    return this.listRules().find((r) => r.id === id) ?? null
  }

  deleteRule(id: string): boolean {
    const r = getDatabase().prepare(`DELETE FROM alert_escalation_rules WHERE id = ?`).run(id)
    return r.changes > 0
  }

  getOnCallConfig(): OnCallConfig {
    const row = getDatabase().prepare(`
      SELECT primary_telegram_chat_id AS primaryTelegramChatId,
             primary_email AS primaryEmail,
             primary_meshtastic_node AS primaryMeshtasticNode,
             escalation_after_minutes AS escalationAfterMinutes
      FROM on_call_config WHERE id = 1
    `).get() as OnCallConfig | undefined
    return row ?? {
      primaryTelegramChatId: null, primaryEmail: null, primaryMeshtasticNode: null,
      escalationAfterMinutes: 15
    }
  }

  updateOnCallConfig(patch: Partial<OnCallConfig>): OnCallConfig {
    const cur = this.getOnCallConfig()
    const next = { ...cur, ...patch }
    getDatabase().prepare(`
      UPDATE on_call_config SET
        primary_telegram_chat_id = ?,
        primary_email = ?,
        primary_meshtastic_node = ?,
        escalation_after_minutes = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      next.primaryTelegramChatId, next.primaryEmail, next.primaryMeshtasticNode,
      next.escalationAfterMinutes, Date.now()
    )
    return next
  }

  // ── Acknowledgements ────────────────────────────────────────────────

  acknowledge(alertId: string, by: string = 'analyst', notes?: string): boolean {
    const db = getDatabase()
    const now = Date.now()
    const r = db.prepare(`UPDATE alerts SET acknowledged_at = ? WHERE id = ?`).run(now, alertId)
    if (r.changes === 0) return false
    db.prepare(`
      INSERT INTO alert_acknowledgements (id, alert_id, acknowledged_by, notes, acknowledged_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(generateId(), alertId, by, notes ?? null, now)
    return true
  }

  /** Recent ops alerts for the dashboard. */
  recentAlerts(limit: number = 50): Array<OpAlertRow & { ackBy: string | null; ackNotes: string | null }> {
    return getDatabase().prepare(`
      SELECT a.*,
             (SELECT acknowledged_by FROM alert_acknowledgements WHERE alert_id = a.id LIMIT 1) AS ackBy,
             (SELECT notes FROM alert_acknowledgements WHERE alert_id = a.id LIMIT 1) AS ackNotes
      FROM alerts a
      WHERE a.severity IS NOT NULL
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit) as Array<OpAlertRow & { ackBy: string | null; ackNotes: string | null }>
  }

  stats(): { unacknowledged: number; bySeverity: Record<string, number>; lastDay: number } {
    const db = getDatabase()
    const unack = (db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE severity IS NOT NULL AND acknowledged_at IS NULL`).get() as { n: number }).n
    const bySeverity: Record<string, number> = {}
    for (const r of db.prepare(`SELECT severity, COUNT(*) AS n FROM alerts WHERE severity IS NOT NULL AND acknowledged_at IS NULL GROUP BY severity`).all() as Array<{ severity: string; n: number }>) {
      bySeverity[r.severity] = r.n
    }
    const since = Date.now() - 24 * 60 * 60 * 1000
    const lastDay = (db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE severity IS NOT NULL AND created_at >= ?`).get(since) as { n: number }).n
    return { unacknowledged: unack, bySeverity, lastDay }
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

export const alertEscalationService = new AlertEscalationService()
