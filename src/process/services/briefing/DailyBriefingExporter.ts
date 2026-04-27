// DailyBriefingExporter — v1.6.1 PDF / DOCX rendering for the
// automated daily briefing.
//
// Reuses two existing pieces of infrastructure:
//   1. PdfRenderer.renderReportToPdf() — handles letterhead, classification
//      banner, page numbers, signature page, ICD-formatted layout. We
//      adapt the DailyBriefingRow into a synthetic ReportProduct so the
//      same renderer applies.
//   2. The `docx` npm package (already a dep) — we hand-build a minimal
//      DOCX from the markdown body for editorial workflows where the
//      analyst wants to tweak before distribution.
//
// Email delivery (briefing:daily_email) goes through nodemailer
// directly with the rendered PDF as an attachment. The existing
// EmailDispatcher handles structured alerts, but it doesn't support
// attachments — so we re-create a slim transporter here.

import path from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { app } from 'electron'
import nodemailer from 'nodemailer'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, PageNumber, Header, Footer
} from 'docx'
import log from 'electron-log'
import { settingsService } from '../settings/SettingsService'
import type { LetterheadConfig, SmtpConfig } from '@common/types/settings'
import { renderReportToPdf } from '../report/PdfRenderer'
import type { ReportProduct } from '../report/ReportLibraryService'
import { dailyBriefingService, type DailyBriefingRow } from './DailyBriefingService'

export type BriefingExportFormat = 'pdf' | 'docx'

export interface BriefingExportResult {
  format: BriefingExportFormat
  filename: string
  bytes: Uint8Array
}

/** Synthesise a ReportProduct shape from a DailyBriefingRow so the
 *  existing PdfRenderer treats it the same as any saved report.
 *  Format 'briefing' is a hint to the renderer — falls back gracefully
 *  to the generic intel-report layout if unrecognised. */
function asReportProduct(row: DailyBriefingRow): ReportProduct {
  const periodLabel = `${new Date(row.period_start).toLocaleDateString()} → ${new Date(row.period_end).toLocaleDateString()}`
  return {
    id: row.id,
    sessionId: null,
    workflowRunId: null,
    parentReportId: null,
    version: 1,
    title: `Daily Intelligence Briefing — ${periodLabel}`,
    format: 'briefing' as ReportProduct['format'],
    classification: row.classification,
    query: null,
    bodyMarkdown: row.body_md ?? '_(briefing body unavailable)_',
    tradecraftScore: null,
    tradecraftDeficiencies: [],
    wasRegenerated: false,
    modelUsed: row.model,
    llmConnection: null,
    sourceFindingsSha: null,
    generatedAt: row.generated_at,
    status: 'final' as ReportProduct['status'],
    supersededById: null,
    tags: ['daily-briefing'],
    regionTags: [],
    createdAt: row.generated_at,
    updatedAt: row.generated_at
  }
}

export async function exportBriefing(
  briefingId: string,
  format: BriefingExportFormat
): Promise<BriefingExportResult> {
  const row = dailyBriefingService.get(briefingId)
  if (!row) throw new Error(`Briefing not found: ${briefingId}`)
  if (row.status !== 'ready' || !row.body_md) {
    throw new Error(`Briefing ${briefingId} is not ready (status=${row.status})`)
  }

  const periodLabel = `${new Date(row.period_start).toLocaleDateString()} → ${new Date(row.period_end).toLocaleDateString()}`
  const baseName = `daily-briefing-${new Date(row.period_end).toISOString().slice(0, 10)}-${row.id.slice(0, 8)}`

  if (format === 'pdf') {
    const letterhead = settingsService.get<LetterheadConfig>('letterhead') || ({} as LetterheadConfig)
    const product = asReportProduct(row)
    const result = await renderReportToPdf(product, letterhead, { skipSignature: true })
    return {
      format: 'pdf',
      filename: `${baseName}.pdf`,
      bytes: result.bytes
    }
  }

  // DOCX: hand-build from markdown. We don't try to reproduce
  // typography 1:1 — analysts who want pixel-perfect get the PDF.
  // The DOCX is for editing-and-redistribute workflows.
  const letterhead = settingsService.get<LetterheadConfig>('letterhead') || ({} as LetterheadConfig)
  const buf = await renderBriefingDocx(row, letterhead, periodLabel)
  return {
    format: 'docx',
    filename: `${baseName}.docx`,
    bytes: new Uint8Array(buf)
  }
}

