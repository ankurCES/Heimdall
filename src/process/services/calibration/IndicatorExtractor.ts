// IndicatorExtractor — parses the I&W (Indicators & Warnings) annex of a
// generated report and persists each indicator into report_indicators.
//
// The SAT module already produces structured indicator JSON during
// generation. When that's not available (older reports / non-SAT runs),
// we fall back to LLM-based extraction from the markdown.
//
// Each indicator gets:
//   - hypothesis  — which judgment it's tracking
//   - direction   — confirming | refuting
//   - priority    — high | medium | low (from collection_priority)
//   - match_keywords / match_entities — used by IndicatorTrackerService
//     to check whether incoming intel triggers the indicator

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import { llmService } from '../llm/LlmService'
import log from 'electron-log'
import type { ReportProduct } from '../report/ReportLibraryService'

export interface ExtractedIndicator {
  hypothesis: string
  indicatorText: string
  direction: 'confirming' | 'refuting'
  priority: 'high' | 'medium' | 'low'
  matchKeywords: string[]
  matchEntities: string[]
}

const EXTRACTION_PROMPT = `You are extracting Indicators & Warnings from an intelligence assessment.

For each KEY JUDGMENT in the assessment, identify:
- 2-3 CONFIRMING indicators: observable events that, if seen, would confirm the judgment
- 2-3 REFUTING indicators: observable events that would challenge or refute the judgment

For each indicator, also provide:
- 3-6 lowercase keyword stems that an automated system could match against incoming intel text
- 1-3 named entities (people, places, organizations) that scope the indicator

Respond ONLY with JSON:
{
  "indicators": [
    {
      "hypothesis": "China will conduct amphibious exercises against Taiwan in Q3",
      "indicatorText": "Three or more PLA amphibious assault groups deploy from Fujian within 30 days",
      "direction": "confirming",
      "priority": "high",
      "matchKeywords": ["pla", "amphibious", "assault", "fujian", "deployment"],
      "matchEntities": ["china", "taiwan", "fujian"]
    }
  ]
}`

export class IndicatorExtractor {
  /** Extract indicators directly from already-parsed SAT framework JSON. */
  fromSatFramework(items: Array<{
    hypothesis: string
    confirmingIndicators: string[]
    refutingIndicators: string[]
    collectionPriority: 'high' | 'medium' | 'low'
  }>): ExtractedIndicator[] {
    const out: ExtractedIndicator[] = []
    for (const item of items) {
      const entities = this.extractEntities(item.hypothesis)
      for (const text of item.confirmingIndicators) {
        out.push({
          hypothesis: item.hypothesis,
          indicatorText: text,
          direction: 'confirming',
          priority: item.collectionPriority,
          matchKeywords: this.extractKeywords(text),
          matchEntities: entities
        })
      }
      for (const text of item.refutingIndicators) {
        out.push({
          hypothesis: item.hypothesis,
          indicatorText: text,
          direction: 'refuting',
          priority: item.collectionPriority,
          matchKeywords: this.extractKeywords(text),
          matchEntities: entities
        })
      }
    }
    return out
  }

  /** LLM-based extraction from a report's markdown body. */
  async fromReportBody(body: string, connectionId?: string): Promise<ExtractedIndicator[]> {
    const truncated = body.slice(0, 8000)
    try {
      const raw = await llmService.completeForTask('analysis',
        `${EXTRACTION_PROMPT}\n\nASSESSMENT:\n${truncated}`,
        connectionId, 1500)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return []
      const parsed = JSON.parse(jsonMatch[0]) as { indicators: ExtractedIndicator[] }
      return (parsed.indicators || []).filter((i) =>
        i.hypothesis && i.indicatorText && i.matchKeywords?.length
      )
    } catch (err) {
      log.warn(`IndicatorExtractor.fromReportBody failed: ${err}`)
      return []
    }
  }

  /** Persist a list of extracted indicators against a report. Idempotent. */
  persist(reportId: string, items: ExtractedIndicator[]): number {
    if (items.length === 0) return 0
    const db = getDatabase()

    // Drop existing active indicators for this report so we don't pile up
    // duplicates on re-extraction.
    db.prepare(`UPDATE report_indicators SET active = 0 WHERE report_id = ?`).run(reportId)

    const insert = db.prepare(`
      INSERT INTO report_indicators (
        id, report_id, hypothesis, indicator_text, direction, priority,
        match_keywords_json, match_entities_json, active, observation_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
    `)
    const now = Date.now()
    let n = 0
    const tx = db.transaction(() => {
      for (const item of items) {
        try {
          insert.run(
            generateId(), reportId,
            item.hypothesis.slice(0, 500),
            item.indicatorText.slice(0, 800),
            item.direction,
            item.priority,
            JSON.stringify(item.matchKeywords.slice(0, 12)),
            JSON.stringify(item.matchEntities.slice(0, 8)),
            now
          )
          n++
        } catch (err) {
          log.debug(`indicator insert failed: ${err}`)
        }
      }
    })
    tx()
    return n
  }

  /**
   * Convenience entrypoint — extracts (LLM if needed) and persists in
   * one call. Used by ReportLibraryService.create() post-hook.
   */
  async extractAndPersist(report: ReportProduct, connectionId?: string): Promise<number> {
    const items = await this.fromReportBody(report.bodyMarkdown, connectionId)
    return this.persist(report.id, items)
  }

  private extractKeywords(text: string): string[] {
    const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
      'with', 'by', 'is', 'are', 'was', 'were', 'be', 'as', 'this', 'that', 'will', 'would',
      'we', 'they', 'their', 'them', 'these', 'those', 'has', 'have', 'had', 'within', 'days',
      'months', 'between', 'from', 'than', 'more', 'most', 'least', 'some'])
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !stop.has(t))
      .slice(0, 8)
  }

  private extractEntities(text: string): string[] {
    // Pull capitalized multi-word phrases as candidate entities
    const matches = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) || []
    const out = new Set<string>()
    for (const m of matches) {
      if (m.length >= 3 && m.length <= 40 && !['The', 'A', 'An', 'I', 'We'].includes(m)) {
        out.add(m.toLowerCase())
      }
    }
    return Array.from(out).slice(0, 5)
  }
}

export const indicatorExtractor = new IndicatorExtractor()
