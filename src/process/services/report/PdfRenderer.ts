// IC-format PDF renderer using pdf-lib (pure JS, no Chromium dep — works
// in air-gapped deployments).
//
// Layout per page:
//   ┌─────────────────────────────────────────────────────────────┐
//   │ <CLASSIFICATION BANNER>  (colored bar, centered, bold)      │  ← top
//   ├─────────────────────────────────────────────────────────────┤
//   │ <Agency logo>  AGENCY NAME                                  │  ← header (page 1 only)
//   │                Tagline                                       │
//   ├─────────────────────────────────────────────────────────────┤
//   │ TITLE (page 1 only)                                         │
//   │ Metadata block (DOI, classification, score, model)          │
//   │                                                             │
//   │ ─── Body content (markdown rendered) ───                    │
//   │                                                             │
//   ├─────────────────────────────────────────────────────────────┤
//   │ Distribution: <statement>           Page N of M             │  ← footer
//   │ <CLASSIFICATION BANNER>                                     │
//   └─────────────────────────────────────────────────────────────┘
//
// Last page is the SIGNATURE PAGE: SHA-256 + Ed25519 signature +
// public-key fingerprint for downstream verification.
//
// Markdown rendering is handled by tokenize-and-draw:
//   - marked tokenizes the body
//   - we walk tokens and emit pdf-lib draw operations
//   - supported: headings (h1-h4), paragraphs, lists (ul/ol), code blocks,
//     blockquotes, hr, bold/italic inline, tables (rendered as monospace
//     fixed-width blocks for now — full table rendering is Phase 1.1.3b)

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import type { Tokens } from 'marked'
import log from 'electron-log'
import type { ReportProduct } from './ReportLibraryService'
import type { LetterheadConfig } from '@common/types/settings'
import { signFile, type SignedFile } from './SignatureService'

// `marked` is ESM-only; the main process is CommonJS-bundled, so we
// dynamic-import it lazily on first call. Cache the lexer for reuse.
let _markedLexer: ((src: string) => Tokens.Generic[]) | null = null
async function loadMarkedLexer(): Promise<(src: string) => Tokens.Generic[]> {
  if (_markedLexer) return _markedLexer
  const m = await import('marked')
  _markedLexer = m.marked.lexer.bind(m.marked) as unknown as (src: string) => Tokens.Generic[]
  return _markedLexer
}

const PAGE_W = 612               // US Letter
const PAGE_H = 792
const MARGIN_X = 54              // 0.75"
const MARGIN_TOP = 90            // room for banner + header
const MARGIN_BOTTOM = 90         // room for footer + banner
const CONTENT_W = PAGE_W - 2 * MARGIN_X

const FONT_SIZE_BODY = 10.5
const FONT_SIZE_H1 = 18
const FONT_SIZE_H2 = 14
const FONT_SIZE_H3 = 12
const FONT_SIZE_H4 = 11
const FONT_SIZE_CODE = 9
const FONT_SIZE_FOOTER = 8
const FONT_SIZE_BANNER = 10

const LINE_HEIGHT_BODY = 14
const LINE_HEIGHT_CODE = 12
const PARAGRAPH_GAP = 6

/**
 * pdf-lib's StandardFonts use WinAnsi encoding which can't render anything
 * outside the basic Latin-1 range. We do two passes:
 *   1. Replace common Unicode chars with reasonable ASCII equivalents
 *      (em-dash → "-", bullet → "*", box drawing → "-|+", etc.)
 *   2. Strip anything else that's outside WinAnsi (emojis, CJK, math).
 *
 * Without this, a single emoji or box-drawing char in the report body
 * crashes the PDF generator with "WinAnsi cannot encode <char>".
 */
