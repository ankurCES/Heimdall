import http from 'http'
import crypto from 'crypto'
import log from 'electron-log'
import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { stixService } from '../stix/StixService'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 7.6 completion — TAXII 2.1 server.
 *
 * Minimal local-host TAXII 2.1 server (OASIS spec). Partners configure
 * their TIP with Heimdall's URL + API token; Heimdall serves STIX
 * bundles via standard endpoints. HTTP only for localhost; deployers
 * should front with reverse-proxy TLS if exposing beyond the host.
 *
 * Settings (settings store under 'taxii'):
 *   {
 *     enabled: false,
 *     bind: '127.0.0.1',
 *     port: 35001,
 *     api_token: '<random>',
 *     collection_id: 'heimdall-default',
 *     window_days: 30
 *   }
 *
 * Endpoints:
 *   GET /taxii2/                              → discovery
 *   GET /taxii2/api/                          → api-root
 *   GET /taxii2/api/collections/              → collections list
 *   GET /taxii2/api/collections/{id}/         → collection metadata
 *   GET /taxii2/api/collections/{id}/objects/ → STIX bundle
 *
 * All endpoints require the Authorization header to match api_token.
 */

interface TaxiiConfig {
  enabled?: boolean
  bind?: string
  port?: number
  api_token?: string
  collection_id?: string
  window_days?: number
}

export class TaxiiServer {
  private server: http.Server | null = null
  private currentBind = ''
  private currentPort = 0

  private config(): Required<TaxiiConfig> {
    const c = settingsService.get<TaxiiConfig>('taxii') ?? {}
    return {
      enabled: c.enabled ?? false,
      bind: c.bind ?? '127.0.0.1',
      port: c.port ?? 35001,
      api_token: c.api_token ?? '',
      collection_id: c.collection_id ?? 'heimdall-default',
      window_days: c.window_days ?? 30
    }
  }

  isRunning(): boolean { return this.server !== null }

  async ensureRunning(): Promise<void> {
    const cfg = this.config()
    if (!cfg.enabled) { if (this.server) await this.stop(); return }
    if (this.server && this.currentBind === cfg.bind && this.currentPort === cfg.port) return
    await this.stop()
    if (!cfg.api_token) throw new Error('TAXII api_token not set')
    await this.start()
  }

