// ModelDownloadManager — v1.4.3 seamless local-model bootstrapper.
//
// Goal: when an analyst boots Heimdall for the first time, every local
// AI asset Heimdall *can* run offline gets fetched in the background
// without anyone having to open a terminal. Existing installs see no
// change unless they delete a file.
//
// Behaviour:
//   - On startup, ensureRequired() scans the registry and downloads
//     every non-optional asset that's missing. Runs in setImmediate so
//     it never blocks UI / IPC.
//   - Downloads are atomic: bytes land in <dest>.part, then renamed on
//     success. Crashes mid-download leave .part for resume.
//   - HTTP Range support — interrupted downloads resume from where
//     they left off (HuggingFace + GitHub releases honour Range).
//   - SHA-256 verification when the registry provides a hash. A bad
//     hash deletes the file and surfaces a clear error.
//   - Progress events fire on EventEmitter and are forwarded to the
//     renderer via modelsBridge so the Settings → Models tab can show
//     live MB/sec + a percent bar.
//   - Manifest at <userData>/models/manifest.json records install
//     timestamps + hashes for audit / debugging.
//
// Design constraints (Heimdall-wide):
//   - Net access goes through SafeFetcher so air-gap mode + outbound
//     allow-lists are enforced. If the deployment forbids the
//     download host, ensureRequired() is a no-op.
//   - All file paths live under <userData>/models/, never the app
//     bundle (read-only on macOS / Windows installers).

import fs from 'fs/promises'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { app } from 'electron'
import log from 'electron-log'
import { settingsService } from '../settings/SettingsService'
import { safeFetcher } from '../../collectors/SafeFetcher'
import {
  DEFAULT_REGISTRY,
  absolutePath,
  resolveDownloadTarget,
  type ManagedAsset
} from './ModelRegistry'

export type AssetState =
  | 'missing'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'error'
  | 'unsupported_platform'
  | 'disabled'

export interface AssetStatus {
  id: string
  description: string
  state: AssetState
  destPath: string
  bytesDone: number
  bytesTotal: number | null
  progress: number             // 0..1
  rateBps: number              // bytes/sec instantaneous
  error: string | null
  installedAt: number | null
  sha256?: string
  optional: boolean
  requiredBy: string[]
}

interface ManifestEntry {
  id: string
  destPath: string
  sha256?: string
  installedAt: number
  sizeBytes: number
}

interface Manifest {
  version: 1
  installed: Record<string, ManifestEntry>
}

const PROGRESS_EVENT_INTERVAL_MS = 250  // throttle UI updates

export class ModelDownloadManager extends EventEmitter {
  private statuses = new Map<string, AssetStatus>()
  private inflight = new Map<string, AbortController>()
  private modelsRoot: string
  private manifestPath: string
  private manifest: Manifest = { version: 1, installed: {} }
  private started = false

  constructor() {
    super()
    this.modelsRoot = path.join(app.getPath('userData'), 'models')
    this.manifestPath = path.join(this.modelsRoot, 'manifest.json')
  }

  /** Initialize state from disk. Idempotent — safe to call multiple times. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    mkdirSync(this.modelsRoot, { recursive: true })
    await this.loadManifest()
    for (const asset of DEFAULT_REGISTRY) {
      this.statuses.set(asset.id, this.computeInitialStatus(asset))
    }
    log.info(`models: registry loaded — ${DEFAULT_REGISTRY.length} asset(s); root=${this.modelsRoot}`)
  }

  /** Background-fetch every non-optional asset that isn't ready yet.
   *  Returns immediately; download runs concurrently. */
  ensureRequired(): void {
    const enabled = settingsService.get<boolean>('models.autoDownload') ?? true
    if (!enabled) {
      log.info('models: auto-download disabled in settings; skipping ensureRequired()')
      return
    }
    const missing = DEFAULT_REGISTRY.filter((a) => {
      if (a.optional) return false
      const s = this.statuses.get(a.id)
      return s?.state === 'missing'
    })
    if (!missing.length) {
      log.info('models: all required assets present')
      return
    }
    log.info(`models: ensureRequired — ${missing.length} asset(s) to fetch in background`)
    // Fire-and-forget; each download manages its own status.
    void Promise.all(missing.map((a) => this.downloadOne(a.id).catch((err) =>
      log.warn(`models: ${a.id} background download failed: ${err.message ?? err}`)
    )))
  }