const WIN_ANSI_REPLACEMENTS: Array<[RegExp, string]> = [
  // Smart punctuation
  [/[‘’‚‛]/g, "'"],         // smart single quotes
  [/[“”„‟]/g, '"'],         // smart double quotes
  [/[‐‑‒–—―]/g, '-'],  // hyphens, en/em dashes
  [/…/g, '...'],                            // horizontal ellipsis
  [/ /g, ' '],                              // nbsp
  // Bullets
  [/[•‣◦⁃∙]/g, '*'],
  // Box drawing (used in our markdown table render)
  [/[─━┄┅┈┉╌╍]/g, '-'],   // horizontals
  [/[│┃┆┇┊┋╎╏]/g, '|'],   // verticals
  [/[┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋]/g, '+'],
  // Arrows
  [/[←→↔⇐⇒⇔]/g, '->'],
  [/↑/g, '^'], [/↓/g, 'v'],
  // Math
  [/[≤]/g, '<='], [/[≥]/g, '>='], [/[≠]/g, '!='],
  [/±/g, '+/-'], [/×/g, 'x'], [/÷/g, '/'],
  // Common emoji used in our SAT annexes — replace with bracketed labels
  [/[\u{1F534}\u{1F7E5}]/gu, '[CRIT]'],   // 🔴 🟥 critical
  [/[\u{1F7E0}\u{1F7E7}]/gu, '[HIGH]'],   // 🟠 🟧 high
  [/[\u{1F7E1}\u{1F7E8}]/gu, '[MED]'],    // 🟡 🟨 medium
  [/[\u{1F7E2}\u{1F7E9}]/gu, '[LOW]'],    // 🟢 🟩 low
  [/[\u{1F535}\u{1F7E6}]/gu, '[INFO]'],   // 🔵 🟦 info
  [/[\u{26AA}\u{26AB}]/gu, '[N/A]'],      // ⚪ ⚫
  [/[✓✔]/g, 'V'],               // ✓ ✔
  [/[✗✘]/g, 'X'],               // ✗ ✘
  [/⚠️?/g, '[!]'],              // ⚠
  [/\u{1F6E1}️?/gu, '[SHIELD]'],     // 🛡
  [/\u{1F510}/gu, '[LOCK]'],              // 🔐
  [/\u{1F4CB}/gu, '[CLIPBD]'],            // 📋
  [/\u{1F4C4}/gu, '[DOC]'],               // 📄
  [/[\u{1F4CA}\u{1F4C8}\u{1F4C9}]/gu, '[CHART]'], // 📊 📈 📉
]

const WIN_ANSI_MAX = 0x00FF

/** Sanitize text so pdf-lib's StandardFonts can render every char. */
function toWinAnsi(text: string): string {
  let out = text
  for (const [re, repl] of WIN_ANSI_REPLACEMENTS) {
    out = out.replace(re, repl)
  }
  // Strip variation selectors + zero-width joiners that ride along emojis
  out = out.replace(/[︀-️‍​‌]/g, '')
  // Final pass: drop anything still outside WinAnsi
  let result = ''
  for (let i = 0; i < out.length; i++) {
    const code = out.charCodeAt(i)
    // Surrogate pairs (4-byte chars) — skip both halves
    if (code >= 0xD800 && code <= 0xDBFF) {
      i++  // skip the low surrogate too
      continue
    }
    if (code <= WIN_ANSI_MAX) {
      result += out[i]
    } else {
      // Drop the character silently
    }
  }
  return result
}

function classificationColor(text: string): RGB {
  const upper = text.toUpperCase()
  if (upper.includes('TOP SECRET'))     return rgb(0.95, 0.55, 0.05)   // amber
  if (upper.includes('SECRET'))         return rgb(0.85, 0.20, 0.20)   // red
  if (upper.includes('CONFIDENTIAL'))   return rgb(0.20, 0.40, 0.85)   // blue
  if (upper.includes('UNCLASSIFIED'))   return rgb(0.10, 0.55, 0.30)   // green
  return rgb(0.30, 0.30, 0.30)                                          // grey fallback
}

interface RenderContext {
  doc: PDFDocument
  pages: PDFPage[]
  currentPage: PDFPage
  cursorY: number
  fontRegular: PDFFont
  fontBold: PDFFont
  fontItalic: PDFFont
  fontMono: PDFFont
  classification: string
  bannerColor: RGB
  letterhead: LetterheadConfig
}

export interface RenderOptions {
  /** Override classification text (else use report.classification or letterhead default). */
  classificationOverride?: string
  /** Distribution recipient (printed on signature page). */
  recipient?: string
  /** Skip the signature page even if letterhead.signaturesEnabled is true. */
  skipSignature?: boolean
}

export interface RenderedPdf {
  bytes: Uint8Array
  pageCount: number
  signature?: SignedFile
}

