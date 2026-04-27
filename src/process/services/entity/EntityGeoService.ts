// EntityGeoService — v1.7.2 geo-pin overlay for the entity timeline.
//
// Plots every mention of one canonical entity (and its aliases) that
// has actual lat/long. Two source corpora carry coordinates today:
//
//   intel_reports     — explicit latitude/longitude columns. Joined
//                       to intel_entities via canonical_id (exact
//                       match — never wrong).
//   image_evidence    — EXIF-derived GPS, FTS5 MATCH on the alias
//                       set so we surface camera captures whose
//                       file_name / camera_make / tags reference
//                       the entity.
//
// Transcripts and HUMINT are excluded (no native geo); briefings
// are excluded (synthesised content, not a reporting location).
//
// Bounds are computed for the renderer so it can fit the map to
// the pin set without re-walking the array.

import log from 'electron-log'
import { getDatabase } from '../database'

export type GeoPinKind = 'intel' | 'image'

export interface GeoPin {
  kind: GeoPinKind
  id: string
  title: string
  ts: number
  lat: number
  lng: number
  meta: {
    discipline?: string
    severity?: string
    sourceName?: string
    cameraMake?: string | null
    cameraModel?: string | null
  }
}

export interface EntityGeoPayload {
  source_canonical_id: string
  source_canonical_value: string
  pins: GeoPin[]
  bounds: { sw: [number, number]; ne: [number, number] } | null
  by_kind: Record<GeoPinKind, number>
}

const DEFAULT_LIMIT_PER_CORPUS = 200

export class EntityGeoService {
  getPins(canonicalId: string, limitPerCorpus = DEFAULT_LIMIT_PER_CORPUS): EntityGeoPayload | null {
    const db = getDatabase()
    const source = db.prepare(`
      SELECT id, canonical_value FROM canonical_entities WHERE id = ?
    `).get(canonicalId) as { id: string; canonical_value: string } | undefined
    if (!source) return null

    const aliasRows = db.prepare(`
      SELECT DISTINCT entity_value FROM intel_entities WHERE canonical_id = ?
    `).all(canonicalId) as Array<{ entity_value: string }>
    const aliases = aliasRows.map((a) => a.entity_value)
    if (!aliases.includes(source.canonical_value)) aliases.unshift(source.canonical_value)

    const pins: GeoPin[] = []

    // ── intel: exact join via canonical_id ──────────────────────────
    try {
      const rows = db.prepare(`
        SELECT DISTINCT
          r.id              AS id,
          r.title           AS title,
          r.discipline      AS discipline,
          r.severity        AS severity,
          r.source_name     AS source_name,
          r.created_at      AS ts,
          r.latitude        AS lat,
          r.longitude       AS lng
        FROM intel_entities e
        JOIN intel_reports r ON r.id = e.report_id
        WHERE e.canonical_id = ?
          AND COALESCE(r.quarantined, 0) = 0
          AND r.latitude IS NOT NULL
          AND r.longitude IS NOT NULL
        ORDER BY r.created_at DESC
        LIMIT ?
      `).all(canonicalId, limitPerCorpus) as Array<{
        id: string; title: string; discipline: string; severity: string
        source_name: string | null; ts: number; lat: number; lng: number
      }>
      for (const r of rows) {
        if (!isFiniteCoord(r.lat, r.lng)) continue
        pins.push({
          kind: 'intel',
          id: r.id,
          title: r.title || '(untitled intel)',
          ts: r.ts,
          lat: r.lat,
          lng: r.lng,
          meta: {
            discipline: r.discipline,
            severity: r.severity,
            sourceName: r.source_name ?? undefined
          }
        })
      }
    } catch (err) { log.debug(`entity-geo: intel pass failed: ${err}`) }

    // ── image_evidence: FTS5 MATCH on aliases + non-null GPS ────────
    const ftsQuery = aliases
      .filter((a) => a && a.length >= 2)
      .map((a) => `"${a.replace(/"/g, '')}"`)
      .join(' OR ')
    if (ftsQuery) {
      try {
        const rows = db.prepare(`
          SELECT
            i.id            AS id,
            i.file_name     AS file_name,
            i.camera_make   AS camera_make,
            i.camera_model  AS camera_model,
            i.ingested_at   AS ts,
            i.latitude      AS lat,
            i.longitude     AS lng
          FROM image_evidence_fts
          JOIN image_evidence i ON i.rowid = image_evidence_fts.rowid
          WHERE image_evidence_fts MATCH ?
            AND i.latitude IS NOT NULL
            AND i.longitude IS NOT NULL
          ORDER BY bm25(image_evidence_fts)
          LIMIT ?
        `).all(ftsQuery, limitPerCorpus) as Array<{
          id: string; file_name: string | null
          camera_make: string | null; camera_model: string | null
          ts: number; lat: number; lng: number
        }>
        for (const r of rows) {
          if (!isFiniteCoord(r.lat, r.lng)) continue
          pins.push({
            kind: 'image',
            id: r.id,
            title: r.file_name || r.id,
            ts: r.ts,
            lat: r.lat,
            lng: r.lng,
            meta: {
              cameraMake: r.camera_make,
              cameraModel: r.camera_model
            }
          })
        }
      } catch (err) { log.debug(`entity-geo: image pass failed: ${err}`) }
    }

    pins.sort((a, b) => b.ts - a.ts)

    const byKind: Record<GeoPinKind, number> = { intel: 0, image: 0 }
    for (const p of pins) byKind[p.kind]++

    let bounds: EntityGeoPayload['bounds'] = null
    if (pins.length > 0) {
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
      for (const p of pins) {
        if (p.lat < minLat) minLat = p.lat
        if (p.lat > maxLat) maxLat = p.lat
        if (p.lng < minLng) minLng = p.lng
        if (p.lng > maxLng) maxLng = p.lng
      }
      bounds = { sw: [minLat, minLng], ne: [maxLat, maxLng] }
    }

    return {
      source_canonical_id: source.id,
      source_canonical_value: source.canonical_value,
      pins,
      bounds,
      by_kind: byKind
    }
  }
}

/** Reject NaN, Infinity, and out-of-range coords so the renderer
 *  never gets a leaflet "Invalid LatLng" exception. */
function isFiniteCoord(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180
}

export const entityGeoService = new EntityGeoService()