  /** Snapshot of every asset's current status. Used by modelsBridge:list. */
  list(): AssetStatus[] {
    return DEFAULT_REGISTRY.map((a) => this.statuses.get(a.id) ?? this.computeInitialStatus(a))
  }

  status(id: string): AssetStatus | null {
    return this.statuses.get(id) ?? null
  }

  /** Resolve the on-disk path for a managed asset, or null if not installed.
   *  Consumers (TranscriptionService etc.) call this to find the file. */
  path(id: string): string | null {
    const s = this.statuses.get(id)
    if (!s || s.state !== 'ready') return null
    return s.destPath
  }

  /** Cancel an in-flight download. The .part file is preserved for resume. */
  cancel(id: string): void {
    const ctrl = this.inflight.get(id)
    if (!ctrl) return
    ctrl.abort()
    this.inflight.delete(id)
    const s = this.statuses.get(id)
    if (s && s.state === 'downloading') {
      this.update(id, { state: 'missing', rateBps: 0 })
    }
  }

  /** Force-re-download an asset. Wipes any existing file + .part. */
  async reinstall(id: string): Promise<void> {
    const asset = DEFAULT_REGISTRY.find((a) => a.id === id)
    if (!asset) throw new Error(`Unknown asset: ${id}`)
    const dest = absolutePath(asset.destPath)
    try { await fs.unlink(dest) } catch { /* */ }
    try { await fs.unlink(`${dest}.part`) } catch { /* */ }
    delete this.manifest.installed[id]
    await this.saveManifest()
    this.statuses.set(id, this.computeInitialStatus(asset))
    return this.downloadOne(id)
  }

  /** Download one asset by id. Throws on failure. */
  async downloadOne(id: string): Promise<void> {
    const asset = DEFAULT_REGISTRY.find((a) => a.id === id)
    if (!asset) throw new Error(`Unknown asset: ${id}`)
    if (this.inflight.has(id)) {
      log.debug(`models: ${id} already downloading; skipping duplicate request`)
      return
    }

    const target = resolveDownloadTarget(asset)
    if (!target.url) {
      this.update(id, { state: 'unsupported_platform', error: `No build for ${process.platform}-${process.arch}` })
      throw new Error(`unsupported platform for ${id}`)
    }

    const dest = absolutePath(asset.destPath)
    mkdirSync(path.dirname(dest), { recursive: true })
    const partPath = `${dest}.part`

    let resumeFrom = 0
    if (existsSync(partPath)) {
      try { resumeFrom = statSync(partPath).size } catch { resumeFrom = 0 }
    }

    const ctrl = new AbortController()
    this.inflight.set(id, ctrl)
    this.update(id, { state: 'downloading', error: null, bytesDone: resumeFrom })

    let writer: ReturnType<typeof createWriteStream> | null = null
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Heimdall/1.4 (model-fetch)'
      }
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

      // SafeFetcher honours air-gap + allow-list and uses Tor when configured
      const resp = await safeFetcher.fetch(target.url, {
        headers,
        signal: ctrl.signal,
        timeout: 6 * 60 * 60 * 1000   // 6h ceiling for huge models
      })

