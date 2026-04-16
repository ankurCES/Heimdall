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

    const entities = db.prepare(
      `SELECT entity_type, entity_value FROM intel_entities WHERE report_id = ? LIMIT 50`
    ).all(reportId) as Array<{ entity_type: string; entity_value: string }>
    const iocSummary = entities.length > 0
      ? entities.map((e) => `${e.entity_type}: ${e.entity_value}`).join('\n')
      : '(no extracted entities)'

    const system = kind === 'sigma' ? SIGMA_SYSTEM : YARA_SYSTEM
    const prompt = `${system}\n\n---REPORT---\nTitle: ${report.title}\nDiscipline: ${report.discipline}\n\nContent:\n${report.content.slice(0, 8000)}\n\nExtracted IOCs:\n${iocSummary}\n---END---\n\nGenerate the rule now.`
    const raw = await llmService.complete(prompt, undefined, 2000)
    const body = this.extractFenced(raw, kind)
    if (!body) throw new Error(`Model did not produce a valid ${kind} rule`)

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
    const tag = kind === 'sigma' ? 'yaml' : 'yara'
    const fenced = new RegExp('```' + tag + '\\n([\\s\\S]+?)```', 'i').exec(raw)
    if (fenced) return fenced[1].trim()
    const anyFence = /```\n?([\s\S]+?)```/.exec(raw)
    if (anyFence) return anyFence[1].trim()
    // Accept un-fenced output that looks right.
    if (kind === 'sigma' && /^\s*title\s*:/m.test(raw)) return raw.trim()
    if (kind === 'yara' && /^\s*rule\s+\w+\s*\{/m.test(raw)) return raw.trim()
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
