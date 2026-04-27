// BriefingBuilderService — assembles multiple published reports into a
// single executive briefing document. Auto-generates a roll-up exec
// summary by concatenating each report's key judgments, prepends a TOC,
// and renders the whole thing as a single PDF using the existing
// PdfRenderer infrastructure (so the same letterhead + signature page
// apply).

import { reportLibraryService, type ReportProduct } from './ReportLibraryService'
import { renderReportToPdf } from './PdfRenderer'
import { settingsService } from '../settings/SettingsService'
import type { LetterheadConfig } from '@common/types/settings'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import log from 'electron-log'

export interface BriefingInput {
  title: string
  reportIds: string[]
  recipient?: string
  classificationOverride?: string
  /** Custom intro paragraph above the auto-generated exec summary. */
  introNote?: string
}

export interface BriefingResult {
  bytes: Uint8Array
  pageCount: number
  reportCount: number
  signature?: { sha256: string; signatureB64: string; fingerprint: string }
}

const DEFAULT_LETTERHEAD: LetterheadConfig = {
  agencyName: '', agencyTagline: '', agencyShortName: '', logoBase64: '',
  defaultClassification: 'UNCLASSIFIED//FOR OFFICIAL USE ONLY',
  distributionStatement: 'Distribution authorized for official use only. Reproduction prohibited without originator approval.',
  footerText: '', signaturesEnabled: true
}

export class BriefingBuilderService {
  /**
   * Render N reports as a single briefing PDF. The briefing is constructed
   * as a synthetic ReportProduct (in memory only — never persisted to
   * report_products) so we can reuse PdfRenderer end-to-end.
   */
  async render(input: BriefingInput): Promise<BriefingResult> {
    if (input.reportIds.length === 0) throw new Error('briefing requires at least one report')

    // Resolve all reports
    const reports = input.reportIds
      .map((id) => reportLibraryService.get(id))
      .filter((r): r is ReportProduct => r !== null)
    if (reports.length === 0) throw new Error('none of the requested reports were found')

    const letterhead = settingsService.get<LetterheadConfig>('letterhead') || DEFAULT_LETTERHEAD
    const synth = this.buildBriefingMarkdown(input, reports)

    // Construct a synthetic ReportProduct for the renderer
    const briefing: ReportProduct = {
      id: 'briefing-' + generateId(),
      sessionId: null,
      workflowRunId: null,
      parentReportId: null,
      version: 1,
      title: input.title,
      format: 'assessment',
      classification: input.classificationOverride || letterhead.defaultClassification,
      query: `Executive briefing assembled from ${reports.length} published report(s)`,
      bodyMarkdown: synth,
      tradecraftScore: this.averageScore(reports),
      tradecraftDeficiencies: [],
      wasRegenerated: false,
      modelUsed: null,
      llmConnection: null,
      sourceFindingsSha: null,
      generatedAt: Date.now(),
      status: 'published',
      supersededById: null,
      tags: ['briefing'],
      regionTags: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const rendered = await renderReportToPdf(briefing, letterhead, {
      recipient: input.recipient,
      classificationOverride: input.classificationOverride
    })

    // Distribution log
    try {
      getDatabase().prepare(`
        INSERT INTO report_distributions
          (id, report_id, format, recipient, signature_sha, signature_b64, exported_at, exported_by)
        VALUES (?, ?, 'pdf', ?, ?, ?, ?, ?)
      `).run(
        generateId(),
        briefing.id,                       // synthetic id; not in report_products
        input.recipient || null,
        rendered.signature?.sha256 || '',
        rendered.signature?.signatureB64 || null,
        Date.now(),
        'briefing-builder'
      )
    } catch (err) { log.debug(`briefing distribution insert failed: ${err}`) }

    return {
      bytes: rendered.bytes,
      pageCount: rendered.pageCount,
      reportCount: reports.length,
      signature: rendered.signature ? {
        sha256: rendered.signature.sha256,
        signatureB64: rendered.signature.signatureB64,
        fingerprint: rendered.signature.fingerprint
      } : undefined
    }
  }

  /**
   * Build the composite markdown: auto-TOC, exec roll-up, then each
   * report's full body separated by horizontal rules.
   */
  private buildBriefingMarkdown(input: BriefingInput, reports: ReportProduct[]): string {
    const parts: string[] = []

    parts.push(`# EXECUTIVE BRIEFING`)
    parts.push('')
    if (input.introNote) {
      parts.push(input.introNote)
      parts.push('')
    }

    // TOC
    parts.push('## CONTENTS')
    parts.push('')
    reports.forEach((r, i) => {
      parts.push(`${i + 1}. **${r.title}** — ${this.formatLabel(r.format)}, ICD-203 ${r.tradecraftScore ?? '—'}/100`)
    })
    parts.push('')
    parts.push('---')
    parts.push('')

    // Roll-up exec summary
    parts.push('## CONSOLIDATED KEY JUDGMENTS')
    parts.push('')
    let kjCounter = 1
    for (const r of reports) {
      const kjs = this.extractKeyJudgments(r.bodyMarkdown)
      for (const kj of kjs) {
        parts.push(`${kjCounter}. ${kj.replace(/^\s*\d+[.)]\s*/, '').trim()}`)
        parts.push(`   *— from "${r.title}"*`)
        parts.push('')
        kjCounter++
        if (kjCounter > 30) break  // hard cap
      }
      if (kjCounter > 30) break
    }
    if (kjCounter === 1) {
      parts.push('*No KEY JUDGMENTS sections found in the included reports — full bodies follow below.*')
      parts.push('')
    }
    parts.push('---')
    parts.push('')

    // Each report in full
    reports.forEach((r, i) => {
      parts.push(`## ${i + 1}. ${r.title}`)
      parts.push('')
      parts.push(`*Format: ${this.formatLabel(r.format)} · Classification: ${r.classification} · ICD-203: ${r.tradecraftScore ?? '—'}/100 · Generated: ${new Date(r.generatedAt).toISOString().slice(0, 10)}*`)
      parts.push('')
      parts.push(r.bodyMarkdown)
      parts.push('')
      if (i < reports.length - 1) {
        parts.push('---')
        parts.push('')
      }
    })

    return parts.join('\n')
  }

  private extractKeyJudgments(body: string): string[] {
    const sectionMatch = body.match(/KEY JUDGMENTS?[\s\S]*?(?=\n#{1,4}\s+\w|\nDISCUSSION\b|\nDETAILED ANALYSIS\b|\nDISSEMINATION\b|$)/i)
    if (!sectionMatch) return []
    const items = sectionMatch[0].match(/^\s*\d+[.)]\s+(.+(?:\n(?!\s*\d+[.)])(?!\s*$).*)*)/gm) || []
    return items.map((s) => s.trim().slice(0, 400)).filter((s) => s.length > 30).slice(0, 5)
  }

  private formatLabel(format: string): string {
    return format === 'nie' ? 'NIE' : format === 'pdb' ? 'PDB Item'
      : format === 'iir' ? 'IIR' : 'Assessment'
  }

  private averageScore(reports: ReportProduct[]): number | null {
    const scored = reports.filter((r) => r.tradecraftScore !== null)
    if (scored.length === 0) return null
    return Math.round(scored.reduce((s, r) => s + (r.tradecraftScore || 0), 0) / scored.length)
  }
}

export const briefingBuilderService = new BriefingBuilderService()
