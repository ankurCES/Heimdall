import log from 'electron-log'
import { llmService } from '../llm/LlmService'

/**
 * Cross-cutting I — AI-generated I&W indicator suggestions.
 *
 * Given an event name + description, ask the LLM to propose 6-10
 * observable preconditions an analyst could track, each mappable to
 * one of Heimdall's existing indicator query types:
 *   - intel_count   — "number of intel_reports in the last N days
 *                     matching filters X/Y"
 *   - entity_count  — "mentions of a canonical entity in last N days"
 *
 * The LLM doesn't need to produce query_params JSON — the analyst
 * still hits "Add indicator" to bind each suggestion to concrete
 * filters. The value here is breaking the blank-page problem and
 * drawing on academic literature the analyst may not know.
 */

export interface IndicatorSuggestion {
  name: string
  description: string
  query_type: 'intel_count' | 'entity_count'
  rationale: string
}

const SYSTEM_PROMPT = `You are a senior intelligence analyst trained in Heuer's methodology and ICD 203 estimative standards. Your task is to propose Indicators & Warning (I&W) indicators for a given high-impact event.

For each indicator you propose, output ONE JSON object on its own line with these keys:
- name: short analyst-facing label (5-10 words)
- description: what a rising value means, and what would count as "red"
- query_type: one of "intel_count" or "entity_count"
- rationale: 1-sentence citation to published literature or historical precedent (no URLs)

Rules:
- Propose 6 to 10 indicators, one JSON per line.
- Indicators must be observable preconditions an OSINT analyst could track, not opinions.
- Span multiple categories: political posture, military signals, economic, social media, diplomatic. Do not clump.
- Prefer indicators with precedent (prior conflicts, escalation cases, academic studies).
- Output ONLY the JSON lines. No prose, no numbering, no code fences.
`

export class IwSuggestionService {
  /**
   * Ask the LLM for indicator suggestions. Parses line-delimited JSON;
   * silently skips malformed lines. Returns an empty array if the LLM
   * is unreachable or rejects the request — the UI surfaces that.
   */
  async suggest(event: { name: string; description?: string | null; scenario_class?: string | null }): Promise<IndicatorSuggestion[]> {
    const userMsg = [
      `Event: ${event.name}`,
      event.description ? `Description: ${event.description}` : null,
      event.scenario_class ? `Scenario class: ${event.scenario_class}` : null
    ].filter(Boolean).join('\n')

    const prompt = `${SYSTEM_PROMPT}\n\n${userMsg}\n\nNow output the JSON lines.`
    try {
      const raw = await llmService.complete(prompt, undefined, 2000)
      const suggestions = this.parseLines(raw)
      log.info(`iw-suggest: parsed ${suggestions.length} indicator suggestions for "${event.name}"`)
      return suggestions
    } catch (err) {
      log.warn(`iw-suggest: LLM call failed: ${(err as Error).message}`)
      throw err
    }
  }

  private parseLines(raw: string): IndicatorSuggestion[] {
    const out: IndicatorSuggestion[] = []
    // Tolerate code fences / leading prose — find every balanced {...} block.
    const candidateBlocks = raw.match(/\{[^{}]*\}/g) ?? []
    for (const block of candidateBlocks) {
      try {
        const obj = JSON.parse(block) as Record<string, unknown>
        const name = typeof obj.name === 'string' ? obj.name.trim() : ''
        const description = typeof obj.description === 'string' ? obj.description.trim() : ''
        const query_type = obj.query_type === 'intel_count' || obj.query_type === 'entity_count'
          ? obj.query_type
          : null
        const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : ''
        if (name && description && query_type) {
          out.push({ name, description, query_type, rationale })
        }
      } catch { /* skip malformed */ }
      if (out.length >= 12) break
    }
    return out
  }
}

export const iwSuggestionService = new IwSuggestionService()
