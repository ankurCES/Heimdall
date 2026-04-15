import { BrowserWindow, dialog } from 'electron'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import { createCipheriv, randomBytes, scryptSync } from 'crypto'
import { auditChainService } from '../audit/AuditChainService'
import { dpbService } from '../iw/DpbService'
import { achService, type AchSession, SCORE_LABELS } from '../ach/AchService'
import { getDatabase } from '../database'
import log from 'electron-log'

/**
 * Multi-format export service (Theme 9.4 of the agency roadmap).
 *
 * Renders any analytical product (DPB brief, ACH session, preliminary
 * report, HUMINT report, raw intel) to a chosen format:
 *
 *   pdf      — via Electron's built-in webContents.printToPDF; no native
 *              deps. Renders the markdown source through an offscreen
 *              BrowserWindow with classification banner styling.
 *   markdown — the raw markdown body
 *   json     — structured payload for downstream tools / archives
 *   intrep   — human-readable approximation of NATO STANAG 5500/4774
 *              INTREP/INTSUM format. Not bit-perfect ADatP-3 XML but
 *              follows the section conventions agencies expect.
 *   bundle   — AES-256-GCM-encrypted ZIP-like blob containing all of
 *              the above. Passphrase-protected; Heimdall imports its
 *              own format on the receiving side.
 *
 * Every export is hash-chain logged via auditChainService — entity_type
 * = the source artifact, payload includes format + bytes + classification.
 * This satisfies Theme 10.4 "every export goes through one audit funnel".
 */

export type ExportFormat = 'pdf' | 'markdown' | 'json' | 'intrep' | 'bundle'

export interface ExportRequest {
  format: ExportFormat
  /** What's being exported: 'dpb' | 'ach' | 'preliminary' | 'humint' | 'intel'. */
  source_type: string
  source_id: string
  /** Optional override of the suggested filename. */
  filename?: string
  /** Required for `bundle` format. */
  passphrase?: string
}

export interface ExportResult {
  ok: boolean
  path?: string
  bytes?: number
  error?: string
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  UNCLASSIFIED: '#15803d',
  CONFIDENTIAL: '#1d4ed8',
  SECRET:       '#b91c1c',
  'TOP SECRET': '#c2410c'
}

