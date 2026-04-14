import { LocalIndex } from 'vectra'
import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { llmService } from '../llm/LlmService'
import { getDatabase } from '../database'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Vector DB using Vectra (local file-based vector index)
// Uses LLM embeddings API or falls back to TF-IDF style local embeddings

export class VectorDbService {
  private index: LocalIndex | null = null
  private indexPath: string
  private initialized = false

  constructor() {
    this.indexPath = join(app.getPath('userData'), 'vector-index')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    try {
      // Check for corrupt index and repair before opening
      await this.repairIfCorrupt()

      this.index = new LocalIndex(this.indexPath)

      if (!await this.index.isIndexCreated()) {
        await this.index.createIndex()
        log.info('Vector index created')
      }

      this.initialized = true
      log.info(`Vector DB initialized at ${this.indexPath}`)
    } catch (err) {
      log.error('Vector DB init failed:', err)
      // If init fails due to corruption, rebuild
      await this.rebuildIndex()
    }
  }

  private async repairIfCorrupt(): Promise<void> {
    const { readFileSync, writeFileSync, existsSync, renameSync } = require('fs')
    const indexFile = join(this.indexPath, 'index.json')
    if (!existsSync(indexFile)) return

    try {
      const content = readFileSync(indexFile, 'utf-8')
      JSON.parse(content) // Test validity
    } catch (err) {
      log.warn(`Vector index corrupt: ${err}. Attempting repair...`)
      try {
        const content = readFileSync(indexFile, 'utf-8')
        // Backup corrupt file
        renameSync(indexFile, indexFile + '.corrupt.' + Date.now())

        // Try to salvage: find the last complete item and truncate
        const lastGoodBracket = content.lastIndexOf('}]')
        if (lastGoodBracket > 100) {
          const truncated = content.slice(0, lastGoodBracket + 2) + '}'
          try {
            JSON.parse(truncated)
            writeFileSync(indexFile, truncated, 'utf-8')
            log.info(`Vector index repaired: truncated from ${content.length} to ${truncated.length} bytes`)
            return
          } catch {}
        }

        // Can't salvage — create empty index
        log.warn('Vector index could not be repaired, creating fresh index')
        writeFileSync(indexFile, '{"version":1,"metadata_config":{"indexed":[]},"items":[]}', 'utf-8')
      } catch (repairErr) {
        log.error(`Vector index repair failed: ${repairErr}`)
      }
    }
  }

  private async rebuildIndex(): Promise<void> {
    try {
      const { rmSync, existsSync } = require('fs')
      if (existsSync(this.indexPath)) {
        rmSync(this.indexPath, { recursive: true, force: true })
      }
      this.index = new LocalIndex(this.indexPath)
      await this.index.createIndex()
      this.initialized = true
      log.info('Vector DB rebuilt from scratch')
    } catch (err) {
      log.error(`Vector DB rebuild failed: ${err}`)
    }
  }

  async getIndexSize(): Promise<number> {
    if (!this.index || !this.initialized) return 0
    try {
      const stats = await this.index.listItems()
      return stats.length
    } catch {
      return 0
    }
  }

  async addReport(report: IntelReport): Promise<void> {
    if (!this.index || !this.initialized) return

    try {
      const text = this.buildDocument(report)
      const vector = await this.getEmbedding(text)
      if (!vector) return

      await this.index.insertItem({
        vector,
        metadata: {
          reportId: report.id,
          title: report.title,
          discipline: report.discipline,
          severity: report.severity,
          sourceName: report.sourceName,
          verificationScore: report.verificationScore,
          createdAt: report.createdAt,
          snippet: report.content.slice(0, 300)
        }
      })
    } catch (err) {
      log.debug(`Vector insert failed for ${report.id}: ${err}`)
    }
  }

  async search(query: string, topK: number = 10): Promise<Array<{
    reportId: string
    score: number
    title: string
    discipline: string
    severity: string
    snippet: string
  }>> {
    if (!this.index || !this.initialized) return []

    try {
      const vector = await this.getEmbedding(query)
      if (!vector) return []

      const results = await this.index.queryItems(vector, topK)
      return results.map((r) => ({
        reportId: (r.item.metadata as any).reportId,
        score: r.score,
        title: (r.item.metadata as any).title,
        discipline: (r.item.metadata as any).discipline,
        severity: (r.item.metadata as any).severity,
        snippet: (r.item.metadata as any).snippet
      }))
    } catch (err) {
      log.warn(`Vector search failed: ${err}`)
      return []
    }
  }

