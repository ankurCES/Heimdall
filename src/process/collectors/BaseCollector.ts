import type { Discipline, IntelReport, ThreatLevel } from '@common/types/intel'
import { safeFetcher, type FetchOptions } from './SafeFetcher'
import { generateId, timestamp } from '@common/utils/id'
import { createHash } from 'crypto'
import { debugFetch, isDevMode } from '../services/debug/DebugLogger'
import log from 'electron-log'

export interface SourceConfig {
  id: string
  name: string
  discipline: Discipline
  type: string
  config: Record<string, unknown>
  schedule: string | null
  enabled: boolean
}

export abstract class BaseCollector {
  abstract readonly discipline: Discipline
  abstract readonly type: string

  protected sourceConfig: SourceConfig | null = null

  async initialize(config: SourceConfig): Promise<void> {
    this.sourceConfig = config
    log.info(`Collector initialized: ${this.type} (${this.discipline})`)
  }

  abstract collect(): Promise<IntelReport[]>

  async shutdown(): Promise<void> {
    log.info(`Collector shutdown: ${this.type} (${this.discipline})`)
  }

  protected async safeFetch(url: string, options?: FetchOptions): Promise<Response> {
    const resp = await safeFetcher.fetch(url, options)
    if (isDevMode()) debugFetch(url, resp.status)
    return resp
  }

  protected async fetchJson<T = unknown>(url: string, options?: FetchOptions): Promise<T> {
    const result = await safeFetcher.fetchJson<T>(url, options)
    if (isDevMode()) {
      const size = JSON.stringify(result || {}).length
      debugFetch(url, 200, size)
    }
    return result
  }

  protected async fetchText(url: string, options?: FetchOptions): Promise<string> {
    const text = await safeFetcher.fetchText(url, options)
    if (isDevMode()) debugFetch(url, 200, text.length)
    return text
  }

  protected createReport(params: {
    title: string
    content: string
    severity: ThreatLevel
    sourceUrl?: string
    sourceName: string
    summary?: string
    latitude?: number
    longitude?: number
    verificationScore?: number
  }): IntelReport {
    const now = timestamp()
    const title = (params.title || '').trim()
    const content = (params.content || '').trim()
    const contentHash = createHash('sha256')
      .update(title + content)
      .digest('hex')

    return {
      id: generateId(),
      discipline: this.discipline,
      title: title || 'Untitled Report',
      content: content || 'No content',
      summary: params.summary?.trim() || null,
      severity: params.severity || 'info',
      sourceId: this.sourceConfig?.id ?? 'unknown',
      sourceUrl: params.sourceUrl?.trim() || null,
      sourceName: (params.sourceName || '').trim() || 'Unknown',
      contentHash,
      latitude: params.latitude ?? null,
      longitude: params.longitude ?? null,
      verificationScore: params.verificationScore ?? 50,
      reviewed: false,
      createdAt: now,
      updatedAt: now
    }
  }
}