async function renderBriefingDocx(
  row: DailyBriefingRow,
  letterhead: LetterheadConfig,
  periodLabel: string
): Promise<Buffer> {
  // Convert the LLM markdown into docx-friendly paragraphs. We do a
  // minimal parse — heading levels, bullets, paragraphs — keeping the
  // output legible without reaching for a full markdown-to-docx
  // converter (those exist but are heavy and add dependency risk).
  const children: Paragraph[] = []

  // Title block
  children.push(new Paragraph({
    text: `Daily Intelligence Briefing`,
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER
  }))
  children.push(new Paragraph({
    text: periodLabel,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 }
  }))
  children.push(new Paragraph({
    children: [
      new TextRun({ text: 'CLASSIFICATION: ', bold: true }),
      new TextRun({ text: row.classification })
    ],
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 }
  }))
  children.push(new Paragraph({
    children: [
      new TextRun({ text: 'PRODUCED: ', bold: true }),
      new TextRun({ text: new Date(row.generated_at).toISOString() })
    ],
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 }
  }))
  if (row.model) {
    children.push(new Paragraph({
      children: [new TextRun({ text: `Model: ${row.model}`, italics: true, size: 18 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 }
    }))
  }

  // Body — markdown lines walked into paragraphs
  for (const rawLine of (row.body_md ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      children.push(new Paragraph({ text: '', spacing: { after: 80 } }))
      continue
    }
    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (hMatch) {
      const level = hMatch[1].length
      const headingLevels = [
        HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6
      ]
      children.push(new Paragraph({
        text: hMatch[2].trim(),
        heading: headingLevels[level - 1],
        spacing: { before: 200, after: 80 }
      }))
      continue
    }
    // Bullets
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/)
    if (bullet) {
      children.push(new Paragraph({
        text: bullet[2],
        bullet: { level: 0 },
        spacing: { after: 60 }
      }))
      continue
    }
    // Numbered list
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/)
    if (numbered) {
      children.push(new Paragraph({
        text: numbered[2],
        numbering: { reference: 'numbered', level: 0 },
        spacing: { after: 60 }
      }))
      continue
    }
    // Inline emphasis: **bold** + *italic* + `code` are converted to
    // TextRun children. Anything not matched falls through as plain.
    const runs = parseInlineRuns(line)
    children.push(new Paragraph({ children: runs, spacing: { after: 60 } }))
  }

  const doc = new Document({
    creator: letterhead.agencyName || 'Heimdall',
    title: 'Daily Intelligence Briefing',
    description: `Generated by Heimdall on ${new Date(row.generated_at).toISOString()}`,
    sections: [{
      headers: {
        default: new Header({
          children: [new Paragraph({
            children: [new TextRun({ text: row.classification, bold: true, size: 18 })],
            alignment: AlignmentType.CENTER
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: row.classification, bold: true, size: 18 }),
              new TextRun({ text: '   ·   ' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
              new TextRun({ text: ' / ', size: 18 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 })
            ]
          })]
        })
      },
      children
    }]
  })

  return Packer.toBuffer(doc)
}

/** Tiny inline-markdown → docx TextRun[] converter. Handles the
 *  common patterns the LLM produces (**bold**, *italic*, `code`)
 *  without pulling in a full parser. Unmatched stretches fall
 *  through as plain runs. */
function parseInlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  // Split on bold/italic/code boundaries
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }))
    const tok = m[0]
    if (tok.startsWith('**')) runs.push(new TextRun({ text: tok.slice(2, -2), bold: true }))
    else if (tok.startsWith('`')) runs.push(new TextRun({ text: tok.slice(1, -1), font: 'Courier New' }))
    else runs.push(new TextRun({ text: tok.slice(1, -1), italics: true }))
    last = m.index + tok.length
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }))
  return runs.length > 0 ? runs : [new TextRun({ text })]
}

// ── Email delivery ───────────────────────────────────────────────────

export async function emailBriefing(
  briefingId: string,
  recipients: string[],
  format: BriefingExportFormat = 'pdf'
): Promise<{ ok: true; recipients: string[] }> {
  const row = dailyBriefingService.get(briefingId)
  if (!row) throw new Error(`Briefing not found: ${briefingId}`)
  if (row.status !== 'ready') throw new Error(`Briefing not ready (status=${row.status})`)

  const smtp = settingsService.get<SmtpConfig>('smtp')
  if (!smtp?.host) throw new Error('SMTP not configured (Settings → SMTP)')
  const targets = recipients.length > 0 ? recipients : (smtp.defaultRecipients ?? [])
  if (targets.length === 0) throw new Error('No recipients (provide a list or set defaults in SMTP settings)')

  const exported = await exportBriefing(briefingId, format)

  // Persist a copy under <userData>/exports/briefings/ so the
  // analyst has a permanent on-disk artifact even after retention.
  const exportsDir = path.join(app.getPath('userData'), 'exports', 'briefings')
  await mkdir(exportsDir, { recursive: true })
  const onDisk = path.join(exportsDir, exported.filename)
  await writeFile(onDisk, exported.bytes)

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls && smtp.port === 465,
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    tls: smtp.tls ? { rejectUnauthorized: false } : undefined
  })

  const periodLabel = `${new Date(row.period_start).toLocaleDateString()} → ${new Date(row.period_end).toLocaleDateString()}`
  const summaryLines = [
    `Heimdall Daily Intelligence Briefing`,
    ``,
    `Period: ${periodLabel}`,
    `Classification: ${row.classification}`,
    `Generated: ${new Date(row.generated_at).toISOString()}`,
    `Sources: ${row.intel_count} intel reports, ${row.transcript_count} transcripts, ${row.high_severity_count} high-severity`,
    ``,
    `Full briefing attached as ${format.toUpperCase()}.`,
    ``,
    `— Heimdall Intelligence Platform`
  ].join('\n')

  await transporter.sendMail({
    from: smtp.fromAddress,
    to: targets.join(', '),
    subject: `[${row.classification}] Daily Intelligence Briefing — ${periodLabel}`,
    text: summaryLines,
    attachments: [{
      filename: exported.filename,
      content: Buffer.from(exported.bytes)
    }]
  })

  log.info(`daily-briefing: emailed ${row.id} to ${targets.length} recipient(s) as ${format}`)
  return { ok: true, recipients: targets }
}