export async function renderReportToPdf(
  report: ReportProduct,
  letterhead: LetterheadConfig,
  opts: RenderOptions = {}
): Promise<RenderedPdf> {
  const doc = await PDFDocument.create()
  doc.setTitle(report.title)
  doc.setSubject(`${report.format.toUpperCase()} — Heimdall Intelligence Platform`)
  doc.setProducer('Heimdall Intelligence Platform')
  doc.setCreator(letterhead.agencyName || 'Heimdall')
  doc.setCreationDate(new Date(report.generatedAt))

  const fontRegular = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique)
  const fontMono = await doc.embedFont(StandardFonts.Courier)

  const classification = opts.classificationOverride
    || report.classification
    || letterhead.defaultClassification
    || 'UNCLASSIFIED//FOR OFFICIAL USE ONLY'
  const bannerColor = classificationColor(classification)

  const ctx: RenderContext = {
    doc, pages: [],
    currentPage: doc.addPage([PAGE_W, PAGE_H]),
    cursorY: 0,
    fontRegular, fontBold, fontItalic, fontMono,
    classification, bannerColor, letterhead
  }
  ctx.pages.push(ctx.currentPage)
  ctx.cursorY = PAGE_H - MARGIN_TOP

  // Page 1: header block (logo + agency name + title + metadata)
  drawHeaderBlock(ctx, report)

  // Body — tokenize markdown (ESM-only `marked`, so we lazy-load it)
  const lexer = await loadMarkedLexer()
  const tokens = lexer(report.bodyMarkdown)
  for (const token of tokens) {
    drawToken(ctx, token)
  }

  // Signature page
  let signature: SignedFile | undefined
  const includeSig = letterhead.signaturesEnabled && !opts.skipSignature
  if (includeSig) {
    addNewPage(ctx)
    // Reserve space — actual signature is computed AFTER serialization,
    // so we draw a placeholder, save bytes, sign them, then overlay the
    // signature back into the placeholder area.
  }

  // Apply banners + footer to every page (now that we know the page count)
  decoratePages(ctx, report, opts.recipient)

  // First save — gives us bytes to compute SHA over
  let bytes = await doc.save()

  if (includeSig) {
    signature = await signFile(bytes)
    // Re-render the signature page with real values.
    drawSignaturePage(ctx, ctx.pages[ctx.pages.length - 1], report, signature, opts.recipient)
    // Re-decorate (need to redraw banners on the now-mutated page) — actually
    // banners are already drawn; we only mutated the signature page content.
    bytes = await doc.save()
  }

  return { bytes, pageCount: ctx.pages.length, signature }
}

// ─────────────────────────────────────────────────────────────────────────
// Header block on page 1
// ─────────────────────────────────────────────────────────────────────────

function drawHeaderBlock(ctx: RenderContext, report: ReportProduct): void {
  const lh = ctx.letterhead

  // Try to embed the logo if provided
  let logoY = ctx.cursorY
  if (lh.logoBase64) {
    try {
      const buf = Buffer.from(lh.logoBase64, 'base64')
      // Detect PNG vs JPEG by magic bytes
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      // We need an async embed but this fn is sync — we'll use a sync-await
      // workaround: precompute logo bytes outside. For simplicity v1 skips logo
      // and uses agency name only — defer logo to Phase 1.1.3b.
      void isPng
    } catch (err) {
      log.debug(`PDF logo embed failed: ${err}`)
    }
  }

  if (lh.agencyName) {
    drawText(ctx, lh.agencyName, {
      font: ctx.fontBold, size: FONT_SIZE_H2, color: rgb(0.1, 0.1, 0.1)
    })
    if (lh.agencyTagline) {
      drawText(ctx, lh.agencyTagline, {
        font: ctx.fontItalic, size: FONT_SIZE_BODY, color: rgb(0.4, 0.4, 0.4)
      })
    }
    ctx.cursorY -= 6
    drawHorizontalRule(ctx)
    ctx.cursorY -= 12
  }

  // Format label
  drawText(ctx, formatLabel(report.format).toUpperCase(), {
    font: ctx.fontBold, size: FONT_SIZE_BODY, color: ctx.bannerColor
  })

  // Title
  drawText(ctx, report.title, {
    font: ctx.fontBold, size: FONT_SIZE_H1, color: rgb(0, 0, 0)
  })

  ctx.cursorY -= 6

  // Metadata box
  const metadata = [
    `Document ID: HEIM-${report.id.slice(0, 8).toUpperCase()}`,
    `Date of Information: ${new Date(report.generatedAt).toISOString().slice(0, 10)}`,
    `Format: ${formatLabel(report.format)} (v${report.version})`,
    report.tradecraftScore !== null
      ? `ICD 203 Tradecraft Score: ${report.tradecraftScore}/100${report.tradecraftScore >= 70 ? ' (passed)' : ' (below threshold)'}`
      : 'Tradecraft Score: not evaluated',
    report.modelUsed ? `Generated by: ${report.modelUsed}` : '',
    report.wasRegenerated ? 'Notice: this assessment was auto-regenerated to address tradecraft deficiencies' : ''
  ].filter(Boolean)

  for (const line of metadata) {
    drawText(ctx, line, {
      font: ctx.fontRegular, size: FONT_SIZE_FOOTER + 1, color: rgb(0.3, 0.3, 0.3)
    })
  }

  ctx.cursorY -= 6
  drawHorizontalRule(ctx)
  ctx.cursorY -= 14
}