  async start(): Promise<void> {
    const cfg = this.config()
    if (this.server) await this.stop()
    this.server = http.createServer((req, res) => this.handle(req, res, cfg))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(cfg.port, cfg.bind, () => {
        this.currentBind = cfg.bind
        this.currentPort = cfg.port
        log.info(`TAXII: listening on http://${cfg.bind}:${cfg.port}/taxii2/`)
        this.logRun('started', `${cfg.bind}:${cfg.port}`, cfg.collection_id)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
    this.logRun('stopped', `${this.currentBind}:${this.currentPort}`, null)
    log.info('TAXII: stopped')
  }

  rotateToken(): string {
    const token = `tx-${crypto.randomBytes(24).toString('hex')}`
    const cur = settingsService.get<TaxiiConfig>('taxii') ?? {}
    settingsService.set('taxii', { ...cur, api_token: token })
    try {
      auditChainService.append('taxii.token_rotate', { entityType: 'taxii', entityId: 'self', payload: {} })
    } catch { /* noop */ }
    return token
  }

  private logRun(event: string, bind: string, collectionId: string | null): void {
    try {
      const db = getDatabase()
      db.prepare(
        'INSERT INTO taxii_server_runs (event, bind, collection_id, created_at) VALUES (?, ?, ?, ?)'
      ).run(event, bind, collectionId, Date.now())
    } catch { /* noop */ }
  }

  recentRuns(limit = 50): Array<{ id: number; event: string; bind: string | null; collection_id: string | null; created_at: number }> {
    try {
      const db = getDatabase()
      return db.prepare('SELECT id, event, bind, collection_id, created_at FROM taxii_server_runs ORDER BY id DESC LIMIT ?').all(limit) as Array<{ id: number; event: string; bind: string | null; collection_id: string | null; created_at: number }>
    } catch { return [] }
  }

  private authed(req: http.IncomingMessage, cfg: Required<TaxiiConfig>): boolean {
    const auth = req.headers['authorization'] || ''
    if (!auth) return false
    const token = Array.isArray(auth) ? auth[0] : auth
    const expected = `Bearer ${cfg.api_token}`
    // Constant-time compare.
    const a = Buffer.from(token); const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/taxii+json;version=2.1' })
    res.end(JSON.stringify(body))
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, cfg: Required<TaxiiConfig>): void {
    const path = (req.url || '').split('?')[0]

    // Unauthenticated discovery (spec allows it). Everything else auth'd.
    if (path === '/taxii2/' || path === '/taxii2') {
      return this.json(res, 200, {
        title: 'Heimdall TAXII 2.1',
        description: 'Heimdall local TAXII endpoint — STIX 2.1 bundles over HTTP',
        contact: 'operator@heimdall.local',
        default: `http://${cfg.bind}:${cfg.port}/taxii2/api/`,
        api_roots: [`http://${cfg.bind}:${cfg.port}/taxii2/api/`]
      })
    }

    if (!this.authed(req, cfg)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Unauthorized', hint: 'Provide Authorization: Bearer <api_token>' }))
    }

    if (path === '/taxii2/api/' || path === '/taxii2/api') {
      return this.json(res, 200, {
        title: 'Heimdall default API root',
        description: 'Default API root',
        versions: ['application/taxii+json;version=2.1'],
        max_content_length: 50 * 1024 * 1024
      })
    }

    if (path === '/taxii2/api/collections/' || path === '/taxii2/api/collections') {
      return this.json(res, 200, {
        collections: [{
          id: cfg.collection_id,
          title: 'Heimdall default collection',
          description: `STIX 2.1 bundles covering the last ${cfg.window_days} days`,
          can_read: true, can_write: false,
          media_types: ['application/stix+json;version=2.1']
        }]
      })
    }

    const collMatch = new RegExp(`^/taxii2/api/collections/${escapeRe(cfg.collection_id)}/?$`).exec(path)
    if (collMatch) {
      return this.json(res, 200, {
        id: cfg.collection_id, title: 'Heimdall default collection', can_read: true, can_write: false,
        media_types: ['application/stix+json;version=2.1']
      })
    }

    const objectsMatch = new RegExp(`^/taxii2/api/collections/${escapeRe(cfg.collection_id)}/objects/?$`).exec(path)
    if (objectsMatch) {
      try {
        // Materialise a bundle on the fly. We write to an in-memory buffer
        // via a tmp path dance — stixService.export currently requires a
        // bundle_path. For a server endpoint we want the JSON directly, so
        // we roundtrip via a tmp file.
        const tmp = require('os').tmpdir() + `/taxii-bundle-${Date.now()}.json`
        stixService.export({ bundle_path: tmp, since_ms: Date.now() - cfg.window_days * 24 * 60 * 60 * 1000 })
        const fs = require('fs') as typeof import('fs')
        const body = fs.readFileSync(tmp)
        try { fs.unlinkSync(tmp) } catch { /* noop */ }
        try {
          auditChainService.append('taxii.objects_served', {
            entityType: 'taxii', entityId: cfg.collection_id,
            payload: { bytes: body.length, remote: req.socket.remoteAddress }
          })
        } catch { /* noop */ }
        res.writeHead(200, { 'Content-Type': 'application/taxii+json;version=2.1' })
        return res.end(body)
      } catch (err) {
        log.error(`TAXII objects: ${(err as Error).message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: (err as Error).message }))
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not Found' }))
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const taxiiServer = new TaxiiServer()
