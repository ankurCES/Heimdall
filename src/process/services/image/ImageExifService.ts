import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import exifr from 'exifr'
import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { enrichImageMeta, type EnrichedImageMeta } from './ImageIntelEnricher'

/**
 * Theme 8.1 — Image EXIF + geolocation extraction.
 *
 * Reads the requested image, computes a SHA-256 fingerprint (for
 * deduplication), and extracts the subset of EXIF fields that matter
 * for intelligence work:
 *   - GPS (lat/lng/alt + HDOP-derived accuracy estimate)
 *   - Capture timestamp (DateTimeOriginal, preferred over ModifyDate)
 *   - Camera make / model / lens model
 *   - Orientation + dimensions
 *
 * Stores a row in image_evidence with the raw EXIF payload JSON-stringified
 * for analyst drilldown. Does NOT phone out to reverse-image-search APIs
 * in this batch — that's a follow-up that needs per-deployer API keys.
 *
 * Security note: EXIF parsing is the source of a number of historical
 * vulnerabilities. exifr is a pure-JS parser with no native deps, which
 * narrows the attack surface; we still run this in the main process so a
 * bad parse can't crash the renderer.
 */

export interface ImageEvidence {
  id: string
  source_path: string
  source_kind: 'file' | 'url'
  file_name: string | null
  file_size: number | null
  mime_type: string | null
  sha256: string | null
  report_id: string | null
  latitude: number | null
  longitude: number | null
  altitude_m: number | null
  captured_at: number | null
  camera_make: string | null
  camera_model: string | null
  lens_model: string | null
  orientation: number | null
  width: number | null
  height: number | null
  gps_accuracy_m: number | null
  raw_exif: string | null
  ingested_at: number
  // v1.4.1 deep-pipeline enrichment columns (migration 046)
  tags_json?: string | null
  reverse_search_json?: string | null
  device_class?: string | null
  software?: string | null
}

export class ImageExifService {
  async ingestFile(filePath: string, reportId?: string | null): Promise<ImageEvidence> {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`)
    const buf = await fs.readFile(filePath)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')

    // Dedup: if an image with the same sha has already been ingested, link
    // to it rather than re-reading EXIF.
    const db = getDatabase()
    const existing = db.prepare(
      'SELECT id FROM image_evidence WHERE sha256 = ? LIMIT 1'
    ).get(sha) as { id: string } | undefined
    if (existing) {
      return this.get(existing.id)!
    }

    const meta = await this.parseExif(buf)

    const id = generateId()
    const now = Date.now()
    const name = path.basename(filePath)
    const mime = this.guessMime(name, buf)

    // v1.4.1 deep enrichment — derive tags + device class + reverse-image
    // search hints from the raw EXIF (pure, deterministic, no network).
    let enriched: EnrichedImageMeta | null = null
    try {
      const rawParsed = meta.raw_exif ? JSON.parse(meta.raw_exif) as Record<string, unknown> : null
      enriched = enrichImageMeta(rawParsed as never, { fileName: name, fileSize: stat.size })
    } catch (err) {
      log.debug(`image-exif: enrich failed: ${err}`)
    }

    db.prepare(`
      INSERT INTO image_evidence
        (id, source_path, source_kind, file_name, file_size, mime_type, sha256,
         report_id, latitude, longitude, altitude_m, captured_at,
         camera_make, camera_model, lens_model, orientation, width, height,
         gps_accuracy_m, raw_exif, ingested_at,
         tags_json, reverse_search_json, device_class, software)
      VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, filePath, name, stat.size, mime, sha,
      reportId ?? null,
      meta.latitude, meta.longitude, meta.altitude_m, meta.captured_at,
      meta.camera_make, meta.camera_model, meta.lens_model,
      meta.orientation, meta.width, meta.height,
      meta.gps_accuracy_m, meta.raw_exif, now,
      enriched ? JSON.stringify(enriched.tags) : null,
      enriched ? JSON.stringify(enriched.reverse_search_urls) : null,
      enriched?.device_class ?? null,
      enriched?.software ?? null
    )

    log.info(`image-exif: ingested ${name} (${stat.size} B) → ${id}${enriched?.device_class && enriched.device_class !== 'unknown' ? ` [${enriched.device_class}]` : ''} ${meta.latitude != null ? `geo=${meta.latitude.toFixed(4)},${meta.longitude!.toFixed(4)}` : 'no geo'}${enriched?.tags.length ? ` tags=${enriched.tags.slice(0, 4).join(',')}` : ''}`)