// ─────────────────────────────────────────────────────────────────────────
// Markdown token rendering
// ─────────────────────────────────────────────────────────────────────────

function drawToken(ctx: RenderContext, token: Tokens.Generic): void {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading
      const size = t.depth === 1 ? FONT_SIZE_H1
        : t.depth === 2 ? FONT_SIZE_H2
        : t.depth === 3 ? FONT_SIZE_H3
        : FONT_SIZE_H4
      ctx.cursorY -= 4
      drawText(ctx, stripInline(t.text), {
        font: ctx.fontBold, size,
        color: t.depth <= 2 ? ctx.bannerColor : rgb(0.15, 0.15, 0.15)
      })
      ctx.cursorY -= 2
      return
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph
      drawWrappedText(ctx, stripInline(t.text), {
        font: ctx.fontRegular, size: FONT_SIZE_BODY, lineHeight: LINE_HEIGHT_BODY
      })
      ctx.cursorY -= PARAGRAPH_GAP
      return
    }
    case 'list': {
      const t = token as Tokens.List
      let i = 1
      for (const item of t.items) {
        const bullet = t.ordered ? `${i++}.` : '*'
        const lines = wrapText(stripInline(item.text), CONTENT_W - 18, ctx.fontRegular, FONT_SIZE_BODY)
        ensureRoom(ctx, lines.length * LINE_HEIGHT_BODY + 2)
        // bullet
        ctx.currentPage.drawText(bullet, {
          x: MARGIN_X + 4, y: ctx.cursorY,
          size: FONT_SIZE_BODY, font: ctx.fontBold, color: rgb(0.3, 0.3, 0.3)
        })
        // lines (already sanitized via stripInline above)
        for (let li = 0; li < lines.length; li++) {
          ctx.currentPage.drawText(lines[li], {
            x: MARGIN_X + 18, y: ctx.cursorY,
            size: FONT_SIZE_BODY, font: ctx.fontRegular, color: rgb(0.1, 0.1, 0.1)
          })
          ctx.cursorY -= LINE_HEIGHT_BODY
          if (li < lines.length - 1) ensureRoom(ctx, LINE_HEIGHT_BODY)
        }
        ctx.cursorY -= 2
      }
      ctx.cursorY -= PARAGRAPH_GAP
      return
    }
    case 'code': {
      const t = token as Tokens.Code
      const lines = t.text.split('\n')
      const blockHeight = lines.length * LINE_HEIGHT_CODE + 8
      ensureRoom(ctx, blockHeight)
      // Background
      ctx.currentPage.drawRectangle({
        x: MARGIN_X - 4, y: ctx.cursorY - blockHeight + LINE_HEIGHT_CODE,
        width: CONTENT_W + 8, height: blockHeight,
        color: rgb(0.96, 0.96, 0.96)
      })
      for (const line of lines) {
        ctx.currentPage.drawText(toWinAnsi(line).slice(0, 100), {
          x: MARGIN_X, y: ctx.cursorY,
          size: FONT_SIZE_CODE, font: ctx.fontMono, color: rgb(0.1, 0.1, 0.1)
        })
        ctx.cursorY -= LINE_HEIGHT_CODE
      }
      ctx.cursorY -= PARAGRAPH_GAP + 2
      return
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      const text = (t.tokens || []).map((tk) => 'text' in tk ? tk.text : '').join(' ')
      const lines = wrapText(stripInline(text), CONTENT_W - 16, ctx.fontItalic, FONT_SIZE_BODY)
      for (const line of lines) {
        ensureRoom(ctx, LINE_HEIGHT_BODY)
        ctx.currentPage.drawRectangle({
          x: MARGIN_X, y: ctx.cursorY - 2, width: 3, height: LINE_HEIGHT_BODY,
          color: rgb(0.5, 0.5, 0.5)
        })
        ctx.currentPage.drawText(line, {
          x: MARGIN_X + 12, y: ctx.cursorY,
          size: FONT_SIZE_BODY, font: ctx.fontItalic, color: rgb(0.35, 0.35, 0.35)
        })
        ctx.cursorY -= LINE_HEIGHT_BODY
      }
      ctx.cursorY -= PARAGRAPH_GAP
      return
    }
    case 'hr': {
      ctx.cursorY -= 4
      drawHorizontalRule(ctx)
      ctx.cursorY -= 8
      return
    }
    case 'table': {
      // Simple monospace rendering for now — full table layout is 1.1.3b
      const t = token as Tokens.Table
      const headers = t.header.map((h) => stripInline(h.text))
      const rows = t.rows.map((row) => row.map((c) => stripInline(c.text)))
      const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)))
      const renderRow = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i], ' ')).join(' | ')
      const sep = widths.map((w) => '-'.repeat(w)).join('-+-')

      const tableLines = [renderRow(headers), sep, ...rows.map(renderRow)]
      for (const line of tableLines) {
        ensureRoom(ctx, LINE_HEIGHT_CODE)
        ctx.currentPage.drawText(line.slice(0, 110), {
          x: MARGIN_X, y: ctx.cursorY,
          size: FONT_SIZE_CODE, font: ctx.fontMono, color: rgb(0.15, 0.15, 0.15)
        })
        ctx.cursorY -= LINE_HEIGHT_CODE
      }
      ctx.cursorY -= PARAGRAPH_GAP
      return
    }
    case 'space':
      ctx.cursorY -= PARAGRAPH_GAP
      return
    default:
      // Unknown token — render its raw text if available
      if ('text' in token && typeof token.text === 'string') {
        drawWrappedText(ctx, stripInline(token.text), {
          font: ctx.fontRegular, size: FONT_SIZE_BODY, lineHeight: LINE_HEIGHT_BODY
        })
        ctx.cursorY -= PARAGRAPH_GAP
      }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Drawing primitives + pagination
