import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { llmService } from '../llm/LlmService'

/**
 * Theme 7 extension — Sigma + YARA rule generation.
 *
 * Uses the LLM to draft a Sigma detection rule (YAML) from a cyber
 * intel report's content, or a YARA signature from a malware report's
 * IOC / artefact mentions. Rules are stored in detection_rules for
 * analyst review; not exported to live SIEMs automatically.
 *
 * No-dep fallback: if no LLM is configured, throws — there's no
 * deterministic equivalent for this task.
 */

export interface DetectionRule {
  id: string
  rule_type: 'sigma' | 'yara'
  name: string
  body: string
  source_report_id: string | null
  notes: string | null
  created_at: number
}

const SIGMA_SYSTEM = `You generate Sigma detection rules (sigmaHQ/sigma schema). Output the rule as valid YAML, wrapped in \`\`\`yaml ... \`\`\` fences. Rule fields required: title, id (use a random UUID), status (experimental), description, author, references, logsource, detection, falsepositives, level.

Rules:
- Only produce detection content that is DIRECTLY supported by the input report.
- No generic "any suspicious behaviour" rules — the detection block must point at concrete field/value pairs.
- If the report is too vague to produce a meaningful rule, output only a YAML comment explaining why.
- No prose, no extra commentary, only the fenced YAML.`

const YARA_SYSTEM = `You generate YARA rules. Output a single \`\`\`yara ... \`\`\` fenced rule with:
  - meta: section (author=Heimdall, description, reference, date)
  - strings: section with the concrete byte/string patterns derivable from the report
  - condition: section

Rules:
- Do NOT invent strings. If the report doesn't contain byte patterns, hashes, or file-name strings, output a YARA comment explaining the rule was not produced.
- Prefer "any of them" / "N of them" conditions over "all of them".
- No prose outside the fenced block.`