class ExportServiceImpl {
  /**
   * Top-level entry point — fetch the artifact, render to the requested
   * format, prompt the user for a save location, write the file, and
   * append a chain-log entry.
   */
  async export(req: ExportRequest): Promise<ExportResult> {
    const artifact = this.fetchArtifact(req.source_type, req.source_id)
    if (!artifact) {
      return { ok: false, error: `${req.source_type} not found: ${req.source_id}` }
    }

    let body: Buffer
    let extension: string
    let mimeFilter: { name: string; extensions: string[] }

    switch (req.format) {
      case 'pdf':
        body = await this.renderPdf(artifact)
        extension = 'pdf'
        mimeFilter = { name: 'PDF', extensions: ['pdf'] }
        break
      case 'markdown':
        body = Buffer.from(this.renderMarkdown(artifact), 'utf8')
        extension = 'md'
        mimeFilter = { name: 'Markdown', extensions: ['md'] }
        break
      case 'json':
        body = Buffer.from(JSON.stringify(artifact, null, 2), 'utf8')
        extension = 'json'
        mimeFilter = { name: 'JSON', extensions: ['json'] }
        break
      case 'intrep':
        body = Buffer.from(this.renderIntrep(artifact), 'utf8')
        extension = 'txt'
        mimeFilter = { name: 'NATO INTREP/INTSUM', extensions: ['txt'] }
        break
      case 'bundle': {
        if (!req.passphrase || req.passphrase.length < 8) {
          return { ok: false, error: 'Bundle export requires a passphrase of at least 8 characters.' }
        }
        body = await this.renderBundle(artifact, req.passphrase)
        extension = 'heimdall.enc'
        mimeFilter = { name: 'Encrypted Bundle', extensions: ['enc'] }
        break
      }
      default:
        return { ok: false, error: `Unknown format: ${req.format}` }
    }

    const suggested = req.filename || this.suggestedFilename(artifact, extension)
    const result = await dialog.showSaveDialog({
      defaultPath: suggested,
      filters: [mimeFilter, { name: 'All files', extensions: ['*'] }]
    })

    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'Export cancelled' }
    }

    const dir = dirname(result.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(result.filePath, body)

    auditChainService.append('export.write', {
      entityType: req.source_type,
      entityId: req.source_id,
      classification: artifact.classification || 'UNCLASSIFIED',
      payload: {
        format: req.format,
        bytes: body.length,
        filename: result.filePath.split('/').pop(),
        encrypted: req.format === 'bundle'
      }
    })

    log.info(`Export: ${req.source_type}:${req.source_id.slice(0, 8)} as ${req.format} → ${result.filePath} (${body.length} bytes)`)
    return { ok: true, path: result.filePath, bytes: body.length }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Artifact fetch — normalize every source type into a common shape
  // ─────────────────────────────────────────────────────────────────────

  private fetchArtifact(sourceType: string, sourceId: string): NormalizedArtifact | null {
    const db = getDatabase()
    if (sourceType === 'dpb') {
      const row = dpbService.get(sourceId)
      if (!row) return null
      let body_json: Record<string, unknown> | null = null
      try { body_json = row.body_json ? JSON.parse(row.body_json) : null } catch {}
      return {
        kind: 'dpb',
        id: row.id,
        title: 'Daily Intelligence Brief',
        classification: row.classification,
        generated_at: row.generated_at,
        body_md: row.body_md,
        body_json
      }
    }
    if (sourceType === 'ach') {
      const session = achService.getSession(sourceId)
      if (!session) return null
      return {
        kind: 'ach',
        id: session.id,
        title: session.title,
        classification: session.classification,
        generated_at: session.updated_at,
        body_md: this.renderAchMarkdown(session),
        body_json: session as unknown as Record<string, unknown>
      }
    }
    if (sourceType === 'preliminary') {
      const row = db.prepare(`
        SELECT id, title, content, status, classification, source_report_ids, created_at, updated_at
        FROM preliminary_reports WHERE id = ?
      `).get(sourceId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        kind: 'preliminary',
        id: row.id as string,
        title: row.title as string,
        classification: (row.classification as string) || 'UNCLASSIFIED',
        generated_at: (row.updated_at as number) || (row.created_at as number),
        body_md: row.content as string,
        body_json: row as Record<string, unknown>
      }
    }
    if (sourceType === 'humint') {
      const row = db.prepare(`
        SELECT id, analyst_notes, findings, confidence, classification, source_report_ids, created_at, updated_at
        FROM humint_reports WHERE id = ?
      `).get(sourceId) as Record<string, unknown> | undefined
      if (!row) return null
      const md = `## Findings\n\n${row.findings}\n\n## Analyst Notes\n\n${row.analyst_notes}\n\n_Confidence: ${row.confidence}_`
      return {
        kind: 'humint',
        id: row.id as string,
        title: `HUMINT — ${(row.findings as string).slice(0, 60)}`,
        classification: (row.classification as string) || 'UNCLASSIFIED',
        generated_at: (row.updated_at as number) || (row.created_at as number),
        body_md: md,
        body_json: row as Record<string, unknown>
      }
    }
    if (sourceType === 'intel') {
      const row = db.prepare(`
        SELECT r.*, s.admiralty_reliability AS source_reliability
        FROM intel_reports r LEFT JOIN sources s ON r.source_id = s.id
        WHERE r.id = ?
      `).get(sourceId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        kind: 'intel',
        id: row.id as string,
        title: row.title as string,
        classification: (row.classification as string) || 'UNCLASSIFIED',
        generated_at: row.created_at as number,
        body_md: row.content as string,
        body_json: row as Record<string, unknown>
      }
    }
    return null
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Renderers
  // ─────────────────────────────────────────────────────────────────────

  private renderMarkdown(a: NormalizedArtifact): string {
    return `<!--\n  Heimdall export\n  Type: ${a.kind}\n  ID: ${a.id}\n  Classification: ${a.classification}\n  Generated: ${new Date(a.generated_at).toISOString()}\n-->\n\n${a.body_md}\n`
  }

  /**
   * Render markdown to PDF via Electron's offscreen BrowserWindow +
   * webContents.printToPDF. Pure built-in API; no puppeteer / no native
   * deps. Wraps the body in classification banners.
   */
  private async renderPdf(a: NormalizedArtifact): Promise<Buffer> {
    const html = this.htmlForPdf(a)
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, sandbox: true, javascript: false, nodeIntegration: false, contextIsolation: true }
    })
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      const data = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
        margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
        landscape: false
      })
      return data
    } finally {
      win.destroy()
    }
  }

  private htmlForPdf(a: NormalizedArtifact): string {
    const banner = a.classification || 'UNCLASSIFIED'
    const bannerColor = CLASSIFICATION_COLORS[banner] || CLASSIFICATION_COLORS.UNCLASSIFIED
    const bodyHtml = this.markdownToHtml(a.body_md)
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(a.title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f2937; margin: 0; }
  .banner { background: ${bannerColor}; color: white; text-align: center; padding: 4px 8px; font-weight: 700; letter-spacing: 0.3em; font-size: 9pt; text-transform: uppercase; }
  .meta { font-size: 9pt; color: #6b7280; padding: 8px 16px; border-bottom: 1px solid #e5e7eb; }
  .body { padding: 16px; }
  h1, h2, h3 { color: #111827; margin-top: 1.2em; margin-bottom: 0.4em; }
  h1 { font-size: 16pt; border-bottom: 2px solid #111827; padding-bottom: 4px; }
  h2 { font-size: 13pt; }
  h3 { font-size: 11pt; }
  p { margin: 0.4em 0; }
  ul, ol { margin: 0.4em 0; padding-left: 1.6em; }
  li { margin: 0.15em 0; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 2px; font-family: "SF Mono", Menlo, monospace; font-size: 9pt; }
  pre { background: #f3f4f6; padding: 8px 12px; border-radius: 4px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 10pt; }
  th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; }
  th { background: #f9fafb; }
  blockquote { border-left: 3px solid #9ca3af; margin: 0.6em 0; padding: 0.2em 0 0.2em 0.8em; color: #4b5563; }
</style></head>
<body>
  <div class="banner">${banner}</div>
  <div class="meta">
    <strong>${escapeHtml(a.title)}</strong>
    &nbsp;·&nbsp; ${a.kind.toUpperCase()}
    &nbsp;·&nbsp; ID ${a.id.slice(0, 12)}
    &nbsp;·&nbsp; Generated ${new Date(a.generated_at).toUTCString()}
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="banner">${banner}</div>
</body></html>`
  }

  /** Minimal markdown → HTML. Good enough for our internal artifacts;
      not a CommonMark parser. Handles headings, bold/italic, lists,
      code, links, paragraphs. */
  private markdownToHtml(md: string): string {
    const lines = md.split('\n')
    const out: string[] = []
    let inList: 'ul' | 'ol' | null = null
    let inPre = false
    for (const raw of lines) {
      const line = raw

      if (line.startsWith('```')) {
        if (!inPre) { out.push('<pre><code>'); inPre = true }
        else { out.push('</code></pre>'); inPre = false }
        continue
      }
      if (inPre) { out.push(escapeHtml(line)); continue }

      if (/^#{1,3}\s/.test(line)) {
        if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null }
        const level = line.match(/^#+/)![0].length
        const text = inlineMd(line.replace(/^#+\s+/, ''))
        out.push(`<h${level}>${text}</h${level}>`)
        continue
      }

      if (/^\s*[-*]\s/.test(line)) {
        if (inList !== 'ul') { if (inList === 'ol') out.push('</ol>'); out.push('<ul>'); inList = 'ul' }
        out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
        continue
      }
      if (/^\s*\d+\.\s/.test(line)) {
        if (inList !== 'ol') { if (inList === 'ul') out.push('</ul>'); out.push('<ol>'); inList = 'ol' }
        out.push(`<li>${inlineMd(line.replace(/^\s*\d+\.\s+/, ''))}</li>`)
        continue
      }

      if (line.trim() === '') {
        if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null }
        out.push('')
        continue
      }

      if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null }
      out.push(`<p>${inlineMd(line)}</p>`)
    }
    if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>')
    if (inPre) out.push('</code></pre>')
    return out.join('\n')
  }

  /** NATO STANAG 5500-style INTREP/INTSUM textual approximation. */
  private renderIntrep(a: NormalizedArtifact): string {
    const dtg = formatDtg(a.generated_at)
    const lines: string[] = []
    lines.push('FM   HEIMDALL/USR')
    lines.push('TO   ALL')
    lines.push(`BT`)
    lines.push(`SECRET`)
    lines.push(`UNCLASSIFIED // FOR EXAMPLE — replace with originator`)
    lines.push(``)
    lines.push(`SUBJ/${a.kind === 'dpb' ? 'INTSUM' : 'INTREP'}/${a.title.toUpperCase().slice(0, 80)}//`)
    lines.push(`DTG/${dtg}//`)
    lines.push(`CLAS/${(a.classification || 'UNCLASSIFIED')}//`)
    lines.push(`SCEN/PEACETIME//`)
    lines.push(``)
    lines.push(`GENTEXT/SITUATION/`)
    lines.push(this.wrapLines(stripMarkdown(a.body_md), 70))
    lines.push(`//`)
    lines.push(``)
    lines.push(`AKNLDG/Y//`)
    lines.push(`BT`)
    lines.push(`#${a.id.slice(0, 8).toUpperCase()}`)
    lines.push(``)
    lines.push(`-- end-of-message --`)
    return lines.join('\n')
  }

  private wrapLines(text: string, width: number): string {
    const result: string[] = []
    for (const para of text.split('\n')) {
      if (para.length <= width) { result.push(para); continue }
      const words = para.split(/\s+/)
      let line = ''
      for (const w of words) {
        if ((line + ' ' + w).length > width) {
          result.push(line)
          line = w
        } else {
          line = line ? `${line} ${w}` : w
        }
      }
      if (line) result.push(line)
    }
    return result.join('\n')
  }

  /** Render an ACH session as markdown — the matrix becomes a table. */
  private renderAchMarkdown(session: AchSession): string {
    const out: string[] = []
    out.push(`# ACH Session: ${session.title}`)
    out.push(``)
    out.push(`**Classification:** ${session.classification}`)
    if (session.question) out.push(`**Question:** ${session.question}`)
    out.push(`**Status:** ${session.status}`)
    out.push(``)

    const hyps = session.hypotheses || []
    const evid = session.evidence || []
    const scoreMap = new Map<string, string>()
    for (const s of session.scores || []) scoreMap.set(`${s.hypothesis_id}:${s.evidence_id}`, s.score)

    out.push(`## Hypotheses`)
    out.push(``)
    for (const h of hyps) {
      out.push(`- **H${h.ordinal}** ${h.label}${h.source === 'agent' ? ' _(AI-suggested)_' : ''}`)
      if (h.description) out.push(`  ${h.description}`)
    }
    out.push(``)

    out.push(`## Evidence`)
    out.push(``)
    for (const e of evid) {
      out.push(`- **E${e.ordinal}** ${e.claim}`)
      if (e.source_label) out.push(`  _via ${e.source_label}_`)
    }
    out.push(``)

    out.push(`## Scoring Matrix`)
    out.push(``)
    if (hyps.length > 0 && evid.length > 0) {
      out.push(`| Evidence | ${hyps.map((h) => `H${h.ordinal}`).join(' | ')} |`)
      out.push(`|----------|${hyps.map(() => '----').join('|')}|`)
      for (const e of evid) {
        const cells = hyps.map((h) => scoreMap.get(`${h.id}:${e.id}`) || '—')
        out.push(`| E${e.ordinal} ${e.claim.slice(0, 50)} | ${cells.join(' | ')} |`)
      }
      out.push(``)
      out.push(`Score legend: ${Object.entries(SCORE_LABELS).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
    }
    out.push(``)

    if (session.analysis?.leading_hypothesis_id) {
      const leading = hyps.find((h) => h.id === session.analysis!.leading_hypothesis_id)
      if (leading) {
        out.push(`## Leading Hypothesis (per Heuer principle)`)
        out.push(``)
        out.push(`**${leading.label}**`)
        out.push(``)
        out.push(`*The hypothesis with the least disconfirming weighted evidence.*`)
      }
    }

    if (session.conclusion) {
      out.push(``)
      out.push(`## Analyst Conclusion`)
      out.push(``)
      out.push(session.conclusion)
    }

    return out.join('\n')
  }

  /**
   * Encrypted bundle: AES-256-GCM-encrypted payload containing the
   * markdown + JSON + INTREP + manifest. Heimdall imports its own
   * format on the receiving side via a future Import action.
   *
   * Layout (all big-endian):
   *   magic     "HEIMENC1"   (8 bytes)
   *   salt      16 bytes
   *   iv        12 bytes
   *   tagBytes  16 bytes
   *   cipher    N bytes
   */
  private async renderBundle(a: NormalizedArtifact, passphrase: string): Promise<Buffer> {
    const manifest = {
      kind: a.kind,
      id: a.id,
      title: a.title,
      classification: a.classification,
      generated_at: a.generated_at,
      bundle_format_version: 1
    }
    const payload = JSON.stringify({
      manifest,
      markdown: a.body_md,
      json: a.body_json,
      intrep: this.renderIntrep(a)
    })

    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    return Buffer.concat([
      Buffer.from('HEIMENC1', 'utf8'),
      salt,
      iv,
      tag,
      enc
    ])
  }

  private suggestedFilename(a: NormalizedArtifact, ext: string): string {
    const date = new Date(a.generated_at).toISOString().slice(0, 10)
    const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '')
    return `heimdall-${a.kind}-${date}-${slug || a.id.slice(0, 8)}.${ext}`
  }
}

interface NormalizedArtifact {
  kind: 'dpb' | 'ach' | 'preliminary' | 'humint' | 'intel'
  id: string
  title: string
  classification: string
  generated_at: number
  body_md: string
  body_json: Record<string, unknown> | null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineMd(s: string): string {
  let out = escapeHtml(s)
  // bold then italic then code then links
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return out
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '- ')
    .replace(/^\s*\d+\.\s+/gm, '* ')
}

/** NATO Date-Time Group format: DDHHMMZ MON YY (e.g. 152130Z APR 26). */
function formatDtg(ts: number): string {
  const d = new Date(ts)
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${dd}${hh}${mm}Z ${months[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
}

export const exportService = new ExportServiceImpl()