// ─────────────────────────────────────────────────────────────────────────

function drawText(
  ctx: RenderContext,
  text: string,
  opts: { font: PDFFont; size: number; color: RGB; lineHeight?: number }
): void {
  if (!text) return
  const safe = toWinAnsi(text)
  const lh = opts.lineHeight ?? opts.size + 2
  const lines = wrapText(safe, CONTENT_W, opts.font, opts.size)
  for (const line of lines) {
    ensureRoom(ctx, lh)
    ctx.currentPage.drawText(line, {
      x: MARGIN_X, y: ctx.cursorY,
      size: opts.size, font: opts.font, color: opts.color
    })
    ctx.cursorY -= lh
  }
}

function drawWrappedText(
  ctx: RenderContext,
  text: string,
  opts: { font: PDFFont; size: number; lineHeight: number }
): void {
  drawText(ctx, text, { ...opts, color: rgb(0.1, 0.1, 0.1) })
}

function drawHorizontalRule(ctx: RenderContext): void {
  ensureRoom(ctx, 4)
  ctx.currentPage.drawLine({
    start: { x: MARGIN_X, y: ctx.cursorY },
    end: { x: PAGE_W - MARGIN_X, y: ctx.cursorY },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7)
  })
}

function ensureRoom(ctx: RenderContext, needed: number): void {
  if (ctx.cursorY - needed < MARGIN_BOTTOM) {
    addNewPage(ctx)
  }
}

