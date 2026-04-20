import { settingsService } from '../settings/SettingsService'
import type { ObsidianConfig } from '@common/types/settings'
import https from 'https'
import log from 'electron-log'

// Agent that accepts self-signed certificates (Obsidian Local REST API uses one)
const insecureAgent = new https.Agent({ rejectUnauthorized: false })

// Obsidian Local REST API client
// Docs: https://coddingtonbear.github.io/obsidian-local-rest-api/

export interface ObsidianFile {
  path: string
  name: string
  isFolder: boolean
  children?: ObsidianFile[]
}

export interface ObsidianSearchResult {
  filename: string
  result: {
    content: string
    matches: Array<{ start: number; end: number }>
  }
}

/**
 * One-call result from `readFileWithStat` — content plus the Obsidian
 * vault's stat block (mtime + size). Used as the cheap "has it changed?"
 * signature for differential sync.
 */
export interface ObsidianFileWithStat {
  path: string
  content: string
  mtime: number
  size: number
}

export class ObsidianService {
  // 5-min cache of `listFiles()` so back-to-back ingestion runs (e.g. user
  // double-clicks "Generate Learnings") don't re-walk the whole vault, which
  // was causing N+1 HTTP round-trips per folder.
  private listCache: { files: string[]; expiresAt: number } | null = null

  private getConfig(): ObsidianConfig | null {
    const config = settingsService.get<ObsidianConfig>('obsidian')
    if (!config?.apiKey) return null
    return config
  }

  private getApiKey(): string | null {
    // Check obsidian config first, then fallback to apikeys
    const config = this.getConfig()
    if (config?.apiKey) return config.apiKey
    return settingsService.get<string>('apikeys.obsidian') || null
  }

  private getBaseUrl(): string {
    const config = this.getConfig()
    return config?.baseUrl || 'https://127.0.0.1:27124'
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const apiKey = this.getApiKey()
    if (!apiKey) throw new Error('Obsidian API key not configured')

    const url = `${this.getBaseUrl()}${path}`

    // Use custom https.Agent to accept self-signed certs
    // Node 22 fetch supports the dispatcher option via undici
    const fetchOptions: RequestInit & Record<string, unknown> = {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...options.headers
      },
      signal: AbortSignal.timeout(10000)
    }

