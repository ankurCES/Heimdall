import nodemailer from 'nodemailer'
import type { IntelReport } from '@common/types/intel'
import { settingsService } from '../../settings/SettingsService'
import type { SmtpConfig } from '@common/types/settings'
import log from 'electron-log'

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  info: '#6b7280'
}

export class EmailDispatcher {
  async send(report: IntelReport, recipients?: string[]): Promise<void> {
    const config = settingsService.get<SmtpConfig>('smtp')
    if (!config?.host) throw new Error('SMTP not configured')

    const toAddresses = recipients || config.defaultRecipients
    if (!toAddresses || toAddresses.length === 0) throw new Error('No email recipients configured')

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.tls && config.port === 465,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
      tls: config.tls ? { rejectUnauthorized: false } : undefined
    })

    const color = SEVERITY_COLORS[report.severity] || '#6b7280'
    const html = this.buildHtml(report, color)

    await transporter.sendMail({
      from: config.fromAddress,
      to: toAddresses.join(', '),
      subject: `[Heimdall ${report.severity.toUpperCase()}] ${report.title.slice(0, 100)}`,
      html,
      text: this.buildPlainText(report)
    })

    log.info(`Email alert sent: ${report.title.slice(0, 50)} → ${toAddresses.length} recipients`)
  }

  /**
   * Send a free-form text/html alert (used by AlertEscalationService for
   * ops alerts that don't have an associated IntelReport).
   */
  async sendCustom(subject: string, body: string, recipients?: string[]): Promise<void> {
    const config = settingsService.get<SmtpConfig>('smtp')
    if (!config?.host) throw new Error('SMTP not configured')
    const toAddresses = recipients || config.defaultRecipients
    if (!toAddresses || toAddresses.length === 0) throw new Error('No email recipients configured')

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.tls && config.port === 465,
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
      tls: config.tls ? { rejectUnauthorized: false } : undefined
    })

    await transporter.sendMail({
      from: config.fromAddress,
      to: toAddresses.join(', '),
      subject,
      text: body,
      html: `<pre style="font-family: -apple-system, sans-serif; white-space: pre-wrap;">${this.escapeHtml(body)}</pre>`
    })
    log.info(`Email custom alert sent: ${subject.slice(0, 50)} → ${toAddresses.length} recipients`)
  }

  private buildHtml(report: IntelReport, color: string): string {
    return `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; background: #0f172a;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: ${color}; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0;">
      <h2 style="margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">
        Heimdall ${report.severity.toUpperCase()} Alert
      </h2>
    </div>
    <div style="background: #1e293b; padding: 20px; border-radius: 0 0 8px 8px; color: #e2e8f0;">
      <h3 style="margin: 0 0 12px 0; color: white; font-size: 16px;">${this.escapeHtml(report.title)}</h3>
      <table style="width: 100%; font-size: 13px; color: #94a3b8;">
        <tr><td style="padding: 4px 0;"><strong>Discipline:</strong></td><td>${report.discipline.toUpperCase()}</td></tr>
        <tr><td style="padding: 4px 0;"><strong>Source:</strong></td><td>${this.escapeHtml(report.sourceName)}</td></tr>
        <tr><td style="padding: 4px 0;"><strong>Verification:</strong></td><td>${report.verificationScore}/100</td></tr>
        <tr><td style="padding: 4px 0;"><strong>Collected:</strong></td><td>${new Date(report.createdAt).toISOString()}</td></tr>
        ${report.latitude ? `<tr><td style="padding: 4px 0;"><strong>Location:</strong></td><td>${report.latitude}, ${report.longitude}</td></tr>` : ''}
      </table>
      <hr style="border: none; border-top: 1px solid #334155; margin: 16px 0;">
      <div style="font-size: 13px; line-height: 1.6; color: #cbd5e1; white-space: pre-wrap;">${this.escapeHtml(report.content.slice(0, 2000))}</div>
      ${report.sourceUrl ? `<p style="margin-top: 16px;"><a href="${this.escapeHtml(report.sourceUrl)}" style="color: ${color};">View Source</a></p>` : ''}
    </div>
    <p style="text-align: center; font-size: 11px; color: #475569; margin-top: 12px;">
      Sent by Heimdall Intelligence Platform
    </p>
  </div>
</body>
</html>`
  }

  private buildPlainText(report: IntelReport): string {
    return `[HEIMDALL ${report.severity.toUpperCase()} ALERT]

${report.title}

Discipline: ${report.discipline.toUpperCase()}
Source: ${report.sourceName}
Verification: ${report.verificationScore}/100
Collected: ${new Date(report.createdAt).toISOString()}
${report.sourceUrl ? `Source URL: ${report.sourceUrl}` : ''}

${report.content.slice(0, 2000)}
`
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
}
