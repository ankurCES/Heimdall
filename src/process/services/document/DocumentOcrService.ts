import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'

/**
 * Theme 8.3 — Document OCR + redaction detector.
 *
 *   PDF files        → pdfjs-dist extracts the embedded text layer
 *                      (works for the vast majority of machine-generated
 *                      PDFs without any OCR). If the text layer is empty
 *                      the PDF is flagged as "scan-only" and the analyst
 *                      is told so — full raster→OCR needs the `canvas`
 *                      native module we've deliberately avoided.
 *   Image files      → tesseract.js OCR directly from the Buffer.
 *
 * Redaction heuristic — counts runs of ≥6 contiguous "█" characters OR
 * long stretches of whitespace (>40 chars) on a line that otherwise has
 * regular text. A real redaction detector needs pixel analysis; this is
 * a linguistic tell useful on OCR'd scans.
 *
 * On ingest, substantial documents (≥500 chars) automatically create an
 * intel_reports row (source='document-ocr') so RAG / search / the agent
 * can operate on the extracted text.
 */

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
    let engine: string

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
        const tesseract = await import('tesseract.js')
        const result = await tesseract.recognize(buf, 'eng')
        text = result.data.text || ''
        confidence = result.data.confidence || 0
        pageCount = 1
        engine = 'tesseract.js'
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
