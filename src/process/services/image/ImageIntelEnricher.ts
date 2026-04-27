// ImageIntelEnricher — v1.4.1 image-intel deep pipeline.
//
// Pure derivation layer that runs after EXIF parsing. Inputs: raw
// EXIF fields + sha256. Outputs: tag list, coarse device_class, and
// a pre-built reverse-image-search URL set the analyst can launch
// from the UI without re-typing.
//
// All heuristics are deterministic and cheap — no network calls, no
// LLM. Reverse-image-search providers that need an image *upload*
// can't be deep-linked to a hash, so we only emit URL-based links
// (Yandex/Google Lens accept GET-style URL params; TinEye accepts a
// search-by-URL form). The renderer opens these in a new tab when
// the analyst chooses.
//
// Design constraint: no PII or hash leakage in default mode. The
// reverse-search URLs are *generated* but only opened if the
// analyst explicitly clicks them — they're not auto-fetched.

export type DeviceClass = 'smartphone' | 'dslr' | 'mirrorless' | 'drone' | 'surveillance' | 'screenshot' | 'unknown'

export interface EnrichedImageMeta {
  tags: string[]
  device_class: DeviceClass
  software: string | null
  reverse_search_urls: Record<string, string>
}

interface RawExifSubset {
  Make?: string
  Model?: string
  Software?: string
  LensModel?: string
  GPSLatitude?: number
  GPSLongitude?: number
  latitude?: number
  longitude?: number
  DateTimeOriginal?: string | Date
  ExifImageWidth?: number
  ExifImageHeight?: number
}

const DRONE_MAKES = ['dji', 'autel', 'parrot', 'skydio', 'yuneec', 'walkera', 'hubsan']
const SMARTPHONE_MAKES = ['apple', 'samsung', 'google', 'xiaomi', 'oneplus', 'oppo', 'vivo', 'huawei', 'motorola', 'sony mobile', 'nothing']
const DSLR_MAKES = ['canon', 'nikon', 'pentax']
const MIRRORLESS_MAKES = ['fujifilm', 'olympus', 'panasonic', 'leica', 'sigma']
const SURVEILLANCE_MAKES = ['hikvision', 'dahua', 'axis', 'bosch', 'avigilon', 'arecont', 'pelco', 'mobotix', 'samsung techwin', 'vivotek', 'reolink', 'lorex']
// Sony makes both DSLRs (Alpha) and phones — disambiguated below
const SONY_DSLR_MODEL_MARKERS = ['ilce-', 'dslr-', 'slt-', 'a7', 'a9', 'a1', 'rx']

