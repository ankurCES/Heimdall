import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { llmService } from '../llm/LlmService'

/**
 * Theme 8.3 — Document OCR + redaction detector.
 *
 * Engine priority:
 *   PDF files        → pdfjs-dist extracts the embedded text layer first
 *                      (perfect recall for machine-generated PDFs, no
 *                      vision cost). On empty text layer, the PDF is
 *                      flagged as "scan-only" — full raster-to-OCR of
 *                      PDFs still needs `canvas` which we've avoided.
 *   Image files      → 1. LLM vision (if configured): primary extractor
 *                         — handles handwriting, complex layouts,
 *                         multi-language, skewed text. Also catches
 *                         redaction boxes the analyst would otherwise
 *                         miss via our heuristic.
 *                      2. tesseract.js fallback: pure-JS OCR if the LLM
 *                         path fails, is not configured, or returns
 *                         empty/short text. Reliable for clean machine
 *                         text, limited on everything else.
 *
 * Each extraction records which engine actually succeeded in the
 * ocr_engine column; UIs can show this for provenance.
 *
 * Redaction heuristic — counts runs of ≥6 contiguous "█" characters OR
 * long whitespace stretches on otherwise-text lines. LLM-vision
 * extractions also include whatever the model flagged as a redaction
 * in its own output.
 *
 * On ingest, substantial documents (≥500 chars) automatically create an
 * intel_reports row (source='document-ocr') so RAG / search / the agent
 * can operate on the extracted text.
 */

const VISION_SYSTEM = `You extract ALL text from the supplied image, preserving the original reading order. Rules:
- Output the extracted text only — no summary, no commentary, no markdown preamble.
- Preserve paragraph breaks with blank lines. Preserve line breaks that matter (lists, headers, tables).
- Render tables as pipe-separated rows, one per line.
- If a region has been redacted (black box / blacked-out text), insert the literal token [REDACTED] in place.
- If a region is unreadable (blurred, too small, cut off) insert [UNREADABLE].
- Do NOT translate. Do NOT correct errors in the source.
- Do NOT add information that is not visibly in the image.`

async function extractViaLlm(buf: Buffer, mime: string): Promise<{ text: string; engine: string } | null> {
  if (!llmService.hasUsableConnection()) return null
  try {
    const b64 = buf.toString('base64')
    const dataUrl = `data:${mime};base64,${b64}`
    const text = await llmService.completeVision(VISION_SYSTEM, [dataUrl])
    const cleaned = text.trim()
    if (cleaned.length < 5) return null
    return { text: cleaned, engine: 'llm-vision' }
  } catch (err) {
    log.warn(`document-ocr: LLM vision failed, will fall back: ${(err as Error).message}`)
    return null
  }
}

export interface DocumentRow {
  id: string
  source_path: string
  file_name: string | null
  file_size: number | null
  mime_type: string | null
  sha256: string | null
  page_count: number | null
  ocr_text: string | null
  ocr_confidence: number | null
  ocr_engine: string | null
  redactions_found: number
  report_id: string | null
  ingested_at: number
}

async function extractPdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  // Legacy build is the Node-compatible one.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
    getDocument: (src: { data: Uint8Array }) => { promise: Promise<PdfDocProxy> }
  }
  interface PdfDocProxy { numPages: number; getPage(n: number): Promise<PdfPageProxy> }
  interface PdfPageProxy { getTextContent(): Promise<{ items: Array<{ str: string }> }> }

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  let out = ''
  const cap = Math.min(doc.numPages, 100)
  for (let p = 1; p <= cap; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    out += content.items.map((i) => i.str).join(' ') + '\n\n--- page break ---\n\n'
  }
  return { text: out, pages: doc.numPages }
}

function countRedactions(text: string): number {
  const blockCount = (text.match(/█{6,}/g) || []).length
  // Long gaps of whitespace inside otherwise-text lines.
  const gapCount = (text.split('\n').filter((line) =>
    line.length > 80 && /\S/.test(line) && /\s{40,}/.test(line)
  )).length
  return blockCount + gapCount
}

