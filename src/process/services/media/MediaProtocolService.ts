// MediaProtocolService — v1.4.6 custom protocol for streaming locally
// stored audio/video to the renderer's <audio>/<video> elements.
//
// Why a custom protocol:
//   - Electron's `webSecurity: true` blocks file:// URLs in rendered
//     content. We can't simply do <audio src="/Users/.../file.mp3">.
//   - Reading a 200 MB recording into a base64 data URL would peak
//     RAM at >300 MB and freeze the renderer.
//   - app:// won't work for arbitrary user files outside the bundle.
//
// What we do:
//   - Register `heimdall-media://` as a privileged scheme that supports
//     byte-range requests (so HTML5 media can seek without re-downloading).
//   - On every request, look the requested ID up in the
//     transcripts / image_evidence tables and serve the stored
//     source_path. ANY path not present in those tables is rejected;
//     the analyst can never craft a URL that escapes the whitelist.
//
// URL scheme:
//   heimdall-media://transcript/<id>     → transcripts.source_path
//   heimdall-media://image/<id>          → image_evidence.source_path
//
// The protocol is registered at app boot (before app.whenReady's
// resolution) via registerSchemesAsPrivileged, which is required for
// stream/CORS/byte-range support.

import { protocol, net, app } from 'electron'
import { existsSync, statSync } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import log from 'electron-log'
import { getDatabase, isDatabaseReady } from '../database'

const SCHEME = 'heimdall-media'

// Container formats that can be EITHER audio or video depending on
// what tracks they hold. MediaRecorder produces audio-only webm/ogg/mp4
// from the browser, but a user can also drag a video file with the same
// extensions. The browser tells us which it expects via the Accept
// header on the media request, and resolveMime() honours that.
const AMBIGUOUS_AUDIO_VIDEO_EXTS = new Set(['.webm', '.ogg', '.mp4', '.m4a'])

const MIME_BY_EXT: Record<string, { audio: string; video: string } | string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': { audio: 'audio/mp4', video: 'video/mp4' },
  '.flac': 'audio/flac',
  '.ogg': { audio: 'audio/ogg', video: 'video/ogg' },
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  // webm container holds either audio-only (MediaRecorder) or A/V tracks.
  '.webm': { audio: 'audio/webm', video: 'video/webm' },
  '.mp4': { audio: 'audio/mp4', video: 'video/mp4' },
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

/**
 * Resolve the MIME type for a file extension. For ambiguous container
 * extensions (webm, ogg, mp4, m4a) we look at the Accept header — an
 * <audio> element sends "audio/*", a <video> element sends "video/*",
 * and serving the wrong one triggers "no supported sources" in the
 * renderer. Defaulting to audio when Accept is silent matches our
 * MediaRecorder use case (mic captures from RecordButton).
 */
function resolveMime(ext: string, accept: string): string | null {
  const entry = MIME_BY_EXT[ext]
  if (!entry) return null
  if (typeof entry === 'string') return entry
  if (AMBIGUOUS_AUDIO_VIDEO_EXTS.has(ext)) {
    if (accept.includes('audio/')) return entry.audio
    if (accept.includes('video/')) return entry.video
    // Browser sent no media-class hint; default to audio (covers
    // RecordButton's <audio> element with default Accept "*/*").
    return entry.audio
  }
  return entry.video
}

/** Registered ONCE per process. Must be called before app.whenReady() so
 *  the scheme inherits stream/byte-range capabilities the same way
 *  https:// does. Calling it after a window has loaded is a no-op. */
export function registerMediaSchemeAsPrivileged(): void {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: SCHEME,
        privileges: {
          standard: true,
          supportFetchAPI: true,
          stream: true,
          bypassCSP: false,
          corsEnabled: true,
          secure: true   // required for stream + many media APIs
        }
      }
    ])
    log.info(`media-protocol: '${SCHEME}://' registered as privileged`)
  } catch (err) {
    // Calling registerSchemesAsPrivileged twice throws — safe to swallow
    log.debug(`media-protocol: privileged registration skipped: ${(err as Error).message}`)
  }
}

/** Wires the actual request handler. Must be called inside whenReady().
 *  Resolves transcript/image IDs to on-disk paths, validates the path is
 *  whitelisted, then delegates to net.fetch for byte-range support. */
