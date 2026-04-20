import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { safeFetcher } from '../../collectors/SafeFetcher'
import { vectorDbService } from '../vectordb/VectorDbService'
import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { llmService } from './LlmService'
import type { DiscoveredImage } from './AdaptiveCrawler'
import log from 'electron-log'

/**
 * Downloads images discovered during deep research, runs IMINT vision
 * analysis, stores as intel_reports (discipline: imint), and ingests
 * into the vector DB as base64 embeddings.
 *
 * Max 5 images per page, 20 per session. Skips UI assets (logos, icons).
 */

const MAX_SESSION_IMAGES = 20
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB per image

export interface IngestedImage {
  url: string
  localPath: string
  filename: string
  sizeBytes: number
  visionAnalysis: string | null
  reportId: string | null
  vectorId: string | null
  relevance: 'high' | 'medium' | 'low' | null
  error: string | null
}

export class ResearchImageIngester {
  private sessionId: string
  private downloadDir: string
  private images: IngestedImage[] = []
  private taskDescription: string = ''

  constructor(sessionId: string) {
    this.sessionId = sessionId
    const date = new Date().toISOString().split('T')[0]
    this.downloadDir = join(app.getPath('userData'), 'research-images', date, sessionId.slice(0, 8))
    mkdirSync(this.downloadDir, { recursive: true })
  }

  setTaskContext(taskDescription: string): void {
    this.taskDescription = taskDescription
  }

  getImages(): IngestedImage[] { return this.images }