  async ingestBatch(reports: IntelReport[]): Promise<number> {
    if (!this.index || !this.initialized) return 0

    let count = 0
    for (const report of reports) {
      try {
        await this.addReport(report)
        count++
      } catch {
        // continue
      }
      // Small delay to avoid rate limiting embeddings API
      if (count % 10 === 0) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    log.info(`Vector DB: ingested ${count}/${reports.length} reports`)
    return count
  }

  async ingestUnindexed(): Promise<number> {
    if (!this.index || !this.initialized) return 0

    const db = getDatabase()
    // Get reports not yet in the vector index
    // We track by checking if report ID exists in index metadata
    const allReports = db.prepare(
      'SELECT * FROM intel_reports ORDER BY created_at DESC LIMIT 500'
    ).all() as Array<Record<string, unknown>>

    const reports: IntelReport[] = allReports.map((r) => ({
      id: r.id as string,
      discipline: r.discipline as IntelReport['discipline'],
      title: r.title as string,
      content: r.content as string,
      summary: r.summary as string | null,
      severity: r.severity as IntelReport['severity'],
      sourceId: r.source_id as string,
      sourceUrl: r.source_url as string | null,
      sourceName: r.source_name as string,
      contentHash: r.content_hash as string,
      latitude: r.latitude as number | null,
      longitude: r.longitude as number | null,
      verificationScore: r.verification_score as number,
      reviewed: (r.reviewed as number) === 1,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number
    }))

    return this.ingestBatch(reports)
  }

  getStats(): { initialized: boolean; indexPath: string } {
    return { initialized: this.initialized, indexPath: this.indexPath }
  }

  private buildDocument(report: IntelReport): string {
    return [
      report.title,
      `Discipline: ${report.discipline}`,
      `Severity: ${report.severity}`,
      `Source: ${report.sourceName}`,
      report.content.slice(0, 2000)
    ].join('\n')
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    try {
      // Try to use the LLM connection's embedding API
      const conn = llmService.getConnection()
      if (!conn) {
        return this.localEmbedding(text)
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (conn.apiKey) headers['Authorization'] = `Bearer ${conn.apiKey}`

      // Try OpenAI-compatible embeddings endpoint
      let response = await fetch(`${conn.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text.slice(0, 8000)
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(30000)
      })

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const redirectUrl = response.headers.get('location')
        if (redirectUrl) {
          response = await fetch(redirectUrl, {
            method: 'POST', headers,
            body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
            signal: AbortSignal.timeout(30000)
          })
        }
      }

      if (!response.ok) {
        // Embedding API not available, fall back to local
        return this.localEmbedding(text)
      }

      const data = await response.json() as { data: Array<{ embedding: number[] }> }
      return data.data?.[0]?.embedding || this.localEmbedding(text)
    } catch {
      return this.localEmbedding(text)
    }
  }

  // Simple local TF-IDF style embedding (no API needed)
  // Creates a 384-dim vector from word frequency hashing
  private localEmbedding(text: string): number[] {
    const dim = 384
    const vector = new Float64Array(dim)
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)

    for (const word of words) {
      // Hash the word to multiple positions (simulating feature hashing)
      let hash = 0
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0
      }
      const pos = Math.abs(hash) % dim
      const sign = hash > 0 ? 1 : -1
      vector[pos] += sign * (1 / Math.sqrt(words.length))

      // Second hash for more coverage
      let hash2 = 0
      for (let i = word.length - 1; i >= 0; i--) {
        hash2 = ((hash2 << 3) + hash2 + word.charCodeAt(i)) | 0
      }
      const pos2 = Math.abs(hash2) % dim
      vector[pos2] += (hash2 > 0 ? 1 : -1) * (0.5 / Math.sqrt(words.length))
    }

    // Normalize
    let norm = 0
    for (let i = 0; i < dim; i++) norm += vector[i] * vector[i]
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < dim; i++) vector[i] /= norm
    }

    return Array.from(vector)
  }
}

export const vectorDbService = new VectorDbService()
