// TranslationService — translates non-English collected content into
// English for downstream analysis, while preserving the original.
//
// Two backends:
//   1. Local LLM (default) — uses the configured 'planner' model class
//      to produce a faithful translation. Cheap, air-gap-safe, works
//      offline if Ollama or similar is configured.
//   2. Cloud (optional, future) — DeepL / Google Cloud Translate when
//      analyst opts in via the new Settings → Translation tab.
//
// Behavior:
//   - detectLanguage() — heuristic Unicode-block detection (no LLM call
//     needed for the common case). Returns ISO 639-1 code or 'en'.
//   - translate(text, targetLang) — short-circuits when source ≈ target.
//     Caches translations for 24h keyed by SHA-1(content) so repeated
//     re-fetches of the same RSS item don't re-pay the LLM cost.
//
// Storage: translations are written into intel_reports.metadata_json
// alongside the original. The migration adds optional columns
// `original_lang` and `original_content` so the analyst can always see
// the source-language version even after translation.

import { createHash } from 'crypto'
import { llmService } from '../llm/LlmService'
import { getDatabase } from '../database'
import log from 'electron-log'

export type LangCode =
  | 'en' | 'ru' | 'zh' | 'ar' | 'fa' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'ko' | 'tr' | 'unknown'

export interface TranslationResult {
  originalLang: LangCode
  originalText: string
  translatedText: string
  targetLang: LangCode
  fromCache: boolean
  durationMs: number
}

const TRANSLATE_PROMPT = `Translate the following text to English. Preserve names, dates, numbers, and proper nouns exactly. Keep paragraph breaks. Do NOT add commentary, do NOT explain your translation. Output ONLY the translation.

If the text is already in English, output the text verbatim.

Text to translate:
`

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_INPUT_CHARS = 8000
const MAX_CACHE_ENTRIES = 500

// Unicode-block heuristics — fast, deterministic, ~95% accurate for the
// languages we care about. Falls back to 'unknown' for ambiguous text.
function detectLanguageFromUnicode(text: string): LangCode {
  if (!text) return 'unknown'
  // Count code points by block
  let cyrillic = 0   // Russian
  let cjk = 0        // Chinese / Japanese / Korean
  let arabic = 0     // Arabic / Persian (Farsi shares the script)
  let latin = 0
  let total = 0
  for (let i = 0; i < text.length && i < 2000; i++) {
    const c = text.charCodeAt(i)
    total++
    if (c >= 0x0400 && c <= 0x04FF) cyrillic++
    else if (c >= 0x4E00 && c <= 0x9FFF) cjk++
    else if (c >= 0x0600 && c <= 0x06FF) arabic++
    else if ((c >= 0x0041 && c <= 0x007A) || (c >= 0x00C0 && c <= 0x024F)) latin++
  }
  if (total === 0) return 'unknown'
  if (cyrillic / total > 0.20) return 'ru'
  if (cjk / total > 0.20) return 'zh'
  if (arabic / total > 0.20) return 'ar'
  if (latin / total > 0.50) {
    // Latin-script — guess by common stop-word prefix scan
    const lower = text.slice(0, 1000).toLowerCase()
    if (/\b(de la|el|los|las|que|para|con|por)\b/.test(lower)) return 'es'
    if (/\b(le|la|les|du|des|que|pour|avec|dans)\b/.test(lower)) return 'fr'
    if (/\b(der|die|das|und|nicht|für|mit|von|sich|aber)\b/.test(lower)) return 'de'
    if (/\b(o|a|os|as|de|para|com|por|que)\b/.test(lower)) return 'pt'
    return 'en'
  }
  return 'unknown'
}

interface CacheEntry {
  translation: string
  detectedLang: LangCode
  expiresAt: number
}

export class TranslationService {
  private cache = new Map<string, CacheEntry>()

  detectLanguage(text: string): LangCode {
    return detectLanguageFromUnicode(text)
  }

  /** True if non-English text was detected (i.e. translation worthwhile). */
  shouldTranslate(text: string, targetLang: LangCode = 'en'): boolean {
    if (!text || text.length < 30) return false
    const lang = this.detectLanguage(text)
    return lang !== 'unknown' && lang !== targetLang
  }

