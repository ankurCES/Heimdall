import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export interface WatchTerm {
  id: string
  term: string
  source: 'manual' | 'agent' | 'action' | 'gap'
  sourceId: string | null
  category: string | null
  priority: string
  enabled: boolean
  hits: number
  lastHitAt: number | null
  createdAt: number
  updatedAt: number
}

export class WatchTermsService {
  // Extract search terms from recommended actions and add as watch terms
  extractFromActions(prelimReportId: string): number {
    const db = getDatabase()
    const now = timestamp()

    const actions = db.prepare(
      'SELECT id, action, priority FROM recommended_actions WHERE preliminary_report_id = ?'
    ).all(prelimReportId) as Array<{ id: string; action: string; priority: string }>

    let added = 0
    for (const action of actions) {
      const terms = this.extractKeyTerms(action.action)
      for (const term of terms) {
        if (this.termExists(term)) continue
        db.prepare(
          'INSERT INTO watch_terms (id, term, source, source_id, category, priority, enabled, hits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)'
        ).run(generateId(), term, 'action', action.id, 'recommended_action', action.priority, now, now)
        added++
      }
    }

    // Also extract from information gaps
    const gaps = db.prepare(
      'SELECT id, description, severity FROM intel_gaps WHERE preliminary_report_id = ?'
    ).all(prelimReportId) as Array<{ id: string; description: string; severity: string }>

    for (const gap of gaps) {
      const terms = this.extractKeyTerms(gap.description)
      for (const term of terms) {
        if (this.termExists(term)) continue
        db.prepare(
          'INSERT INTO watch_terms (id, term, source, source_id, category, priority, enabled, hits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)'
        ).run(generateId(), term, 'gap', gap.id, 'information_gap', gap.severity, now, now)
        added++
      }
    }

    if (added > 0) log.info(`WatchTerms: extracted ${added} terms from preliminary report ${prelimReportId.slice(0, 8)}`)
    return added
  }

  addManual(term: string, category?: string, priority?: string): WatchTerm {
    const db = getDatabase()
    const now = timestamp()
    const id = generateId()

    db.prepare(
      'INSERT INTO watch_terms (id, term, source, category, priority, enabled, hits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)'
    ).run(id, term.trim(), 'manual', category || null, priority || 'medium', now, now)

    return { id, term: term.trim(), source: 'manual', sourceId: null, category: category || null, priority: priority || 'medium', enabled: true, hits: 0, lastHitAt: null, createdAt: now, updatedAt: now }
  }

  getAll(): WatchTerm[] {
    const db = getDatabase()
    return (db.prepare('SELECT * FROM watch_terms ORDER BY priority DESC, created_at DESC').all() as Array<Record<string, unknown>>).map(this.mapTerm)
  }

  getEnabled(): WatchTerm[] {
    const db = getDatabase()
    return (db.prepare('SELECT * FROM watch_terms WHERE enabled = 1 ORDER BY priority DESC').all() as Array<Record<string, unknown>>).map(this.mapTerm)
  }

  toggle(id: string, enabled: boolean): void {
    const db = getDatabase()
    db.prepare('UPDATE watch_terms SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, timestamp(), id)
  }

  remove(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM watch_terms WHERE id = ?').run(id)
  }

  recordHit(termId: string): void {
    const db = getDatabase()
    db.prepare('UPDATE watch_terms SET hits = hits + 1, last_hit_at = ?, updated_at = ? WHERE id = ?').run(timestamp(), timestamp(), termId)
  }

  // Search intel_reports for matches against all enabled watch terms
  scanForMatches(): Array<{ termId: string; term: string; matchCount: number }> {
    const db = getDatabase()
    const terms = this.getEnabled()
    const results: Array<{ termId: string; term: string; matchCount: number }> = []

    for (const t of terms) {
      const count = (db.prepare(
        'SELECT COUNT(*) as c FROM intel_reports WHERE LOWER(title) LIKE ? OR LOWER(content) LIKE ?'
      ).get(`%${t.term.toLowerCase()}%`, `%${t.term.toLowerCase()}%`) as { c: number }).c

      if (count > t.hits) {
        results.push({ termId: t.id, term: t.term, matchCount: count })
        this.recordHit(t.id)
      }
    }

    return results
  }

  private termExists(term: string): boolean {
    const db = getDatabase()
    const row = db.prepare('SELECT id FROM watch_terms WHERE LOWER(term) = ?').get(term.toLowerCase())
    return !!row
  }

  private extractKeyTerms(text: string): string[] {
    const terms: string[] = []

    // Extract quoted phrases
    const quoted = text.match(/"([^"]+)"/g) || []
    for (const q of quoted) terms.push(q.replace(/"/g, '').trim())

    // Extract proper nouns and significant phrases (2-4 word combos)
    const words = text.replace(/[^\w\s-]/g, '').split(/\s+/)
    const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'been', 'have', 'has', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'about', 'into', 'than', 'more', 'also', 'very', 'just', 'only', 'some', 'such', 'each', 'every', 'both', 'between', 'through', 'during', 'before', 'after', 'above', 'below', 'increase', 'monitor', 'surveillance', 'advise', 'prepare', 'alert', 'stakeholders'])

    // Find capitalized phrases (proper nouns)
    for (let i = 0; i < words.length; i++) {
      if (words[i].length < 3) continue
      if (words[i][0] === words[i][0].toUpperCase() && /[A-Z]/.test(words[i][0])) {
        let phrase = words[i]
        // Extend with following capitalized words
        for (let j = i + 1; j < Math.min(i + 4, words.length); j++) {
          if (words[j][0] === words[j][0].toUpperCase() && words[j].length >= 3 && !stopWords.has(words[j].toLowerCase())) {
            phrase += ' ' + words[j]
          } else break
        }
        if (phrase.length >= 4 && !stopWords.has(phrase.toLowerCase())) {
          terms.push(phrase)
        }
      }
    }

    // Extract specific patterns: country names, org names, technical terms
    const patterns = text.match(/\b(?:Iran|Yemen|Hormuz|SIGINT|SOCMINT|CYBINT|blockade|sanctions|military|nuclear|proxy|coalition|ceasefire|escalation|diplomacy|intelligence)\b/gi) || []
    for (const p of patterns) {
      if (!terms.some((t) => t.toLowerCase().includes(p.toLowerCase()))) {
        terms.push(p)
      }
    }

    // Deduplicate and filter
    return [...new Set(terms.map((t) => t.trim()))].filter((t) => t.length >= 3 && t.length <= 60).slice(0, 10)
  }

  private mapTerm(row: Record<string, unknown>): WatchTerm {
    return {
      id: row.id as string, term: row.term as string,
      source: row.source as WatchTerm['source'], sourceId: row.source_id as string | null,
      category: row.category as string | null, priority: row.priority as string,
      enabled: (row.enabled as number) === 1, hits: row.hits as number,
      lastHitAt: row.last_hit_at as number | null,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number
    }
  }
}

export const watchTermsService = new WatchTermsService()