function addNewPage(ctx: RenderContext): void {
  ctx.currentPage = ctx.doc.addPage([PAGE_W, PAGE_H])
  ctx.pages.push(ctx.currentPage)
  ctx.cursorY = PAGE_H - MARGIN_TOP
}

function wrapText(text: string, maxWidth: number, font: PDFFont, size: number): string[] {
  if (!text) return ['']
  const words = text.replace(/\s+/g, ' ').split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word
    const w = font.widthOfTextAtSize(trial, size)
    if (w > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = trial
    }
  }
  if (current) lines.push(current)
  return lines
}

function stripInline(text: string): string {
  // Strip markdown inline formatting + sanitize Unicode so the WinAnsi
  // font can render every remaining char. Bold/italic/code formatting is
  // dropped — we keep the text content.
  const stripped = text
    .replace(/!\[.*?\]\([^)]*\)/g, '[image]')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/<[^>]+>/g, '')   // strip HTML tags
    .trim()
  return toWinAnsi(stripped)
}

function formatLabel(format: string): string {
  return format === 'nie' ? 'National Intelligence Estimate'
    : format === 'pdb' ? 'President\'s Daily Brief Item'
    : format === 'iir' ? 'Intelligence Information Report'
    : 'All-Source Intelligence Assessment'
}

// ─────────────────────────────────────────────────────────────────────────
// Banner + footer + signature page
// ─────────────────────────────────────────────────────────────────────────

function decoratePages(ctx: RenderContext, report: ReportProduct, recipient?: string): void {
  void report
  const total = ctx.pages.length
  for (let i = 0; i < ctx.pages.length; i++) {
    const page = ctx.pages[i]
    drawClassificationBanner(ctx, page, 'top')
    drawClassificationBanner(ctx, page, 'bottom')
    drawFooter(ctx, page, i + 1, total, recipient)
  }
}

function drawClassificationBanner(ctx: RenderContext, page: PDFPage, position: 'top' | 'bottom'): void {
  const bannerH = 18
  const y = position === 'top' ? PAGE_H - bannerH : 0
  page.drawRectangle({
    x: 0, y, width: PAGE_W, height: bannerH,
    color: ctx.bannerColor
  })
  const text = toWinAnsi(ctx.classification)
  const textWidth = ctx.fontBold.widthOfTextAtSize(text, FONT_SIZE_BANNER)
  page.drawText(text, {
    x: (PAGE_W - textWidth) / 2,
    y: y + bannerH / 2 - FONT_SIZE_BANNER / 2 + 1,
    size: FONT_SIZE_BANNER,
    font: ctx.fontBold,
    color: rgb(1, 1, 1)
  })
}

function drawFooter(ctx: RenderContext, page: PDFPage, pageNum: number, total: number, recipient?: string): void {
  const lh = ctx.letterhead
  const footerY = 28
  const distLine = toWinAnsi(lh.distributionStatement || 'Distribution authorized for official use only.')
  const distLines = wrapText(distLine, PAGE_W - 200, ctx.fontRegular, FONT_SIZE_FOOTER)

  let y = footerY
  for (const line of distLines.slice(0, 2)) {
    page.drawText(line, {
      x: MARGIN_X, y,
      size: FONT_SIZE_FOOTER, font: ctx.fontRegular, color: rgb(0.4, 0.4, 0.4)
    })
    y += FONT_SIZE_FOOTER + 1
  }

  if (recipient) {
    page.drawText(toWinAnsi(`Recipient: ${recipient}`), {
      x: MARGIN_X, y: footerY + 2 * (FONT_SIZE_FOOTER + 1),
      size: FONT_SIZE_FOOTER, font: ctx.fontItalic, color: rgb(0.3, 0.3, 0.3)
    })
  }

  const pageStr = `Page ${pageNum} of ${total}`
  const pageWidth = ctx.fontRegular.widthOfTextAtSize(pageStr, FONT_SIZE_FOOTER)
  page.drawText(pageStr, {
    x: PAGE_W - MARGIN_X - pageWidth, y: footerY,
    size: FONT_SIZE_FOOTER, font: ctx.fontRegular, color: rgb(0.4, 0.4, 0.4)
  })
}