      if (resp.status === 416) {
        // Range not satisfiable — server says we already have the file
        log.info(`models: ${id} reports complete via 416, finalising`)
      } else if (!resp.ok && !(resp.status === 206 && resumeFrom > 0)) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
      }

      const totalRaw = resp.headers.get('content-length')
      const contentLength = totalRaw ? parseInt(totalRaw, 10) : null
      const totalBytes = contentLength != null
        ? (resumeFrom > 0 && resp.status === 206 ? resumeFrom + contentLength : contentLength)
        : (target.sizeBytes ?? null)
      this.update(id, { bytesTotal: totalBytes })

      // Stream body → .part
      const append = resumeFrom > 0 && resp.status === 206
      writer = createWriteStream(partPath, { flags: append ? 'a' : 'w' })

      let bytes = resumeFrom
      let lastEmit = Date.now()
      let lastEmitBytes = bytes

      // resp.body is a web ReadableStream in Node 18+ / undici
      if (!resp.body) throw new Error('Empty response body')
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value) continue
          if (!writer.write(Buffer.from(value))) {
            await new Promise<void>((res) => writer!.once('drain', res))
          }
          bytes += value.byteLength
          const now = Date.now()
          if (now - lastEmit >= PROGRESS_EVENT_INTERVAL_MS) {
            const dt = (now - lastEmit) / 1000
            const rate = dt > 0 ? Math.round((bytes - lastEmitBytes) / dt) : 0
            const progress = totalBytes ? Math.min(1, bytes / totalBytes) : 0
            this.update(id, { bytesDone: bytes, progress, rateBps: rate })
            lastEmit = now
            lastEmitBytes = bytes
          }
        }
      } finally {
        try { reader.releaseLock() } catch { /* */ }
      }

      await new Promise<void>((res, rej) => writer!.end((err?: Error | null) => err ? rej(err) : res()))
      writer = null

      // Verify size if we know it
      const finalSize = statSync(partPath).size
      if (totalBytes != null && finalSize < totalBytes * 0.95) {
        throw new Error(`Truncated download (${finalSize}/${totalBytes} bytes)`)
      }

      // Verify sha256
      if (target.sha256) {
        this.update(id, { state: 'verifying' })
        const got = await sha256OfFile(partPath)
        if (got !== target.sha256) {
          await fs.unlink(partPath).catch(() => {})
          throw new Error(`SHA-256 mismatch — expected ${target.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`)
        }
      }

      // Atomic rename .part → final
      await fs.rename(partPath, dest)

      // chmod +x for binaries on Unix
      if (asset.executable && process.platform !== 'win32') {
        try { await fs.chmod(dest, 0o755) } catch { /* */ }
      }

      const installedAt = Date.now()
      this.manifest.installed[id] = {
        id, destPath: asset.destPath, sha256: target.sha256, installedAt, sizeBytes: finalSize
      }
      await this.saveManifest()
      this.update(id, {
        state: 'ready', bytesDone: finalSize, bytesTotal: finalSize,
        progress: 1, rateBps: 0, installedAt, sha256: target.sha256
      })
      log.info(`models: ${id} installed (${(finalSize / 1024 / 1024).toFixed(1)} MB${target.sha256 ? `, sha256=${target.sha256.slice(0, 8)}…` : ''})`)
    } catch (err) {
      const e = err as Error
      const aborted = e.name === 'AbortError' || /aborted/i.test(e.message)
      try { writer?.destroy() } catch { /* */ }
      if (!aborted) {
        log.warn(`models: ${id} download failed: ${e.message}`)
        this.update(id, { state: 'error', error: e.message, rateBps: 0 })
      } else {
        this.update(id, { state: 'missing', rateBps: 0 })
      }
      if (!aborted) throw e
    } finally {
      this.inflight.delete(id)
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private computeInitialStatus(asset: ManagedAsset): AssetStatus {
    const dest = absolutePath(asset.destPath)
    const installed = this.manifest.installed[asset.id]
    let state: AssetState = 'missing'
    let bytesDone = 0
    let bytesTotal: number | null = asset.sizeBytes ?? null
    let installedAt: number | null = null

    if (existsSync(dest)) {
      try {
        const sz = statSync(dest).size
        bytesDone = sz
        bytesTotal = sz
        state = 'ready'
        installedAt = installed?.installedAt ?? null
      } catch { /* */ }
    } else if (existsSync(`${dest}.part`)) {
      try {
        bytesDone = statSync(`${dest}.part`).size
      } catch { /* */ }
    }

    return {
      id: asset.id,
      description: asset.description,
      state,
      destPath: dest,
      bytesDone,
      bytesTotal,
      progress: bytesTotal && bytesTotal > 0 ? Math.min(1, bytesDone / bytesTotal) : (state === 'ready' ? 1 : 0),
      rateBps: 0,
      error: null,
      installedAt,
      sha256: asset.sha256,
      optional: asset.optional ?? false,
      requiredBy: asset.requiredBy
    }
  }

  private update(id: string, patch: Partial<AssetStatus>): void {
    const cur = this.statuses.get(id)
    if (!cur) return
    const next = { ...cur, ...patch }
    this.statuses.set(id, next)
    this.emit('status', next)
  }

  private async loadManifest(): Promise<void> {
    try {
      const raw = await fs.readFile(this.manifestPath, 'utf-8')
      const parsed = JSON.parse(raw) as Manifest
      if (parsed.version === 1 && parsed.installed) this.manifest = parsed
    } catch {
      this.manifest = { version: 1, installed: {} }
    }
  }

  private async saveManifest(): Promise<void> {
    try {
      await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8')
    } catch (err) {
      log.warn(`models: manifest write failed: ${(err as Error).message}`)
    }
  }
}

async function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = createReadStream(p)
    s.on('data', (chunk) => h.update(chunk))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex').toLowerCase()))
  })
}

export const modelDownloadManager = new ModelDownloadManager()