export function enrichImageMeta(
  exif: RawExifSubset | null | undefined,
  opts: { fileName?: string | null; fileSize?: number | null } = {}
): EnrichedImageMeta {
  const tags = new Set<string>()
  const make = (exif?.Make || '').trim()
  const model = (exif?.Model || '').trim()
  const software = (exif?.Software || '').trim() || null
  const makeLower = make.toLowerCase()
  const modelLower = model.toLowerCase()

  // Geo
  const lat = exif?.latitude ?? exif?.GPSLatitude
  const lng = exif?.longitude ?? exif?.GPSLongitude
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    tags.add('geo_tagged')
    // OPSEC tag: phones strip GPS by default in 2024+; presence is unusual
    tags.add('opsec_geo_present')
  } else {
    tags.add('no_geo')
  }

  // Device class
  let deviceClass: DeviceClass = 'unknown'
  if (DRONE_MAKES.some((m) => makeLower.includes(m))) {
    deviceClass = 'drone'
    tags.add('drone')
    tags.add(`make:${makeLower.split(' ')[0]}`)
  } else if (SMARTPHONE_MAKES.some((m) => makeLower.includes(m))) {
    deviceClass = 'smartphone'
    tags.add('smartphone')
    if (makeLower.includes('apple')) tags.add('ios')
    else tags.add('android')
    tags.add(`make:${makeLower.split(' ')[0]}`)
  } else if (SURVEILLANCE_MAKES.some((m) => makeLower.includes(m))) {
    deviceClass = 'surveillance'
    tags.add('surveillance_camera')
    tags.add(`make:${makeLower.split(' ')[0]}`)
  } else if (DSLR_MAKES.some((m) => makeLower.includes(m))) {
    deviceClass = 'dslr'
    tags.add('dslr')
    tags.add(`make:${makeLower}`)
  } else if (MIRRORLESS_MAKES.some((m) => makeLower.includes(m))) {
    deviceClass = 'mirrorless'
    tags.add('mirrorless')
    tags.add(`make:${makeLower}`)
  } else if (makeLower === 'sony' || makeLower.startsWith('sony ')) {
    if (SONY_DSLR_MODEL_MARKERS.some((m) => modelLower.includes(m))) {
      deviceClass = 'mirrorless'
      tags.add('mirrorless')
    } else {
      deviceClass = 'smartphone'
      tags.add('smartphone'); tags.add('android')
    }
    tags.add('make:sony')
  }

  // Screenshot heuristic — no Make + Software field present + small size
  if (!make && software && /screenshot|screen capture/i.test(software)) {
    deviceClass = 'screenshot'
    tags.add('screenshot')
  }

  // Editor signatures
  if (software) {
    const sw = software.toLowerCase()
    if (sw.includes('photoshop') || sw.includes('lightroom') || sw.includes('affinity') || sw.includes('gimp') || sw.includes('pixelmator')) {
      tags.add('edited')
      tags.add(`editor:${sw.split(' ')[0]}`)
    }
    if (sw.includes('snapseed') || sw.includes('vsco') || sw.includes('facetune')) {
      tags.add('mobile_edited')
    }
  }

  // Aspect / orientation
  const w = exif?.ExifImageWidth, h = exif?.ExifImageHeight
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
    if (w === h) tags.add('square')
    else if (w / h > 1.6) tags.add('panorama')
    else if (h / w > 1.6) tags.add('portrait_tall')
  }

  // No-EXIF case (often re-saved or stripped — chain-of-custody concern)
  if (!exif || (!make && !software && lat == null)) {
    tags.add('exif_stripped')
  }

  // File-size heuristics
  if (opts.fileSize != null) {
    if (opts.fileSize < 50_000) tags.add('low_resolution')
    else if (opts.fileSize > 8_000_000) tags.add('high_resolution')
  }

  // Reverse-image-search hints — only meaningful if we have an
  // accessible URL form. We emit URL templates the renderer can
  // populate when the source_path is a public URL; for local files
  // these are placeholder hints the analyst can use after upload.
  const reverse = buildReverseSearchUrls(opts.fileName ?? null, exif?.GPSLatitude as number | undefined, exif?.GPSLongitude as number | undefined)

  return {
    tags: Array.from(tags),
    device_class: deviceClass,
    software,
    reverse_search_urls: reverse
  }
}

/**
 * Reverse-image-search hint URLs. None of these need an API key.
 * The renderer opens them in the system browser when the analyst
 * clicks — we never fetch them automatically (OPSEC: would leak
 * the analyst's IP + the image's existence to the search engine).
 */
function buildReverseSearchUrls(
  fileName: string | null,
  lat: number | undefined,
  lng: number | undefined
): Record<string, string> {
  const out: Record<string, string> = {
    google_lens: 'https://lens.google.com/uploadbyurl?url=__IMAGE_URL__',
    tineye: 'https://tineye.com/search?url=__IMAGE_URL__',
    yandex: 'https://yandex.com/images/search?rpt=imageview&url=__IMAGE_URL__',
    bing: 'https://www.bing.com/images/search?view=detailv2&iss=sbiupload&q=imgurl:__IMAGE_URL__'
  }
  // If we have geo, add a location-corroboration link
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    out.osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`
    out.google_maps = `https://www.google.com/maps/@${lat},${lng},15z`
  }
  // If we have a file name, add a Google text search for the (often
  // descriptive) filename — sometimes catches re-shares using the
  // original name.
  if (fileName && /[a-zA-Z]{4,}/.test(fileName)) {
    const q = encodeURIComponent(fileName.replace(/\.[a-z0-9]+$/i, ''))
    out.google_filename = `https://www.google.com/search?q=${q}`
  }
  return out
}
