// CIA CREST archive ingester — sourced via Internet Archive's mirror.
//
// CIA's own reading room (cia.gov/readingroom) is bot-blocked: every request
// returns a 302 to a session-cookie page even with realistic browser headers.
// Internet Archive maintains a 851,358-document mirror of the CREST collection
// (`collection:ciareadingroom`) with pre-OCR'd text, served via their public
// search + download endpoints.
//
// SEARCH:    https://archive.org/advancedsearch.php?q=collection:ciareadingroom+AND+<topic>&fl[]=identifier&fl[]=title&fl[]=date
// METADATA:  https://archive.org/metadata/<identifier>/files
// OCR TEXT:  https://archive.org/download/<identifier>/<docref>_djvu.txt
//
// Each ingest writes one row per document into training_corpus with:
//   - source           = 'crest' (kept the same so existing UI works)
//   - doc_reference    = the CIA-RDP… reference number
//   - content_text     = OCR'd full text
//   - structure_json   = parsed sections (KEY JUDGMENTS, DISCUSSION, etc.)
//   - quality_score    = 1.0 if OCR text > 500 chars, 0.5 if 100-500, 0 otherwise

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

const SEARCH_URL = 'https://archive.org/advancedsearch.php'
const DOWNLOAD_BASE = 'https://archive.org/download'
const METADATA_BASE = 'https://archive.org/metadata'

const REQUEST_DELAY_MS = 1500    // be polite to archive.org
const DEFAULT_PER_BATCH = 25
const MAX_TEXT_BYTES = 1_000_000 // 1MB cap on OCR text per doc

const UA = 'HeimdallIntel/1.0 (https://github.com/ankurCES/Heimdall) +ankur.nairit@gmail.com'

export interface CrestIngestOptions {
  topic: string
  maxDocs?: number
  era?: string
  docType?: string
}

export interface CrestIngestStats {
  topic: string
  found: number
  attempted: number
  succeeded: number
  failed: number
  averageQuality: number
  durationMs: number
  totalAvailable: number          // total IA hits, not just what we pulled
}

interface IaSearchDoc {
  identifier: string
  title?: string
  date?: string
}

interface IaSearchResponse {
  response: {
    numFound: number
    docs: IaSearchDoc[]
  }
}

interface IaFileMeta {
  result: Array<{ name: string; size?: string }>
}