    // For self-signed cert support, make the request via a manual https call
    const response = await this.fetchWithInsecureTls(url, fetchOptions)

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: response.statusText }))
      throw new Error(`Obsidian API ${response.status}: ${(err as { message: string }).message}`)
    }

    return response
  }

  private fetchWithInsecureTls(url: string, options: RequestInit & Record<string, unknown>): Promise<Response> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const method = (options.method || 'GET').toUpperCase()
      const headers = options.headers as Record<string, string> || {}
      const body = options.body as string | undefined

      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 27124,
          path: parsed.pathname + parsed.search,
          method,
          headers,
          rejectUnauthorized: false,
          timeout: 10000
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const statusCode = res.statusCode || 500
            const bodyText = Buffer.concat(chunks).toString('utf-8')
            // 204/304 responses must not have a body per spec
            const hasBody = statusCode !== 204 && statusCode !== 304
            const response = new Response(hasBody ? bodyText : null, {
              status: statusCode,
              statusText: res.statusMessage || '',
              headers: res.headers as Record<string, string>
            })
            resolve(response)
          })
        }
      )

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timed out'))
      })

      if (body) req.write(body)
      req.end()
    })
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const apiKey = this.getApiKey()
      if (!apiKey) return { success: false, message: 'No API key configured' }

      const response = await this.request('/')
      // The root endpoint may return JSON or plain text depending on version
      const text = await response.text()
      let status = 'OK'
      try {
        const data = JSON.parse(text)
        status = data.status || data.authenticated ? 'Authenticated' : 'Connected'
      } catch {
        // Not JSON — still connected if we got a 200
        status = response.status === 200 ? 'Connected' : `HTTP ${response.status}`
      }
      log.info(`Obsidian test connection: ${status}`)
      return { success: true, message: `Connected to Obsidian (${status})` }
    } catch (err) {
      log.warn(`Obsidian test connection failed: ${err}`)
      return { success: false, message: String(err) }
    }
  }

  async listFiles(folder?: string): Promise<string[]> {
    const allFiles: string[] = []
    await this.walkVault(folder || '', allFiles)
    log.info(`Obsidian listFiles: ${allFiles.length} files found`)
    return allFiles
  }

  private async walkVault(folder: string, results: string[], depth: number = 0): Promise<void> {
    if (depth > 10) return // Safety limit

    const apiPath = folder ? `/vault/${this.encodePath(folder)}/` : '/vault/'
    try {
      const response = await this.request(apiPath, {
        headers: { Accept: 'application/json' }
      })
      const text = await response.text()
      if (!text.trim()) return

      const data = JSON.parse(text)
      const items: string[] = Array.isArray(data) ? data : (data.files || [])

      for (const item of items) {
        if (item.endsWith('/')) {
          // It's a subfolder — recurse
          const subFolder = folder ? `${folder}/${item.slice(0, -1)}` : item.slice(0, -1)
          await this.walkVault(subFolder, results, depth + 1)
        } else {
          // It's a file
          const filePath = folder ? `${folder}/${item}` : item
          results.push(filePath)
        }
      }
    } catch (err) {
      log.debug(`Obsidian walkVault failed for "${folder}": ${err}`)
    }
  }

  async readFile(filePath: string): Promise<string> {
    const response = await this.request(`/vault/${this.encodePath(filePath)}`, {
      headers: { Accept: 'text/markdown' }
    })
    return response.text()
  }

  /**
   * Read a file AND its Obsidian-side stat block in one HTTP round-trip via
   * the `application/vnd.olrapi.note+json` content-negotiation endpoint.
   *
   * Returns `{ content, mtime, size }`. mtime is the vault's stored
   * modification time (ms epoch) — cheap signature for differential sync:
   * if `(mtime, size)` is identical to last sync, the file hasn't changed
   * and the expensive embedding step can be skipped.
   *
   * Falls back to plain `readFile` + `(content_length, 0)` if the note+json
   * endpoint isn't available (older Local REST API versions).
   */
  async readFileWithStat(filePath: string): Promise<ObsidianFileWithStat> {
    try {
      const response = await this.request(`/vault/${this.encodePath(filePath)}`, {
        headers: { Accept: 'application/vnd.olrapi.note+json' }
      })
      const data = await response.json() as {
        content?: string
        path?: string
        stat?: { mtime?: number; size?: number; ctime?: number }
      }
      return {
        path: data.path || filePath,
        content: data.content || '',
        mtime: Number(data.stat?.mtime ?? 0),
        size: Number(data.stat?.size ?? (data.content?.length ?? 0))
      }
    } catch (err) {
      // Fall back to plain markdown — older REST API didn't ship note+json
      log.debug(`Obsidian readFileWithStat fallback for "${filePath}": ${err}`)
      const content = await this.readFile(filePath)
      return { path: filePath, content, mtime: 0, size: content.length }
    }
  }

  /**
   * Cached version of `listFiles()`. The vault listing is recursive over
   * Obsidian's REST API (one HTTP call per folder), so a vault with 100s of
   * folders is hundreds of round-trips per call. We cache the result for
   * 5 min — the cron-driven Obsidian collector ingestion runs every 20 min
   * so the cache is always cold on the scheduled path, but UI-driven
   * "Generate Learnings" clicks reuse it.
   */
  async listFilesCached(folder?: string, ttlMs: number = 5 * 60_000): Promise<string[]> {
    if (folder) return this.listFiles(folder) // bypass cache for sub-folder lookups
    if (this.listCache && Date.now() < this.listCache.expiresAt) {
      return this.listCache.files
    }
    const files = await this.listFiles()
    this.listCache = { files, expiresAt: Date.now() + ttlMs }
    return files
  }

  /** Force a reload on next call. */
  invalidateListCache(): void {
    this.listCache = null
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.request(`/vault/${this.encodePath(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: content
    })
  }

  async createFile(filePath: string, content: string): Promise<void> {
    await this.request(`/vault/${this.encodePath(filePath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: content
    })
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.request(`/vault/${this.encodePath(filePath)}`, {
      method: 'DELETE'
    })
  }

  // Encode path segments individually, preserving slashes
  private encodePath(filePath: string): string {
    return filePath.split('/').map((seg) => encodeURIComponent(seg)).join('/')
  }

  async search(query: string): Promise<ObsidianSearchResult[]> {
    const response = await this.request('/search/simple/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, contextLength: 100 })
    })
    return response.json() as Promise<ObsidianSearchResult[]>
  }

  async getTags(): Promise<Record<string, number>> {
    const response = await this.request('/tags/', {
      headers: { Accept: 'application/json' }
    })
    const data = await response.json() as { tags: Record<string, number> }
    return data.tags || {}
  }

  async getActiveFile(): Promise<{ path: string; content: string } | null> {
    try {
      const response = await this.request('/active/', {
        headers: { Accept: 'application/vnd.olrapi.note+json' }
      })
      return response.json() as Promise<{ path: string; content: string }>
    } catch {
      return null
    }
  }

  async openFile(filePath: string): Promise<void> {
    await this.request(`/open/${this.encodePath(filePath)}`, {
      method: 'POST'
    })
  }

  // Sync a single report to Obsidian vault
  async syncReport(filePath: string, content: string): Promise<void> {
    const config = this.getConfig()
    if (!config?.syncEnabled) return

    const folder = config.syncFolder || 'Heimdall'
    const obsidianPath = `${folder}/${filePath}`

    try {
      await this.createFile(obsidianPath, content)
      log.debug(`Synced to Obsidian: ${obsidianPath}`)
    } catch (err) {
      log.warn(`Obsidian sync failed for ${obsidianPath}: ${err}`)
    }
  }

  // Bulk import all local markdown files to Obsidian on first connection
  async bulkImportLocalFiles(): Promise<{ imported: number; skipped: number; errors: number }> {
    const config = this.getConfig()
    if (!config?.apiKey) throw new Error('Obsidian not configured')

    const folder = config.syncFolder || 'Heimdall'
    const { app: electronApp } = await import('electron')
    const { join } = await import('path')
    const { readdirSync, readFileSync, statSync } = await import('fs')

    const memoryDir = join(electronApp.getPath('home'), '.heimdall', 'memory')
    let imported = 0
    let skipped = 0
    let errors = 0

    // Walk the memory directory recursively
    const walk = (dir: string, relativePath: string = ''): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const relPath = relativePath ? `${relativePath}/${entry}` : entry

        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath, relPath)
          } else if (entry.endsWith('.md')) {
            const content = readFileSync(fullPath, 'utf-8')
            if (!content.trim()) {
              skipped++
              continue
            }

            // Queue the file for upload (don't await each one — batch them)
            const obsidianPath = `${folder}/${relPath}`
            this.uploadQueue.push({ path: obsidianPath, content })
          }
        } catch {
          errors++
        }
      }
    }

    walk(memoryDir)
    log.info(`Obsidian bulk import: found ${this.uploadQueue.length} files to sync`)

    // Process upload queue with rate limiting
    for (const item of this.uploadQueue) {
      try {
        await this.writeFile(item.path, item.content)
        imported++
      } catch {
        errors++
      }
      // Small delay to avoid overwhelming the Obsidian API
      await new Promise((r) => setTimeout(r, 100))
    }

    this.uploadQueue = []
    log.info(`Obsidian bulk import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`)

    // Mark initial import done
    const { settingsService: settings } = await import('../settings/SettingsService')
    settings.set('obsidian.initialImportDone', true)

    return { imported, skipped, errors }
  }

  private uploadQueue: Array<{ path: string; content: string }> = []

  // Manual sync — push all new reports since last sync
  async manualSync(): Promise<{ synced: number; errors: number }> {
    const config = this.getConfig()
    if (!config?.apiKey) throw new Error('Obsidian not configured')

    const folder = config.syncFolder || 'Heimdall'
    const { app: electronApp } = await import('electron')
    const { join } = await import('path')
    const { readdirSync, readFileSync, statSync } = await import('fs')

    const memoryDir = join(electronApp.getPath('home'), '.heimdall', 'memory')
    let synced = 0
    let errors = 0

    // Get list of files already in Obsidian vault under our folder
    let existingFiles: string[] = []
    try {
      existingFiles = await this.listFiles(folder)
    } catch {
      // Folder might not exist yet
    }
    const existingSet = new Set(existingFiles)

    // Walk local files and upload missing ones
    const walk = (dir: string, relativePath: string = ''): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const relPath = relativePath ? `${relativePath}/${entry}` : entry

        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath, relPath)
          } else if (entry.endsWith('.md')) {
            const obsidianPath = `${folder}/${relPath}`
            // BUG FIX: previously used `return` here which exits the entire
            // walk function on the FIRST already-synced file, leaving every
            // later file in this directory + every subdirectory un-walked.
            // `continue` skips just this file as intended.
            if (existingSet.has(obsidianPath)) continue

            const content = readFileSync(fullPath, 'utf-8')
            if (!content.trim()) continue

            this.uploadQueue.push({ path: obsidianPath, content })
          }
        } catch {
          errors++
        }
      }
    }

    walk(memoryDir)

    for (const item of this.uploadQueue) {
      try {
        await this.writeFile(item.path, item.content)
        synced++
      } catch {
        errors++
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    this.uploadQueue = []
    log.info(`Obsidian manual sync: ${synced} synced, ${errors} errors`)
    return { synced, errors }
  }

  // Check if initial import has been done
  async needsInitialImport(): Promise<boolean> {
    const { settingsService: settings } = await import('../settings/SettingsService')
    return !settings.get<boolean>('obsidian.initialImportDone')
  }
}

export const obsidianService = new ObsidianService()