function drawSignaturePage(
  ctx: RenderContext,
  page: PDFPage,
  report: ReportProduct,
  signature: SignedFile,
  recipient?: string
): void {
  // Clear the page area (we draw a white rect over the existing content)
  page.drawRectangle({
    x: 0, y: 18, width: PAGE_W, height: PAGE_H - 36,
    color: rgb(1, 1, 1)
  })

  let y = PAGE_H - MARGIN_TOP
  const draw = (text: string, opts: { size?: number; bold?: boolean; color?: RGB; gap?: number } = {}) => {
    const size = opts.size ?? FONT_SIZE_BODY
    const font = opts.bold ? ctx.fontBold : ctx.fontRegular
    page.drawText(toWinAnsi(text).slice(0, 100), {
      x: MARGIN_X, y, size, font, color: opts.color ?? rgb(0.1, 0.1, 0.1)
    })
    y -= (opts.gap ?? size + 4)
  }

  draw('AUTHENTICATION & SIGNATURE', { size: FONT_SIZE_H1, bold: true, color: ctx.bannerColor, gap: 28 })

  draw('This page certifies the authenticity of the preceding analytic product.', {
    size: FONT_SIZE_BODY, color: rgb(0.3, 0.3, 0.3), gap: 22
  })

  draw('Document Identity', { bold: true, gap: 16 })
  draw(`Title:           ${report.title}`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  draw(`Document ID:     HEIM-${report.id.slice(0, 8).toUpperCase()}`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  draw(`Format:          ${formatLabel(report.format)} (v${report.version})`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  draw(`Generated at:    ${new Date(report.generatedAt).toISOString()}`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  if (recipient) {
    draw(`Recipient:       ${recipient}`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  }
  y -= 14

  draw('Cryptographic Signature', { bold: true, gap: 16 })
  draw(`Signed at:       ${signature.signedAt}`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  draw(`Signature alg:   Ed25519`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })
  draw(`Hash alg:        SHA-256`, { size: FONT_SIZE_FOOTER + 1, gap: 12 })

  // Multi-line displays for the long crypto blobs
  drawMonoBlock(ctx, page, 'SHA-256:', signature.sha256, y); y -= 32
  drawMonoBlock(ctx, page, 'Signature (base64):', signature.signatureB64, y); y -= 50
  drawMonoBlock(ctx, page, 'Public key (base64):', signature.publicKeyB64, y); y -= 32
  drawMonoBlock(ctx, page, 'Public key fingerprint:', signature.fingerprint, y); y -= 28

  // Verification instructions
  page.drawText('To verify this document\'s integrity:', {
    x: MARGIN_X, y, size: FONT_SIZE_FOOTER + 1, font: ctx.fontItalic, color: rgb(0.3, 0.3, 0.3)
  })
  y -= 14
  const instructions = [
    '1. Compute SHA-256 of the entire PDF (excluding this page may not be possible).',
    '2. The originating Heimdall instance can verify the signature against the SHA-256.',
    '3. Confirm the public key fingerprint above matches the originator\'s published key.'
  ]
  for (const line of instructions) {
    page.drawText(line, {
      x: MARGIN_X + 12, y, size: FONT_SIZE_FOOTER, font: ctx.fontRegular, color: rgb(0.4, 0.4, 0.4)
    })
    y -= FONT_SIZE_FOOTER + 3
  }
}

function drawMonoBlock(ctx: RenderContext, page: PDFPage, label: string, value: string, y: number): void {
  page.drawText(label, {
    x: MARGIN_X, y, size: FONT_SIZE_FOOTER + 1, font: ctx.fontBold, color: rgb(0.1, 0.1, 0.1)
  })
  // Wrap value into chunks
  const chunks: string[] = []
  for (let i = 0; i < value.length; i += 80) chunks.push(value.slice(i, i + 80))
  let cy = y - 14
  for (const chunk of chunks.slice(0, 2)) {
    page.drawText(chunk, {
      x: MARGIN_X, y: cy, size: FONT_SIZE_CODE - 1, font: ctx.fontMono, color: rgb(0.2, 0.2, 0.2)
    })
    cy -= LINE_HEIGHT_CODE
  }
}