  /**
   * Download + analyze + store an image. Returns null if skipped/failed.
   */
  async ingest(
    img: DiscoveredImage,
    onChunk?: (c: string) => void
  ): Promise<IngestedImage | null> {
    if (this.images.length >= MAX_SESSION_IMAGES) return null

    const filename = this.extractFilename(img.url)
    const localPath = join(this.downloadDir, filename)

    onChunk?.(`\n**[Image download]** ${img.url.slice(0, 80)}\n`)

    try {
      // Download.
      const isOnion = /\.onion/i.test(img.url)
      let buffer: Buffer

      if (isOnion) {
        // For onion images, we need raw bytes not text.
        // Use SafeFetcher directly which handles SOCKS5.
        const response = await safeFetcher.fetch(img.url, { timeout: 30000, skipRobots: true, maxRetries: 1 })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const ab = await response.arrayBuffer()
        buffer = Buffer.from(ab)
      } else {
        const response = await safeFetcher.fetch(img.url, { timeout: 15000, skipRobots: true })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const ab = await response.arrayBuffer()
        buffer = Buffer.from(ab)
      }

      if (buffer.length > MAX_IMAGE_BYTES) {
        onChunk?.(`  → skipped: ${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds 5 MB cap\n`)
        return null
      }
      if (buffer.length < 1024) {
        // Too small — likely a 1x1 pixel or broken image.
        return null
      }

      // Write to disk.
      writeFileSync(localPath, buffer)

      // Determine MIME type from extension.
      const ext = filename.split('.').pop()?.toLowerCase() || 'jpg'
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      const b64 = `data:${mime};base64,${buffer.toString('base64')}`

      onChunk?.(`  → ${(buffer.length / 1024).toFixed(0)} KB downloaded\n`)

      // Vision analysis (if LLM configured).
      let visionAnalysis: string | null = null
      let relevance: 'high' | 'medium' | 'low' | null = null

      if (llmService.hasUsableConnection()) {
        try {
          visionAnalysis = await llmService.completeVision(
            `Analyze this image for intelligence value. Research context: "${this.taskDescription.slice(0, 200)}".
Describe: subjects, text/watermarks, location indicators, metadata clues, potential evidentiary value.
Rate relevance to the research: HIGH / MEDIUM / LOW.`,
            [b64],
            { timeoutMs: 60000 }
          )
          // Extract relevance rating.
          if (/\bHIGH\b/i.test(visionAnalysis)) relevance = 'high'
          else if (/\bMEDIUM\b/i.test(visionAnalysis)) relevance = 'medium'
          else relevance = 'low'
          onChunk?.(`  → vision: ${relevance} relevance\n`)
        } catch (err) {
          log.debug(`ResearchImageIngester: vision failed: ${(err as Error).message}`)
        }
      }

      // Only store as intel if vision rates it medium+ or no vision available.
      if (relevance === 'low') {
        const record: IngestedImage = {
          url: img.url, localPath, filename, sizeBytes: buffer.length,
          visionAnalysis, reportId: null, vectorId: null, relevance, error: null
        }
        this.images.push(record)
        return record
      }

      // Store as intel_report.
      const db = getDatabase()
      const now = timestamp()
      const reportId = generateId()
      const { createHash } = await import('crypto')
      const hash = createHash('sha256').update(img.url + buffer.length).digest('hex')

      // Check duplicate.
      const existing = db.prepare('SELECT id FROM intel_reports WHERE content_hash = ? LIMIT 1').get(hash)
      if (existing) {
        const record: IngestedImage = {
          url: img.url, localPath, filename, sizeBytes: buffer.length,
          visionAnalysis, reportId: null, vectorId: null, relevance, error: 'duplicate'
        }
        this.images.push(record)
        return record
      }

      const title = `[IMAGE] ${img.sourcePageUrl ? new URL(img.sourcePageUrl).hostname : 'research'}: ${filename}`.slice(0, 250)
      const content = [
        `**Source**: research image discovery`,
        `**Image URL**: ${img.url}`,
        `**Source page**: ${img.sourcePageUrl || 'unknown'}`,
        `**Local file**: ${localPath}`,
        `**Size**: ${(buffer.length / 1024).toFixed(0)} KB`,
        '',
        '---',
        '',
        visionAnalysis ? `## Vision Analysis\n\n${visionAnalysis}` : '(No vision analysis)'
      ].join('\n')

      db.prepare(
        'INSERT INTO intel_reports (id, discipline, title, content, summary, severity, source_id, source_name, source_url, content_hash, verification_score, reviewed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        reportId, 'imint', title, content,
        (visionAnalysis || filename).slice(0, 240),
        relevance === 'high' ? 'high' : 'medium',
        'research-image', `Image: ${filename}`,
        img.url, hash, 50, 0, now, now
      )

      // Tag.
      const tagStmt = db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)')
      for (const tag of ['research-image', 'imint', 'image-evidence']) {
        tagStmt.run(reportId, tag, 1.0, 'research-image', now)
      }

      onChunk?.(`  → stored as intel report ${reportId.slice(0, 8)} [IMAGE]\n`)

      // Ingest into vector DB.
      let vectorId: string | null = null
      if (visionAnalysis && visionAnalysis.length > 50) {
        try {
          const vid = `img_${this.sessionId.slice(0, 8)}_${filename.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`
          await vectorDbService.addReport({
            id: vid, discipline: 'imint', title,
            content: visionAnalysis.slice(0, 3000),
            summary: visionAnalysis.slice(0, 240),
            severity: 'info', sourceId: 'research-image',
            sourceUrl: img.url, sourceName: `Image: ${filename}`,
            contentHash: hash, latitude: null, longitude: null,
            verificationScore: 50, reviewed: false,
            createdAt: Date.now(), updatedAt: Date.now()
          } as any)
          vectorId = vid
          onChunk?.(`  → ingested into vector DB ✓\n`)
        } catch { /* vector DB may be corrupt */ }
      }

      const record: IngestedImage = {
        url: img.url, localPath, filename, sizeBytes: buffer.length,
        visionAnalysis, reportId, vectorId, relevance, error: null
      }
      this.images.push(record)
      return record

    } catch (err) {
      const error = (err as Error).message
      onChunk?.(`  → failed: ${error.slice(0, 80)}\n`)
      const record: IngestedImage = {
        url: img.url, localPath, filename, sizeBytes: 0,
        visionAnalysis: null, reportId: null, vectorId: null, relevance: null, error
      }
      this.images.push(record)
      return null
    }
  }

  private extractFilename(url: string): string {
    try {
      const path = new URL(url).pathname
      const segments = path.split('/').filter(Boolean)
      const last = segments.pop() || 'image'
      return last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'image.jpg'
    } catch { return 'image.jpg' }
  }
}