    return this.get(id)!
  }

  /** Parse a buffer without persisting. Useful for drag-and-drop preview. */
  async previewBuffer(buf: Buffer): Promise<Partial<ImageEvidence>> {
    return this.parseExif(buf)
  }

  private async parseExif(buf: Buffer): Promise<Partial<ImageEvidence>> {
    try {
      const parsed = await exifr.parse(buf, {
        gps: true, pick: [
          'Make', 'Model', 'LensModel', 'DateTimeOriginal', 'CreateDate',
          'ModifyDate', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
          'GPSHPositioningError', 'GPSDOP', 'Orientation',
          'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight',
          'latitude', 'longitude'
        ]
      }) as Record<string, unknown> | undefined

      if (!parsed) return { raw_exif: null }

      const capturedAt = (parsed.DateTimeOriginal || parsed.CreateDate || parsed.ModifyDate) as Date | string | undefined
      const capturedMs = capturedAt ? new Date(capturedAt as string).getTime() : null
      const lat = parsed.latitude as number | undefined ?? parsed.GPSLatitude as number | undefined
      const lng = parsed.longitude as number | undefined ?? parsed.GPSLongitude as number | undefined

      return {
        latitude: typeof lat === 'number' ? lat : null,
        longitude: typeof lng === 'number' ? lng : null,
        altitude_m: typeof parsed.GPSAltitude === 'number' ? parsed.GPSAltitude as number : null,
        gps_accuracy_m: typeof parsed.GPSHPositioningError === 'number'
          ? parsed.GPSHPositioningError as number
          : (typeof parsed.GPSDOP === 'number' ? parsed.GPSDOP as number * 5 : null),
        captured_at: Number.isFinite(capturedMs) ? capturedMs : null,
        camera_make: typeof parsed.Make === 'string' ? parsed.Make as string : null,
        camera_model: typeof parsed.Model === 'string' ? parsed.Model as string : null,
        lens_model: typeof parsed.LensModel === 'string' ? parsed.LensModel as string : null,
        orientation: typeof parsed.Orientation === 'number' ? parsed.Orientation as number : null,
        width: (parsed.ExifImageWidth as number) ?? (parsed.ImageWidth as number) ?? null,
        height: (parsed.ExifImageHeight as number) ?? (parsed.ImageHeight as number) ?? null,
        raw_exif: JSON.stringify(parsed).slice(0, 20000)
      }
    } catch (err) {
      log.warn(`image-exif: parse failed: ${(err as Error).message}`)
      return { raw_exif: null }
    }
  }

  private guessMime(name: string, buf: Buffer): string | null {
    const ext = path.extname(name).toLowerCase()
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.heic') return 'image/heic'
    if (ext === '.tif' || ext === '.tiff') return 'image/tiff'
    if (ext === '.webp') return 'image/webp'
    // Magic bytes fallback.
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    return null
  }

  get(id: string): ImageEvidence | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, source_path, source_kind, file_name, file_size, mime_type, sha256,
             report_id, latitude, longitude, altitude_m, captured_at,
             camera_make, camera_model, lens_model, orientation, width, height,
             gps_accuracy_m, raw_exif, ingested_at,
             tags_json, reverse_search_json, device_class, software
      FROM image_evidence WHERE id = ?
    `).get(id) as ImageEvidence) || null
  }

  list(opts: { limit?: number; geo_only?: boolean } = {}): ImageEvidence[] {
    const db = getDatabase()
    const limit = opts.limit ?? 100
    if (opts.geo_only) {
      return db.prepare(`
        SELECT id, source_path, source_kind, file_name, file_size, mime_type, sha256,
               report_id, latitude, longitude, altitude_m, captured_at,
               camera_make, camera_model, lens_model, orientation, width, height,
               gps_accuracy_m, raw_exif, ingested_at
        FROM image_evidence
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY ingested_at DESC LIMIT ?
      `).all(limit) as ImageEvidence[]
    }
    return db.prepare(`
      SELECT id, source_path, source_kind, file_name, file_size, mime_type, sha256,
             report_id, latitude, longitude, altitude_m, captured_at,
             camera_make, camera_model, lens_model, orientation, width, height,
             gps_accuracy_m, raw_exif, ingested_at,
             tags_json, reverse_search_json, device_class, software
      FROM image_evidence ORDER BY ingested_at DESC LIMIT ?
    `).all(limit) as ImageEvidence[]
  }

  remove(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM image_evidence WHERE id = ?').run(id)
  }

  /** v1.4.1 — list images by coarse device class (drone, smartphone, etc.). */
  listByDeviceClass(deviceClass: string, limit = 100): ImageEvidence[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, source_path, source_kind, file_name, file_size, mime_type, sha256,
             report_id, latitude, longitude, altitude_m, captured_at,
             camera_make, camera_model, lens_model, orientation, width, height,
             gps_accuracy_m, raw_exif, ingested_at,
             tags_json, reverse_search_json, device_class, software
      FROM image_evidence WHERE device_class = ?
      ORDER BY ingested_at DESC LIMIT ?
    `).all(deviceClass, limit) as ImageEvidence[]
  }

  /**
   * v1.4.1 — re-derive tags + reverse-search hints for already-ingested
   * rows that pre-date migration 046. Idempotent; safe to re-run.
   * Returns the number of rows updated.
   */
  backfillEnrichment(opts: { limit?: number } = {}): number {
    const db = getDatabase()
    const limit = opts.limit ?? 1000
    const rows = db.prepare(`
      SELECT id, file_name, file_size, raw_exif FROM image_evidence
      WHERE tags_json IS NULL ORDER BY ingested_at DESC LIMIT ?
    `).all(limit) as Array<{ id: string; file_name: string | null; file_size: number | null; raw_exif: string | null }>
    if (!rows.length) return 0
    const upd = db.prepare(`
      UPDATE image_evidence
      SET tags_json = ?, reverse_search_json = ?, device_class = ?, software = ?
      WHERE id = ?
    `)
    let touched = 0
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        let parsed: Record<string, unknown> | null = null
        try { parsed = r.raw_exif ? JSON.parse(r.raw_exif) : null } catch { /* */ }
        const e = enrichImageMeta(parsed as never, { fileName: r.file_name, fileSize: r.file_size })
        upd.run(
          JSON.stringify(e.tags),
          JSON.stringify(e.reverse_search_urls),
          e.device_class,
          e.software,
          r.id
        )
        touched++
      }
    })
    tx(rows)
    log.info(`image-exif: backfilled enrichment for ${touched} row(s)`)
    return touched
  }
}

export const imageExifService = new ImageExifService()