  /**
   * Translate text via the LLM. Returns the original verbatim if the
   * detected source language already matches the target. Memoized 24h.
   */
  async translate(text: string, targetLang: LangCode = 'en'): Promise<TranslationResult> {
    const start = Date.now()
    const sourceLang = this.detectLanguage(text)
    if (sourceLang === targetLang || sourceLang === 'unknown' || text.length < 10) {
      return {
        originalLang: sourceLang, originalText: text,
        translatedText: text, targetLang,
        fromCache: false, durationMs: Date.now() - start
      }
    }

    const truncated = text.slice(0, MAX_INPUT_CHARS)
    const cacheKey = `${targetLang}:${createHash('sha1').update(truncated).digest('hex')}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return {
        originalLang: cached.detectedLang, originalText: text,
        translatedText: cached.translation, targetLang,
        fromCache: true, durationMs: Date.now() - start
      }
    }

    let translatedText = text
    try {
      // Use planner-class model: small/fast, good for translation
      const response = await llmService.completeForTask('planner', TRANSLATE_PROMPT + truncated, undefined, 4096)
      translatedText = response.trim()
      this.cache.set(cacheKey, {
        translation: translatedText, detectedLang: sourceLang,
        expiresAt: Date.now() + CACHE_TTL_MS
      })
      this.pruneCache()
    } catch (err) {
      log.warn(`TranslationService: failed to translate ${sourceLang}→${targetLang}: ${err}`)
      // Return original on failure — don't drop the report
      translatedText = text
    }

    return {
      originalLang: sourceLang, originalText: text,
      translatedText, targetLang,
      fromCache: false, durationMs: Date.now() - start
    }
  }

  /**
   * Persist translation to intel_reports.metadata_json. Idempotent —
   * re-running on an already-translated row is a no-op.
   */
  async translateAndStore(reportId: string): Promise<TranslationResult | null> {
    const db = getDatabase()
    let row: { id: string; content: string; metadata_json: string | null } | undefined
    try {
      row = db.prepare(`SELECT id, content, metadata_json FROM intel_reports WHERE id = ?`)
        .get(reportId) as typeof row
    } catch (err) {
      log.debug(`translateAndStore: lookup failed: ${err}`)
      return null
    }
    if (!row) return null

    // Skip if metadata already shows we translated this
    let meta: Record<string, unknown> = {}
    try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : {} } catch { /* */ }
    if (meta.translated_at && meta.translated_lang) {
      return {
        originalLang: (meta.original_lang as LangCode) || 'unknown',
        originalText: (meta.original_content as string) || row.content,
        translatedText: row.content,
        targetLang: 'en', fromCache: true, durationMs: 0
      }
    }

    if (!this.shouldTranslate(row.content)) return null
    const result = await this.translate(row.content, 'en')
    if (result.translatedText === result.originalText) return result

    try {
      meta.original_lang = result.originalLang
      meta.original_content = result.originalText.slice(0, 50_000)
      meta.translated_at = Date.now()
      meta.translated_lang = 'en'
      meta.translation_duration_ms = result.durationMs
      db.prepare(
        `UPDATE intel_reports SET content = ?, metadata_json = ? WHERE id = ?`
      ).run(result.translatedText.slice(0, 50_000), JSON.stringify(meta), reportId)
      log.info(`TranslationService: ${result.originalLang}→en for ${reportId} (${result.durationMs}ms${result.fromCache ? ', cached' : ''})`)
    } catch (err) {
      log.debug(`translateAndStore: write failed: ${err}`)
    }
    return result
  }

  private pruneCache(): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return
    const now = Date.now()
    for (const [k, v] of this.cache) {
      if (v.expiresAt < now) this.cache.delete(k)
    }
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const sorted = Array.from(this.cache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      const dropCount = this.cache.size - MAX_CACHE_ENTRIES
      for (let i = 0; i < dropCount; i++) this.cache.delete(sorted[i][0])
    }
  }

  /** Stats endpoint for the dashboard. */
  stats(): { cacheSize: number } {
    return { cacheSize: this.cache.size }
  }
}

export const translationService = new TranslationService()