export function registerMediaProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      // URL is heimdall-media://transcript/<id> or heimdall-media://image/<id>
      const u = new URL(request.url)
      const kind = u.hostname            // 'transcript' or 'image'
      const id = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
      log.info(`media-protocol: req kind=${kind} id=${id} method=${request.method} accept="${request.headers.get('accept') || ''}"`)

      if (!id) {
        log.warn(`media-protocol: id missing for ${request.url}`)
        return new Response('id missing', { status: 400 })
      }
      if (!isDatabaseReady()) {
        log.warn(`media-protocol: db not ready`)
        return new Response('db not ready', { status: 503 })
      }

      const onDiskPath = await resolvePath(kind, id)
      if (!onDiskPath) {
        log.warn(`media-protocol: no path resolved for ${kind}/${id}`)
        return new Response('not found', { status: 404 })
      }

      // Defence-in-depth: refuse any path that doesn't pass an existsSync
      // and isn't a regular file. Symlinks pointing at /etc/* would be
      // rejected by the DB lookup itself, but we re-check anyway.
      if (!existsSync(onDiskPath)) {
        log.warn(`media-protocol: file missing on disk: ${onDiskPath}`)
        return new Response('file missing', { status: 404 })
      }
      const st = statSync(onDiskPath)
      if (!st.isFile()) {
        log.warn(`media-protocol: not a regular file: ${onDiskPath}`)
        return new Response('not a file', { status: 403 })
      }

      // Ensure the path is inside a sane root (home dir or app userData)
      // — same constraint we apply in image/transcription bridges.
      const home = app.getPath('home')
      const userData = app.getPath('userData')
      const tempRoot = app.getPath('temp')
      const resolved = path.resolve(onDiskPath)
      const safe = resolved.startsWith(home) || resolved.startsWith(userData) || resolved.startsWith(tempRoot)
      if (!safe) {
        log.warn(`media-protocol: refused out-of-bounds path ${resolved}`)
        return new Response('forbidden', { status: 403 })
      }

      // net.fetch on a file:// URL handles HTTP byte-range, mime sniffing,
      // and streaming chunked reads natively. Range header propagates from
      // the renderer (HTML5 media seek) automatically.
      const fileUrl = pathToFileURL(resolved).toString()
      const response = await net.fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        // Body is undefined for GET (HTML5 media issues GET); preserved for completeness.
        body: request.body
      })

      // Override the mime type — Chromium's file:// stack often returns
      // application/octet-stream, and for ambiguous containers (webm,
      // ogg, mp4) we need to honour the Accept header so the right
      // <audio>/<video> element accepts the stream.
      const ext = path.extname(resolved).toLowerCase()
      const accept = request.headers.get('accept') || ''
      const knownMime = resolveMime(ext, accept)
      if (knownMime) {
        const headers = new Headers(response.headers)
        headers.set('content-type', knownMime)
        // Range support hint — some browsers won't seek without this.
        if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
      }
      return response
    } catch (err) {
      log.warn(`media-protocol: handler error: ${(err as Error).message}`)
      return new Response('internal error', { status: 500 })
    }
  })
  log.info(`media-protocol: '${SCHEME}://' handler registered`)
}

async function resolvePath(kind: string, id: string): Promise<string | null> {
  const db = getDatabase()
  try {
    if (kind === 'transcript') {
      const row = db.prepare(`SELECT source_path FROM transcripts WHERE id = ? LIMIT 1`).get(id) as { source_path: string } | undefined
      return row?.source_path ?? null
    }
    if (kind === 'image') {
      const row = db.prepare(`SELECT source_path FROM image_evidence WHERE id = ? LIMIT 1`).get(id) as { source_path: string } | undefined
      return row?.source_path ?? null
    }
    return null
  } catch (err) {
    log.debug(`media-protocol: resolve ${kind}/${id} failed: ${err}`)
    return null
  }
}

/** Public helper for the renderer side: builds the URL for an asset. */
export function mediaUrl(kind: 'transcript' | 'image', id: string): string {
  return `${SCHEME}://${kind}/${encodeURIComponent(id)}`
}
