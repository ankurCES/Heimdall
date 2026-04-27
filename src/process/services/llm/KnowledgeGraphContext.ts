import { getDatabase } from '../database'
import { vectorDbService } from '../vectordb/VectorDbService'
import log from 'electron-log'

/**
 * Compact context block injected into every chat turn so the agent cannot
 * forget that prior analyst conclusions (HUMINT) and curated briefings
 * (preliminary_reports) already exist for the topic at hand.
 *
 * The block is strictly informational — the agent should follow up with
 * `humint_recall` / `preliminary_brief` / `graph_neighborhood` to retrieve
 * full content when a hit looks relevant. This keeps the injected block
 * small (<800 chars) while ensuring the agent always "knows" the knowledge
 * graph exists.
 */

interface CacheEntry { content: string; ts: number }
const CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

interface HumintRow {
  id: string
  session_id: string
  findings: string
  analyst_notes: string
  confidence: string
  source_report_ids: string | null
  created_at: number
}

interface PrelimRow {
  id: string
  title: string
  content: string
  created_at: number
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ago`
  if (h >= 1) return `${h}h ago`
  const m = Math.floor(diff / 60_000)
  return `${m}m ago`
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine
}

// PERF v1.3.2 D2: hard cap on cache entries — without this, unique
// queries pile up indefinitely (potentially thousands over a long
// session). Eviction sweeps oldest first.
const MAX_CACHE_ENTRIES = 200

function pruneCache(): void {
  if (CACHE.size <= MAX_CACHE_ENTRIES) return
  // Drop entries older than TTL first, then oldest by ts if still over budget.
  const now = Date.now()
  for (const [k, v] of CACHE) {
    if (now - v.ts >= CACHE_TTL_MS) CACHE.delete(k)
  }
  if (CACHE.size > MAX_CACHE_ENTRIES) {
    const sorted = Array.from(CACHE.entries()).sort((a, b) => a[1].ts - b[1].ts)
    const dropCount = CACHE.size - MAX_CACHE_ENTRIES
    for (let i = 0; i < dropCount; i++) CACHE.delete(sorted[i][0])
  }
}

class KnowledgeGraphContextService {
  /** v1.3.2 — exposed for ResourceManager nightly cleanup. */
  _CACHE_PRUNE(): void { pruneCache() }

  /**
   * Returns a plain-text block describing the top relevant HUMINT + preliminary
   * reports for this query. Safe to prepend as a system message. Always
   * returns something — empty DB produces a minimal "no prior context" note
   * rather than an empty string.
   */
  async getRelevantContext(
    query: string,
    opts: { humintLimit?: number; prelimLimit?: number } = {}
  ): Promise<string> {
    const cacheKey = `${query}|${opts.humintLimit || 3}|${opts.prelimLimit || 2}`
    const cached = CACHE.get(cacheKey)
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.content

    const humintLimit = opts.humintLimit ?? 3
    const prelimLimit = opts.prelimLimit ?? 2

    const lines: string[] = ['=== Relevant analyst knowledge (HUMINT + preliminary reports) ===', '']
    let matched = 0

    // HUMINT recall via vector search over findings/analyst_notes
    try {
      const humintIds = await this.vectorMatchHumints(query, humintLimit * 2)
      if (humintIds.length > 0) {
        const db = getDatabase()
        const placeholders = humintIds.map(() => '?').join(',')
        const rows = db.prepare(
          `SELECT id, session_id, findings, analyst_notes, confidence, source_report_ids, created_at FROM humint_reports WHERE id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`
        ).all(...humintIds, humintLimit) as HumintRow[]

        for (const r of rows) {
          let citedCount = 0
          try { citedCount = JSON.parse(r.source_report_ids || '[]').length } catch {}
          const finding = truncate(r.findings || r.analyst_notes || '', 140)
          lines.push(`[humint:${r.id}] (conf: ${r.confidence}, ${formatRelativeTime(r.created_at)}, cites ${citedCount} intel)`)
          if (finding) lines.push(`   ${finding}`)
          matched++
        }
      }
    } catch (err) {
      log.debug(`KG context humint lookup failed: ${err}`)
    }

    // Preliminary briefings via keyword match over title+content
    try {
      const db = getDatabase()
      const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5)
      if (keywords.length > 0) {
        const conds = keywords.map(() => '(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)').join(' OR ')
        const bind: string[] = []
        for (const k of keywords) bind.push(`%${k}%`, `%${k}%`)
        const rows = db.prepare(
          `SELECT id, title, content, created_at FROM preliminary_reports WHERE ${conds} ORDER BY created_at DESC LIMIT ?`
        ).all(...bind, prelimLimit) as PrelimRow[]

        for (const r of rows) {
          const [gaps, actions] = this.countGapsActions(r.id)
          lines.push(`[preliminary:${r.id}] "${truncate(r.title || '', 60)}" (${formatRelativeTime(r.created_at)}, ${gaps} gaps, ${actions} actions)`)
          matched++
        }
      }
    } catch (err) {
      log.debug(`KG context preliminary lookup failed: ${err}`)
    }

    if (matched === 0) {
      const content = '=== No prior analyst knowledge found for this query. ===\nUse vector_search or intel_search for fresh investigation.'
      CACHE.set(cacheKey, { content, ts: Date.now() })
      pruneCache()
      return content
    }

    lines.push('')
    lines.push('If any of the above looks relevant, call humint_recall / preliminary_brief / graph_neighborhood to retrieve full content before running fresh searches.')

    const content = lines.join('\n').slice(0, 800)
    CACHE.set(cacheKey, { content, ts: Date.now() })
    return content
  }

  /**
   * Find HUMINT ids whose findings/analyst_notes vector-match the query.
   * Falls back to keyword LIKE if vector DB is unavailable.
   */
  private async vectorMatchHumints(query: string, limit: number): Promise<string[]> {
    // Preferred path: vectorDbService indexes all intel + humint report content.
    // Results include a reportId; if that id is a humint_reports row we keep it.
    try {
      const results = await vectorDbService.search(query, Math.min(limit * 3, 30))
      const db = getDatabase()
      const humintIds: string[] = []
      for (const r of results) {
        const id = (r as { id?: string }).id
        if (!id) continue
        const row = db.prepare('SELECT 1 FROM humint_reports WHERE id = ?').get(id)
        if (row) humintIds.push(id)
        if (humintIds.length >= limit) break
      }
      if (humintIds.length > 0) return humintIds
    } catch {}

    // Keyword fallback — scan findings + analyst_notes
    try {
      const db = getDatabase()
      const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 5)
      if (keywords.length === 0) return []
      const conds = keywords.map(() => '(LOWER(findings) LIKE ? OR LOWER(analyst_notes) LIKE ?)').join(' OR ')
      const bind: string[] = []
      for (const k of keywords) bind.push(`%${k}%`, `%${k}%`)
      const rows = db.prepare(
        `SELECT id FROM humint_reports WHERE ${conds} ORDER BY created_at DESC LIMIT ?`
      ).all(...bind, limit) as Array<{ id: string }>
      return rows.map((r) => r.id)
    } catch {}

    return []
  }

  private countGapsActions(prelimId: string): [number, number] {
    try {
      const db = getDatabase()
      const g = db.prepare("SELECT COUNT(*) AS c FROM intel_gaps WHERE preliminary_report_id = ? AND status = 'open'").get(prelimId) as { c: number }
      const a = db.prepare("SELECT COUNT(*) AS c FROM recommended_actions WHERE preliminary_report_id = ? AND status = 'pending'").get(prelimId) as { c: number }
      return [g?.c || 0, a?.c || 0]
    } catch {
      return [0, 0]
    }
  }
}

export const knowledgeGraphContextService = new KnowledgeGraphContextService()
