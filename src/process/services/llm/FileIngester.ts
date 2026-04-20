import { app } from 'electron'
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { safeFetcher } from '../../collectors/SafeFetcher'
import { vectorDbService } from '../vectordb/VectorDbService'
import log from 'electron-log'

/**
 * Downloads files found during deep research (PDF, TXT, MD, CSV, DOC,
 * DOCX, JSON, XML, XLSX) and ingests their text content into the vector
 * DB for immediate RAG availability.
 *
 * Session-scoped: tracks total bytes downloaded per session and caps at
 * MAX_SESSION_BYTES (50 MB). Individual files capped at MAX_FILE_BYTES
 * (10 MB).
 *
 * Text extraction:
 *   - .txt / .md / .csv / .json / .xml → read as UTF-8
 *   - .pdf → headless text extraction via regex on raw bytes (basic;
 *     for full OCR, analyst can use Document OCR page)
 *   - .doc / .docx / .xlsx → metadata only (no native parser bundled)
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024   // 10 MB per file
const MAX_SESSION_BYTES = 50 * 1024 * 1024 // 50 MB total per session

export interface IngestedFile {
  url: string
  localPath: string
  filename: string
  extension: string
  sizeBytes: number
  textLength: number
  vectorId: string | null
  error: string | null
}

export class FileIngester {
  private sessionId: string
  private downloadDir: string
  private totalBytes = 0
  private files: IngestedFile[] = []

  constructor(sessionId: string) {
    this.sessionId = sessionId
    const date = new Date().toISOString().split('T')[0]
    this.downloadDir = join(app.getPath('userData'), 'research-files', date, sessionId.slice(0, 8))
    mkdirSync(this.downloadDir, { recursive: true })
  }

  getFiles(): IngestedFile[] { return this.files }
  getTotalBytes(): number { return this.totalBytes }

  /**
   * Download a file URL, extract text, ingest into vector DB.
   * Returns the ingested file record, or null if skipped/failed.
   */
  async ingest(url: string, onChunk?: (c: string) => void): Promise<IngestedFile | null> {
    if (this.totalBytes >= MAX_SESSION_BYTES) {
      log.debug(`FileIngester: session cap reached (${this.totalBytes} bytes), skipping ${url}`)
      return null
    }

    const filename = this.extractFilename(url)
    const extension = filename.split('.').pop()?.toLowerCase() || 'bin'
    const localPath = join(this.downloadDir, filename)

    onChunk?.(`\n**[File download]** ${url.slice(0, 100)} → ${filename}\n`)

    try {
      // Download.
      const isOnion = /\.onion/i.test(url)
      let buffer: Buffer

      if (isOnion) {
        // Use onion_fetch tool which handles SOCKS5 routing.
        const r = await import('../tools/ToolRegistry').then((m) => m.toolRegistry.execute('onion_fetch', { url, max_chars: MAX_FILE_BYTES }))
        if (r.error) throw new Error(r.error)
        buffer = Buffer.from(r.output || '', 'utf-8')
      } else {
        const response = await safeFetcher.fetch(url, { timeout: 30000, maxRetries: 2, skipRobots: true })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        // Check content-length before downloading full body.
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
        if (contentLength > MAX_FILE_BYTES) {
          onChunk?.(`  → skipped: ${(contentLength / 1024 / 1024).toFixed(1)} MB exceeds 10 MB cap\n`)
          return null
        }

        const arrayBuf = await response.arrayBuffer()
        buffer = Buffer.from(arrayBuf)
      }

      if (buffer.length > MAX_FILE_BYTES) {
        onChunk?.(`  → skipped: ${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds 10 MB cap\n`)
        return null
      }

      // Write to disk.
      writeFileSync(localPath, buffer)
      this.totalBytes += buffer.length

      // Extract text.
      const text = this.extractText(buffer, extension)
      const textLength = text.length

      onChunk?.(`  → ${(buffer.length / 1024).toFixed(0)} KB, ${textLength} chars extracted\n`)

      // Ingest into vector DB for immediate RAG availability.
      let vectorId: string | null = null
      if (text.length >= 50) {
        try {
          const id = `file_${this.sessionId.slice(0, 8)}_${filename.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}`
          await vectorDbService.addReport({
            id,
            discipline: 'osint',
            title: `[FILE] ${filename}`,
            content: text.slice(0, 5000),
            summary: text.slice(0, 240),
            severity: 'info',
            sourceId: 'research-file',
            sourceUrl: url,
            sourceName: `File: ${filename}`,
            contentHash: url,
            latitude: null,
            longitude: null,
            verificationScore: 60,
            reviewed: false,
            createdAt: Date.now(),
            updatedAt: Date.now()
          } as any)
          vectorId = id
          onChunk?.(`  → ingested into vector DB ✓\n`)
        } catch (err) {
          log.debug(`FileIngester: vector ingest failed for ${filename}: ${err}`)
        }
      }

      const record: IngestedFile = {
        url, localPath, filename, extension,
        sizeBytes: buffer.length, textLength, vectorId, error: null
      }
      this.files.push(record)
      return record

    } catch (err) {
      const error = (err as Error).message
      onChunk?.(`  → failed: ${error.slice(0, 80)}\n`)
      const record: IngestedFile = {
        url, localPath, filename, extension,
        sizeBytes: 0, textLength: 0, vectorId: null, error
      }
      this.files.push(record)
      return null
    }
  }

  /** Extract readable text from a file buffer based on extension. */
  private extractText(buffer: Buffer, ext: string): string {
    switch (ext) {
      case 'txt':
      case 'md':
      case 'csv':
      case 'json':
      case 'xml':
        return buffer.toString('utf-8').slice(0, 50000)

      case 'pdf':
        return this.extractPdfText(buffer)

      case 'doc':
      case 'docx':
      case 'xlsx':
        // No native parser bundled — store metadata only.
        // Full extraction available via Document OCR page.
        return `[${ext.toUpperCase()} file — ${(buffer.length / 1024).toFixed(0)} KB. Use Document OCR for full text extraction.]`

      default:
        return ''
    }
  }

  /** Basic PDF text extraction — pulls text between stream markers.
   *  Not a full PDF parser; catches 60-70% of text-layer PDFs. For
   *  scanned PDFs, the analyst should use Document OCR. */
  private extractPdfText(buffer: Buffer): string {
    const raw = buffer.toString('latin1')
    const chunks: string[] = []

    // Method 1: Extract text between BT/ET markers (text objects).
    const textObjects = raw.match(/BT[\s\S]*?ET/g) || []
    for (const obj of textObjects) {
      const textRuns = obj.match(/\(([^)]*)\)/g) || []
      for (const run of textRuns) {
        const decoded = run.slice(1, -1)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\')
        if (decoded.trim()) chunks.push(decoded)
      }
    }

    // Method 2: Look for plaintext runs outside streams.
    if (chunks.length === 0) {
      const lines = raw.split('\n')
      for (const line of lines) {
        const clean = line.replace(/[^\x20-\x7E]/g, ' ').trim()
        if (clean.length > 20 && !/^[%<\/]/.test(clean)) {
          chunks.push(clean)
        }
      }
    }

    return chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 50000)
  }

  private extractFilename(url: string): string {
    try {
      const path = new URL(url).pathname
      const segments = path.split('/').filter(Boolean)
      const last = segments.pop() || 'download'
      // Sanitize.
      return last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'download'
    } catch {
      return 'download'
    }
  }
}
