// Few-shot exemplar selector. Given an output format and a query, picks
// 1-2 real declassified IC documents from training_corpus that most closely
// match the topic, and formats them as a "REFERENCE FORMAT EXAMPLES" block
// for inclusion in the analyst prompt.
//
// The matching is FTS5-style: tokenize query → score corpus entries by
// keyword overlap with their title + topic_tags + structure headings.
// Entries with quality_score < 0.5 are excluded.
//
// Each chosen exemplar is truncated to ~2000 chars (key judgments + first
// discussion section) so the LLM can absorb the format without context blow-up.

import { getDatabase } from '../database'
import type { ReportFormat } from '../report/ReportFormatter'
import log from 'electron-log'

interface CorpusRow {
  id: string
  source: string
  doc_reference: string | null
  title: string | null
  era: string | null
  doc_type: string | null
  topic_tags: string | null
  content_text: string | null
  structure_json: string | null
  quality_score: number
}

export interface Exemplar {
  reference: string
  title: string
  era: string
  text: string                    // pre-formatted excerpt for prompt injection
  quality: number
}

const MIN_QUALITY = 0.5
const PER_FORMAT_LIMIT = 2          // max exemplars to inject
const EXCERPT_CHARS_PER_EXEMPLAR = 2000
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'is', 'are', 'was', 'were', 'be', 'as', 'this', 'that'
])

// Map our output formats → preferred corpus doc_types
const FORMAT_TO_DOCTYPES: Record<Exclude<ReportFormat, 'auto'>, string[]> = {
  nie:        ['nie', 'estimate', 'snie', 'memo'],
  pdb:        ['pdb', 'pdb_item', 'cib', 'memo'],
  iir:        ['iir', 'memo', 'cable'],
  assessment: ['nie', 'estimate', 'memo']
}

export class ExemplarSelector {
  /**
   * Pick up to N exemplars matching the requested format + query topic.
   * Returns empty array if training_corpus has no qualifying entries.
   */
  select(format: Exclude<ReportFormat, 'auto'>, query: string): Exemplar[] {
    const tokens = this.tokenize(query)
    if (tokens.length === 0) return []

    const preferredTypes = FORMAT_TO_DOCTYPES[format] || ['memo']

    // Pull a candidate pool — entries matching at least preferred type OR
    // having a topic_tag overlap with our query tokens.
    const db = getDatabase()
    let rows: CorpusRow[]
    try {
      // Prioritise exact doc_type matches; fall back to anything if none.
      const placeholders = preferredTypes.map(() => '?').join(',')
      rows = db.prepare(`
        SELECT id, source, doc_reference, title, era, doc_type, topic_tags,
               content_text, structure_json, quality_score
        FROM training_corpus
        WHERE quality_score >= ? AND doc_type IN (${placeholders})
        ORDER BY quality_score DESC
        LIMIT 100
      `).all(MIN_QUALITY, ...preferredTypes) as CorpusRow[]

      if (rows.length === 0) {
        // Relax: any high-quality entry
        rows = db.prepare(`
          SELECT id, source, doc_reference, title, era, doc_type, topic_tags,
                 content_text, structure_json, quality_score
          FROM training_corpus
          WHERE quality_score >= ?
          ORDER BY quality_score DESC
          LIMIT 100
        `).all(MIN_QUALITY) as CorpusRow[]
      }
    } catch (err) {
      log.debug(`ExemplarSelector query failed: ${err}`)
      return []
    }

    if (rows.length === 0) return []

    // Score each row by keyword overlap.
    const scored = rows.map((r) => ({
      row: r,
      score: this.scoreRow(r, tokens)
    }))
    scored.sort((a, b) => b.score - a.score)

    const top = scored.slice(0, PER_FORMAT_LIMIT)
    return top.filter((s) => s.score > 0).map((s) => this.toExemplar(s.row))
  }

  /**
   * Build the prompt fragment to append to the analyst system prompt. Empty
   * string when there are no exemplars (so callers can concat unconditionally).
   */
  buildPromptFragment(exemplars: Exemplar[]): string {
    if (exemplars.length === 0) return ''
    const blocks = exemplars.map((e, i) => {
      return `### EXEMPLAR ${i + 1}: ${e.reference} (${e.era})
Title: ${e.title}

\`\`\`
${e.text}
\`\`\``
    }).join('\n\n')

    return `\n\n## REFERENCE FORMAT EXAMPLES (real declassified products)

The following excerpts are from authentic declassified IC products. Match their tone, sentence structure, and section organization in your output. Do NOT copy the substance — only the format.

${blocks}\n`
  }

  // ----- helpers -----------------------------------------------------------

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  }

  private scoreRow(row: CorpusRow, queryTokens: string[]): number {
    const haystack = `${row.title || ''} ${row.topic_tags || ''}`.toLowerCase()
    let score = 0
    for (const t of queryTokens) {
      if (haystack.includes(t)) score += 2
    }
    // Slight quality bonus
    score += row.quality_score
    return score
  }

  private toExemplar(row: CorpusRow): Exemplar {
    // Prefer parsed structure (key judgments + first discussion section) for
    // a representative excerpt. Fall back to raw content if parsing failed.
    let text = ''
    try {
      const struct = row.structure_json ? JSON.parse(row.structure_json) as Record<string, string> : {}
      const preferred = ['KEY JUDGMENTS', 'KEY JUDGMENT', 'EXECUTIVE SUMMARY', 'SCOPE NOTE', 'DISCUSSION', 'SUMMARY']
      for (const key of preferred) {
        if (struct[key]) {
          text += `${key}\n${struct[key]}\n\n`
          if (text.length >= EXCERPT_CHARS_PER_EXEMPLAR) break
        }
      }
    } catch { /* */ }

    if (text.length < 200 && row.content_text) {
      text = row.content_text.slice(0, EXCERPT_CHARS_PER_EXEMPLAR)
    } else {
      text = text.slice(0, EXCERPT_CHARS_PER_EXEMPLAR)
    }

    return {
      reference: row.doc_reference || row.id,
      title: row.title || 'Untitled',
      era: row.era || 'unknown',
      text,
      quality: row.quality_score
    }
  }

  /** Stats for the UI. */
  getStatus(): { totalExemplars: number; byEra: Record<string, number>; byFormat: Record<string, number> } {
    const db = getDatabase()
    const total = (db.prepare(
      `SELECT COUNT(*) AS n FROM training_corpus WHERE quality_score >= ?`
    ).get(MIN_QUALITY) as { n: number }).n

    const byEra: Record<string, number> = {}
    for (const r of db.prepare(
      `SELECT era, COUNT(*) AS n FROM training_corpus WHERE quality_score >= ? GROUP BY era`
    ).all(MIN_QUALITY) as Array<{ era: string; n: number }>) {
      byEra[r.era || 'unknown'] = r.n
    }

    const byFormat: Record<string, number> = {}
    for (const r of db.prepare(
      `SELECT doc_type, COUNT(*) AS n FROM training_corpus WHERE quality_score >= ? GROUP BY doc_type`
    ).all(MIN_QUALITY) as Array<{ doc_type: string; n: number }>) {
      byFormat[r.doc_type || 'unknown'] = r.n
    }

    return { totalExemplars: total, byEra, byFormat }
  }
}

export const exemplarSelector = new ExemplarSelector()