export class DetectionRuleService {
  private async generate(kind: 'sigma' | 'yara', reportId: string): Promise<DetectionRule> {
    const db = getDatabase()
    const report = db.prepare('SELECT id, title, content, discipline FROM intel_reports WHERE id = ?').get(reportId) as { id: string; title: string; content: string; discipline: string } | undefined
    if (!report) throw new Error(`No such report: ${reportId}`)

    // Cap entity rows tightly — for rule generation the most actionable IOCs
    // are typically the first handful (hashes, IPs, domains). 20 rows ≈ 200-400
    // tokens, keeping the prompt well under typical 4K-context Ollama models.
    const entities = db.prepare(
      `SELECT entity_type, entity_value FROM intel_entities WHERE report_id = ? LIMIT 20`
    ).all(reportId) as Array<{ entity_type: string; entity_value: string }>
    const iocSummary = entities.length > 0
      ? entities.map((e) => `${e.entity_type}: ${e.entity_value}`).join('\n')
      : '(no extracted entities)'

    // Budget: keep total prompt + max output ≤ ~3500 tokens so the request
    // fits comfortably in 4K-context models (most local Ollama defaults).
    // ~3.5 chars/token => 3000 chars of content ≈ 850 tokens, leaving room
    // for system prompt (~200) + IOCs (~400) + output budget (~1024).
    const CONTENT_CHARS = 3000
    const MAX_OUTPUT_TOKENS = 1024
    const truncated = report.content.length > CONTENT_CHARS
    const contentSlice = truncated
      ? report.content.slice(0, CONTENT_CHARS) + '\n…[truncated for context limit]'
      : report.content

    const system = kind === 'sigma' ? SIGMA_SYSTEM : YARA_SYSTEM
    const prompt = `${system}\n\n---REPORT---\nTitle: ${report.title}\nDiscipline: ${report.discipline}\n\nContent:\n${contentSlice}\n\nExtracted IOCs:\n${iocSummary}\n---END---\n\nGenerate the rule now.`
    let raw: string
    try {
      raw = await llmService.complete(prompt, undefined, MAX_OUTPUT_TOKENS)
    } catch (err) {
      const msg = (err as Error).message
      // Re-throw context-length overflow with an actionable hint. The user
      // controls model selection in Settings → LLM; the input text is largely
      // out of their hands beyond picking a shorter report.
      if (/context length|prompt too long|max.{0,5}token/i.test(msg)) {
        throw new Error(
          `LLM context window too small for this report (${report.content.length.toLocaleString()} chars). ` +
          `Switch to a larger-context model in Settings → LLM (e.g. an 8K+ Ollama model, or any cloud model), ` +
          `or pick a shorter intel_report. Underlying error: ${msg}`
        )
      }
      throw err
    }
    const body = this.extractFenced(raw, kind)
    if (!body) {
      const preview = raw.trim().slice(0, 400).replace(/\s+/g, ' ')
      log.warn(`detection: ${kind} extraction failed for report ${reportId}. Raw output (truncated): ${preview}`)
      throw new Error(`Model did not produce a valid ${kind} rule. Raw output starts with: "${preview.slice(0, 200)}${preview.length > 200 ? '…' : ''}"`)
    }

    const id = generateId()
    const now = Date.now()
    const name = (report.title || 'untitled').slice(0, 120)
    db.prepare(`
      INSERT INTO detection_rules (id, rule_type, name, body, source_report_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(id, kind, name, body, reportId, now)
    log.info(`detection: ${kind} rule ${id} generated from report ${reportId} (${body.length} bytes)`)
    return { id, rule_type: kind, name, body, source_report_id: reportId, notes: null, created_at: now }
  }

  generateSigma(reportId: string): Promise<DetectionRule> { return this.generate('sigma', reportId) }
  generateYara(reportId: string): Promise<DetectionRule> { return this.generate('yara', reportId) }

  private extractFenced(raw: string, kind: 'sigma' | 'yara'): string | null {
    if (!raw || !raw.trim()) return null
    // Accepted language tags per kind. yaml/yml are common Sigma fences;
    // yara/yar/plaintext/text/empty are all common YARA fences.
    const tags = kind === 'sigma'
      ? ['yaml', 'yml', 'sigma']
      : ['yara', 'yar']
    // 1. Try a labelled fence first (case-insensitive, tolerant of CR / spaces
    //    / extra whitespace / no whitespace after the language tag).
    for (const tag of tags) {
      const re = new RegExp('```\\s*' + tag + '\\s*\\r?\\n?([\\s\\S]+?)```', 'i')
      const m = re.exec(raw)
      if (m && m[1].trim()) return m[1].trim()
    }
    // 2. Fall back to ANY fenced block (the model may have used ``` with no
    //    language tag, or a wrong tag).
    const anyFence = /```[a-zA-Z]*\s*\r?\n?([\s\S]+?)```/.exec(raw)
    if (anyFence && anyFence[1].trim()) return anyFence[1].trim()
    // 3. Accept un-fenced output that structurally looks right anywhere in
    //    the response (not just at line-start — models sometimes prepend a
    //    short preamble despite the system prompt).
    if (kind === 'sigma' && /(^|\n)\s*title\s*:/i.test(raw)) {
      // Trim any preamble before the first "title:" line.
      const idx = raw.search(/(^|\n)\s*title\s*:/i)
      return raw.slice(idx).trim()
    }
    if (kind === 'yara' && /\brule\s+\w+\s*\{/i.test(raw)) {
      const idx = raw.search(/\brule\s+\w+\s*\{/i)
      return raw.slice(idx).trim()
    }
    return null
  }

  list(kind?: 'sigma' | 'yara', limit = 100): DetectionRule[] {
    const db = getDatabase()
    if (kind) {
      return db.prepare(`
        SELECT id, rule_type, name, body, source_report_id, notes, created_at
        FROM detection_rules WHERE rule_type = ? ORDER BY created_at DESC LIMIT ?
      `).all(kind, limit) as DetectionRule[]
    }
    return db.prepare(`
      SELECT id, rule_type, name, body, source_report_id, notes, created_at
      FROM detection_rules ORDER BY created_at DESC LIMIT ?
    `).all(limit) as DetectionRule[]
  }

  get(id: string): DetectionRule | null {
    const db = getDatabase()
    return (db.prepare('SELECT id, rule_type, name, body, source_report_id, notes, created_at FROM detection_rules WHERE id = ?').get(id) as DetectionRule) || null
  }

  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM detection_rules WHERE id = ?').run(id)
  }
}

export const detectionRuleService = new DetectionRuleService()
