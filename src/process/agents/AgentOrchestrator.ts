import { cronService } from '../services/cron/CronService'
import { getDatabase } from '../services/database'
import { llmService } from '../services/llm/LlmService'
import { intelEnricher } from '../services/enrichment/IntelEnricher'
import { memoryService } from '../services/memory/MemoryService'
import { alertEngine } from '../services/alerts/AlertEngine'
import { settingsService } from '../services/settings/SettingsService'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

export class AgentOrchestrator {
  private running = false

  start(): void {
    // Lead Agent — runs every 5 minutes, triages new reports
    cronService.schedule('agent:lead', '*/5 * * * *', 'Lead Agent (Triage)', () => this.runLeadAgent())

    // Analyst Agent — runs every 15 minutes, enriches and finds links
    cronService.schedule('agent:analyst', '*/15 * * * *', 'Analyst Agent (Enrichment)', () => this.runAnalystAgent())

    // Summary Agent — runs daily at midnight
    cronService.schedule('agent:summary', '0 0 * * *', 'Summary Agent (Daily)', () => this.runSummaryAgent())

    // Weekly summary — runs Sunday midnight
    cronService.schedule('agent:weekly', '0 0 * * 0', 'Summary Agent (Weekly)', () => this.runWeeklySummaryAgent())

    this.running = true
    log.info('Agent orchestrator started — 4 agents scheduled')

    // Run lead agent immediately on startup for any unprocessed reports
    this.runLeadAgent().catch((err) => log.warn('Initial lead agent run failed:', err))
  }

  stop(): void {
    cronService.unschedule('agent:lead')
    cronService.unschedule('agent:analyst')
    cronService.unschedule('agent:summary')
    cronService.unschedule('agent:weekly')
    this.running = false
    log.info('Agent orchestrator stopped')
  }

  // ── Lead Agent ─────────────────────────────────────────────────────
  // Triages new reports: enriches with tags/entities, flags important ones
  private async runLeadAgent(): Promise<void> {
    const db = getDatabase()

    // Find reports not yet enriched (no tags)
    const unenriched = db.prepare(`
      SELECT r.* FROM intel_reports r
      LEFT JOIN intel_tags t ON r.id = t.report_id
      WHERE t.report_id IS NULL
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all() as Array<Record<string, unknown>>

    if (unenriched.length === 0) return

    log.info(`Lead Agent: processing ${unenriched.length} unenriched reports`)

    for (const row of unenriched) {
      const report: IntelReport = {
        id: row.id as string,
        discipline: row.discipline as IntelReport['discipline'],
        title: row.title as string,
        content: row.content as string,
        summary: row.summary as string | null,
        severity: row.severity as IntelReport['severity'],
        sourceId: row.source_id as string,
        sourceUrl: row.source_url as string | null,
        sourceName: row.source_name as string,
        contentHash: row.content_hash as string,
        latitude: row.latitude as number | null,
        longitude: row.longitude as number | null,
        verificationScore: row.verification_score as number,
        reviewed: (row.reviewed as number) === 1,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number
      }

      try {
        intelEnricher.enrichReport(report)
      } catch (err) {
        log.debug(`Lead Agent: enrichment failed for ${report.id}: ${err}`)
      }
    }

    log.info(`Lead Agent: enriched ${unenriched.length} reports`)
  }

  // ── Analyst Agent ─────────────────────────────────────────────────
  // Uses LLM to generate summaries and deeper analysis for high-severity reports
  private async runAnalystAgent(): Promise<void> {
    const llmConfig = settingsService.get('llm') as { baseUrl?: string; model?: string } | null
    if (!llmConfig?.baseUrl || !llmConfig?.model) return // LLM not configured

    const db = getDatabase()

    // Find high-severity reports without summaries
    const unsummarized = db.prepare(`
      SELECT * FROM intel_reports
      WHERE severity IN ('critical', 'high')
      AND summary IS NULL
      ORDER BY created_at DESC
      LIMIT 10
    `).all() as Array<Record<string, unknown>>

    if (unsummarized.length === 0) return

    log.info(`Analyst Agent: generating summaries for ${unsummarized.length} reports`)

    for (const row of unsummarized) {
      try {
        const prompt = `Analyze this intelligence report and provide a concise 2-3 sentence actionable summary. Include key entities, threat assessment, and recommended action.

Title: ${row.title}
Discipline: ${(row.discipline as string).toUpperCase()}
Severity: ${(row.severity as string).toUpperCase()}
Source: ${row.source_name}

${(row.content as string).slice(0, 2000)}`

        const summary = await llmService.complete(prompt, 300)
        if (summary?.trim()) {
          db.prepare('UPDATE intel_reports SET summary = ?, updated_at = ? WHERE id = ?').run(
            summary.trim(), Date.now(), row.id
          )
        }
      } catch (err) {
        log.debug(`Analyst Agent: summary failed for ${row.id}: ${err}`)
      }

      // Rate limit LLM calls
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  // ── Summary Agents ────────────────────────────────────────────────
  private async runSummaryAgent(): Promise<void> {
    try {
      memoryService.generateDailySummary()
    } catch (err) {
      log.error('Daily summary agent failed:', err)
    }
  }

  private async runWeeklySummaryAgent(): Promise<void> {
    try {
      memoryService.generateWeeklySummary()
    } catch (err) {
      log.error('Weekly summary agent failed:', err)
    }
  }

  isRunning(): boolean {
    return this.running
  }
}

export const agentOrchestrator = new AgentOrchestrator()