export class CrestIngester {
  async ingest(opts: CrestIngestOptions): Promise<CrestIngestStats> {
    const start = Date.now()
    const stats: CrestIngestStats = {
      topic: opts.topic, found: 0, attempted: 0, succeeded: 0,
      failed: 0, averageQuality: 0, durationMs: 0, totalAvailable: 0
    }
    const maxDocs = opts.maxDocs ?? DEFAULT_PER_BATCH

    log.info(`crest.ingest: searching IA mirror for "${opts.topic}" (max ${maxDocs} docs)`)

    let docs: IaSearchDoc[]
    try {
      const result = await this.search(opts.topic, maxDocs)
      docs = result.docs
      stats.totalAvailable = result.numFound
    } catch (err) {
      log.error(`crest.ingest search failed: ${err}`)
      stats.durationMs = Date.now() - start
      return stats
    }

    stats.found = docs.length
    log.info(`crest.ingest: ${stats.totalAvailable} total available, fetching ${docs.length}`)

    let qualitySum = 0
    for (const doc of docs) {
      stats.attempted++
      try {
        const quality = await this.ingestOne(doc, opts)
        if (quality > 0) {
          stats.succeeded++
          qualitySum += quality
        } else {
          stats.failed++
        }
      } catch (err) {
        log.debug(`crest.ingest one failed (${doc.identifier}): ${err}`)
        stats.failed++
      }
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS))
    }

    stats.durationMs = Date.now() - start
    stats.averageQuality = stats.succeeded > 0 ? qualitySum / stats.succeeded : 0
    log.info(`crest.ingest: complete — ${stats.succeeded}/${stats.attempted} succeeded (avg quality ${stats.averageQuality.toFixed(2)}) in ${stats.durationMs}ms`)
    return stats
  }

  /**
   * Hit Archive.org's advanced search to find CIA reading-room documents
   * matching the topic. Returns at most maxResults.
   */
  private async search(topic: string, maxResults: number): Promise<{ docs: IaSearchDoc[]; numFound: number }> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(`collection:ciareadingroom AND ${topic}`)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=date&rows=${maxResults}&sort%5B%5D=date+desc&output=json`

    const resp = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(30_000)
    })
    if (!resp.ok) throw new Error(`IA search HTTP ${resp.status}`)
    const json = await resp.json() as IaSearchResponse

    return {
      docs: json.response.docs || [],
      numFound: json.response.numFound || 0
    }
  }

  /**
   * Pull one document's metadata + OCR text and write to training_corpus.
   * Returns the quality score [0..1].
   */
  private async ingestOne(doc: IaSearchDoc, opts: CrestIngestOptions): Promise<number> {
    // 1. Find the OCR text filename via metadata. The naming pattern is
    //    <docref>_djvu.txt where docref is the lowercase CIA-RDP reference.
    let textFile: string | null = null
    try {
      const metaResp = await fetch(`${METADATA_BASE}/${doc.identifier}/files`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000)
      })
      if (!metaResp.ok) {
        log.debug(`crest.ingest: metadata HTTP ${metaResp.status} for ${doc.identifier}`)
        return 0
      }
      const meta = await metaResp.json() as IaFileMeta
      textFile = meta.result.find((f) => f.name.endsWith('_djvu.txt'))?.name ?? null
      if (!textFile) {
        log.debug(`crest.ingest: no _djvu.txt for ${doc.identifier}`)
        return 0
      }
    } catch (err) {
      log.debug(`crest.ingest metadata fetch error for ${doc.identifier}: ${err}`)
      return 0
    }

    // 2. Pull OCR text
    let text = ''
    try {
      const txtResp = await fetch(`${DOWNLOAD_BASE}/${doc.identifier}/${textFile}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(60_000)
      })
      if (!txtResp.ok) {
        log.debug(`crest.ingest: text HTTP ${txtResp.status} for ${doc.identifier}`)
        return 0
      }
      text = (await txtResp.text()).slice(0, MAX_TEXT_BYTES)
    } catch (err) {
      log.debug(`crest.ingest text fetch error for ${doc.identifier}: ${err}`)
      return 0
    }

    if (text.length < 100) return 0

    let quality = 0
    if (text.length >= 500) quality = 1.0
    else if (text.length >= 100) quality = 0.5

    // 3. Derive the CIA-RDP reference from the identifier
    const reference = doc.identifier
      .replace(/^cia-readingroom-document-/, '')
      .toUpperCase()

    // 4. Parse heading structure
    const structure = this.parseStructure(text)

    // 5. Determine era from doc date (if available)
    const era = this.eraFromDate(doc.date) ?? opts.era ?? 'unknown'

    // 6. Insert into training_corpus
    try {
      const db = getDatabase()
      db.prepare(`
        INSERT INTO training_corpus
          (id, source, doc_reference, title, date_original, era, doc_type,
           topic_tags, region_tags, content_text, structure_json, entities_json,
           quality_score, ingested_at, used_for_training)
        VALUES (?, 'crest', ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, 0)
      `).run(
        generateId(),
        reference,
        (doc.title || reference).slice(0, 250),
        doc.date ?? null,
        era,
        opts.docType ?? 'memo',
        JSON.stringify([opts.topic]),
        text.slice(0, 200_000),
        JSON.stringify(structure),
        quality,
        Date.now()
      )
    } catch (err) {
      log.debug(`crest.ingest DB insert failed for ${doc.identifier}: ${err}`)
      return 0
    }

    return quality
  }

  /** Map a date string into a coarse era bucket. */
  private eraFromDate(date?: string): string | null {
    if (!date) return null
    const year = parseInt(date.slice(0, 4), 10)
    if (isNaN(year)) return null
    if (year < 1947) return 'pre_cia'
    if (year < 1991) return 'cold_war'
    if (year < 2001) return 'post_cold_war'
    if (year < 2010) return 'gwot'
    return 'modern'
  }

  /**
   * Best-effort section extractor for IC heading patterns.
   */
  private parseStructure(text: string): Record<string, string> {
    const sections: Record<string, string> = {}
    const headings = [
      'KEY JUDGMENTS', 'KEY JUDGMENT', 'EXECUTIVE SUMMARY', 'SCOPE NOTE',
      'DISCUSSION', 'CONCLUSIONS', 'ANNEX', 'COMMENT', 'SUMMARY',
      'BACKGROUND', 'OUTLOOK', 'IMPLICATIONS', 'RECOMMENDATIONS', 'MEMORANDUM FOR'
    ]
    const pattern = new RegExp(`(?:^|\\n)\\s*(${headings.join('|')})[:.]?\\s*\\n`, 'gi')
    const matches: Array<{ heading: string; index: number }> = []
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      matches.push({ heading: m[1].toUpperCase(), index: m.index + m[0].length })
    }
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index
      const end = i + 1 < matches.length ? matches[i + 1].index - 100 : text.length
      sections[matches[i].heading] = text.slice(start, end).trim().slice(0, 5000)
    }
    return sections
  }

  /** Stats for the UI / settings. */
  getStatus(): { count: number; byEra: Record<string, number>; byDocType: Record<string, number>; lastIngested: number | null } {
    const db = getDatabase()
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM training_corpus WHERE source='crest'`).get() as { n: number }).n
    const byEra: Record<string, number> = {}
    for (const r of db.prepare(`SELECT era, COUNT(*) AS n FROM training_corpus WHERE source='crest' GROUP BY era`).all() as Array<{ era: string; n: number }>) {
      byEra[r.era || 'unknown'] = r.n
    }
    const byDocType: Record<string, number> = {}
    for (const r of db.prepare(`SELECT doc_type, COUNT(*) AS n FROM training_corpus WHERE source='crest' GROUP BY doc_type`).all() as Array<{ doc_type: string; n: number }>) {
      byDocType[r.doc_type || 'unknown'] = r.n
    }
    const last = db.prepare(`SELECT MAX(ingested_at) AS last FROM training_corpus WHERE source='crest'`).get() as { last: number | null }
    return { count: total, byEra, byDocType, lastIngested: last.last }
  }
}

export const crestIngester = new CrestIngester()