export class DocumentOcrService {
  async ingest(filePath: string, opts: { report_id?: string | null } = {}): Promise<DocumentRow> {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
    const buf = await fs.readFile(filePath)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM documents WHERE sha256 = ? LIMIT 1').get(sha) as { id: string } | undefined
    if (existing) return this.get(existing.id)!

    const name = path.basename(filePath)
    const ext = path.extname(name).toLowerCase()
    const mime = ext === '.pdf' ? 'application/pdf'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : ext === '.tiff' || ext === '.tif' ? 'image/tiff'
      : ext === '.bmp' ? 'image/bmp'
      : null

    let text = ''
    let confidence = 0
    let pageCount: number | null = null
    let engine: string = 'unknown'

    try {
      if (mime === 'application/pdf') {
        const r = await extractPdfText(buf)
        text = r.text
        pageCount = r.pages
        engine = 'pdfjs-text-layer'
        // If text layer is empty, the PDF is a raster-only scan — we don't
        // OCR it in this batch. Record that fact.
        if (text.replace(/\s/g, '').length < 20) {
          text = '⚠ PDF contains no extractable text layer — likely a scanned image. OCR of raster PDFs requires the `canvas` native dep which Heimdall deliberately avoids. Extract pages as images externally and re-ingest.'
          confidence = 0
        } else {
          confidence = 99 // perfect — native text, no OCR error
        }
      } else if (mime && mime.startsWith('image/')) {
        // Primary path: LLM vision.
        const vision = await extractViaLlm(buf, mime)
        if (vision) {
          text = vision.text
          engine = vision.engine
          // Vision models don't emit a numeric confidence — we estimate
          // high (85) when the response is substantial (>200 chars), med
          // (70) otherwise. This is a heuristic for the UI; it's not
          // comparable to tesseract's word-level confidence.
          confidence = text.length > 200 ? 85 : 70
          pageCount = 1
          log.info(`document-ocr: LLM vision extracted ${text.length} chars`)
        }
        // Fallback: tesseract.js — pure JS, no network, deterministic.
        // v1.4.3: prefer the locally-managed traineddata file from
        // ModelDownloadManager so we never re-fetch from CDN at first
        // OCR. Falls back to tesseract.js's bundled CDN path if the
        // managed copy isn't installed yet.
        if (!text || text.length < 5) {
          const tesseract = await import('tesseract.js')
          const { modelDownloadManager } = await import('../models/ModelDownloadManager')
          const trainedPath = modelDownloadManager.path('tesseract-eng')
          const recognizeOpts = trainedPath
            ? { langPath: require('path').dirname(trainedPath), gzip: false }
            : undefined
          const result = await tesseract.recognize(buf, 'eng', recognizeOpts)
          text = result.data.text || ''
          confidence = result.data.confidence || 0
          pageCount = 1
          engine = text ? 'tesseract.js' : 'tesseract.js:empty'
          log.info(`document-ocr: tesseract fallback extracted ${text.length} chars (conf ${confidence.toFixed(0)}${trainedPath ? ', local-traineddata' : ', cdn-traineddata'})`)
        }
      } else {
        throw new Error(`Unsupported file type: ${ext || 'no extension'}`)
      }
    } catch (err) {
      log.error(`document-ocr: extraction failed for ${name}: ${(err as Error).message}`)
      throw err
    }

    const redactionsFound = countRedactions(text)

    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO documents (id, source_path, file_name, file_size, mime_type, sha256,
        page_count, ocr_text, ocr_confidence, ocr_engine, redactions_found, report_id, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, filePath, name, stat.size, mime, sha, pageCount,
      text.slice(0, 2_000_000), confidence, engine, redactionsFound, opts.report_id ?? null, now)

    // Auto-create intel_reports row for substantial documents.
    let newReportId: string | null = null
    if (!opts.report_id && text.replace(/\s/g, '').length > 500) {
      newReportId = crypto.randomUUID()
      const hash = crypto.createHash('sha256').update(text).digest('hex')
      db.prepare(`
        INSERT INTO intel_reports
          (id, discipline, title, content, summary, severity, source_id, source_url, source_name,
           content_hash, verification_score, reviewed, created_at, updated_at)
        VALUES (?, 'osint', ?, ?, NULL, 'medium', 'document-ocr', ?, 'Document OCR', ?, 50, 0, ?, ?)
      `).run(newReportId, `Document: ${name}`, text.slice(0, 50000),
        filePath, hash, now, now)
      db.prepare('UPDATE documents SET report_id = ? WHERE id = ?').run(newReportId, id)
    }

    log.info(`document-ocr: ${name} — ${pageCount ?? 1}pp, ${text.length} chars, conf ${confidence.toFixed(1)}, redactions ${redactionsFound}${newReportId ? ', intel_report='+newReportId : ''}`)
    return this.get(id)!
  }

  get(id: string): DocumentRow | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, source_path, file_name, file_size, mime_type, sha256,
             page_count, ocr_text, ocr_confidence, ocr_engine, redactions_found,
             report_id, ingested_at
      FROM documents WHERE id = ?
    `).get(id) as DocumentRow) || null
  }

  list(limit = 100): DocumentRow[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, source_path, file_name, file_size, mime_type, sha256,
             page_count, ocr_text, ocr_confidence, ocr_engine, redactions_found,
             report_id, ingested_at
      FROM documents ORDER BY ingested_at DESC LIMIT ?
    `).all(limit) as DocumentRow[]
  }

  remove(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }
}

export const documentOcrService = new DocumentOcrService()
