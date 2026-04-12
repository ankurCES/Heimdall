import { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '@common/adapter/ipcBridge'
import type { IntelReport, AlertChannel } from '@common/types/intel'
import type { AlertRule, AlertDispatchResult } from '@common/types/alerts'
import { AlertRuleEvaluator } from './AlertRuleEvaluator'
import { EmailDispatcher } from './dispatchers/EmailDispatcher'
import { TelegramDispatcher } from './dispatchers/TelegramDispatcher'
import { MeshtasticDispatcher } from './dispatchers/MeshtasticDispatcher'
import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export class AlertEngine {
  private evaluator = new AlertRuleEvaluator()
  private emailDispatcher = new EmailDispatcher()
  private telegramDispatcher = new TelegramDispatcher()
  private meshtasticDispatcher = new MeshtasticDispatcher()

  // Track recently alerted report hashes to avoid duplicates
  private recentAlerts = new Set<string>()
  private alertsPerHour = 0
  private lastHourReset = Date.now()
  private maxAlertsPerHour = 50

  async evaluate(report: IntelReport): Promise<void> {
    // Rate limit check
    this.checkHourlyReset()
    if (this.alertsPerHour >= this.maxAlertsPerHour) {
      log.warn('Alert rate limit reached, skipping evaluation')
      return
    }

    // Dedup check — don't alert on same content hash twice
    if (this.recentAlerts.has(report.contentHash)) return

    // Load rules from settings
    const rules = settingsService.get<AlertRule[]>('alertRules') || []
    if (rules.length === 0) return

    // Evaluate rules
    const matchedRules = this.evaluator.evaluate(report, rules)
    if (matchedRules.length === 0) return

    // Collect unique channels from matched rules
    const channels = new Set<AlertChannel>()
    for (const rule of matchedRules) {
      for (const ch of rule.channels) channels.add(ch)
    }

    log.info(`Alert triggered for "${report.title.slice(0, 50)}" — ${matchedRules.length} rules matched, channels: ${Array.from(channels).join(', ')}`)

    // Dispatch to each channel
    for (const channel of channels) {
      await this.dispatch(report, channel)
    }

    // Mark as alerted
    this.recentAlerts.add(report.contentHash)
    this.alertsPerHour++

    // Prune old entries (keep last 1000)
    if (this.recentAlerts.size > 1000) {
      const arr = Array.from(this.recentAlerts)
      this.recentAlerts = new Set(arr.slice(-500))
    }
  }

  private async dispatch(report: IntelReport, channel: AlertChannel): Promise<void> {
    const now = timestamp()
    const alertId = generateId()
    let status: 'sent' | 'failed' = 'sent'
    let error: string | null = null

    try {
      switch (channel) {
        case 'email':
          await this.emailDispatcher.send(report)
          break
        case 'telegram':
          await this.telegramDispatcher.send(report)
          break
        case 'meshtastic':
          await this.meshtasticDispatcher.send(report)
          break
      }
    } catch (err) {
      status = 'failed'
      error = String(err)
      log.warn(`Alert dispatch failed (${channel}): ${err}`)
    }

    // Record in database
    try {
      const db = getDatabase()
      db.prepare(
        'INSERT INTO alerts (id, intel_report_id, channel, recipient, status, error, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(alertId, report.id, channel, channel, status, error, status === 'sent' ? now : null, now)
    } catch (err) {
      log.error('Failed to record alert:', err)
    }

    // Emit to renderer
    const alertData = {
      id: alertId,
      intelReportId: report.id,
      channel,
      recipient: channel,
      status,
      error,
      sentAt: status === 'sent' ? now : null,
      createdAt: now
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_EVENTS.INTEL_ALERT_SENT, alertData)
    }
  }

  private checkHourlyReset(): void {
    const now = Date.now()
    if (now - this.lastHourReset >= 3600000) {
      this.alertsPerHour = 0
      this.lastHourReset = now
    }
  }

  getRules(): AlertRule[] {
    return settingsService.get<AlertRule[]>('alertRules') || []
  }

  saveRules(rules: AlertRule[]): void {
    settingsService.set('alertRules', rules)
  }

  getHistory(offset: number, limit: number): { alerts: Array<Record<string, unknown>>; total: number } {
    const db = getDatabase()
    const total = (db.prepare('SELECT COUNT(*) as count FROM alerts').get() as { count: number }).count
    const alerts = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as Array<Record<string, unknown>>
    return { alerts, total }
  }
}

export const alertEngine = new AlertEngine()
