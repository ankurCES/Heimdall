import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import type { IntelReport } from '@common/types/intel'
import log from 'electron-log'

// Regex patterns for entity extraction
const PATTERNS = {
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  url: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g,
  cve: /CVE-\d{4}-\d{4,}/gi,
  hash_md5: /\b[a-fA-F0-9]{32}\b/g,
  hash_sha256: /\b[a-fA-F0-9]{64}\b/g,
  country: /\b(?:United States|Russia|China|Iran|North Korea|Syria|Ukraine|Israel|India|Pakistan|Afghanistan|Iraq|Yemen|Libya|Somalia|Nigeria|Brazil|Germany|France|United Kingdom|Japan|South Korea|Turkey|Saudi Arabia|Egypt|Mexico|Colombia|Venezuela)\b/gi,
  organization: /\b(?:NATO|UN|EU|INTERPOL|FBI|CIA|NSA|MI5|MI6|FSB|GRU|Mossad|ISI|GCHQ|CISA|EUROPOL|WHO|WTO|IMF|IAEA|OPCW|ICC)\b/g,
  threat_actor: /\b(?:APT\d+|Lazarus|Fancy Bear|Cozy Bear|Equation Group|Sandworm|Turla|Charming Kitten|MuddyWater|DarkSide|REvil|LockBit|BlackCat|Conti|Cl0p|Play|Akira|ALPHV)\b/gi,
  malware: /\b(?:Emotet|TrickBot|QakBot|Cobalt Strike|Mimikatz|Metasploit|njRAT|AgentTesla|RedLine|Raccoon|Vidar|StealC|AsyncRAT|Remcos)\b/gi
}

// Auto-tag rules based on content keywords
const TAG_RULES: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'terrorism', patterns: [/\bterror(?:ism|ist)\b/i, /\bextremis[tm]\b/i, /\bjihad\b/i, /\bradicaliz/i] },
  { tag: 'cyber-attack', patterns: [/\bcyber.?attack\b/i, /\bhack(?:ed|ing|er)\b/i, /\bbreach\b/i, /\bransomware\b/i] },
  { tag: 'military', patterns: [/\bmilitary\b/i, /\barmed forces\b/i, /\bdefense\b/i, /\bweapon\b/i] },
  { tag: 'nuclear', patterns: [/\bnuclear\b/i, /\buranium\b/i, /\bproliferation\b/i, /\bwarhead\b/i] },
  { tag: 'sanctions', patterns: [/\bsanction/i, /\bembargo\b/i, /\bOFAC\b/i, /\bSDN\b/i] },
  { tag: 'natural-disaster', patterns: [/\bearthquake\b/i, /\btsunami\b/i, /\bhurricane\b/i, /\bflood\b/i, /\bwildfire\b/i] },
  { tag: 'financial-crime', patterns: [/\bmoney laundering\b/i, /\bfraud\b/i, /\bcorruption\b/i, /\bembezzlement\b/i] },
  { tag: 'narcotics', patterns: [/\bdrug\b/i, /\bnarcotics?\b/i, /\bfentanyl\b/i, /\bcocaine\b/i, /\bcartel\b/i] },
  { tag: 'human-trafficking', patterns: [/\bhuman trafficking\b/i, /\bforced labor\b/i, /\bslavery\b/i] },
  { tag: 'espionage', patterns: [/\bespionage\b/i, /\bspy\b/i, /\bintelligence officer\b/i, /\bcovert\b/i] },
  { tag: 'pandemic', patterns: [/\bpandemic\b/i, /\boutbreak\b/i, /\bepidemic\b/i, /\bwho alert\b/i] },
  { tag: 'disinformation', patterns: [/\bdisinformation\b/i, /\bmisinformation\b/i, /\bfake news\b/i, /\bdeepfake\b/i] },
  { tag: 'critical-infrastructure', patterns: [/\bcritical infrastructure\b/i, /\bpower grid\b/i, /\bwater supply\b/i, /\bpipeline\b/i] },
  { tag: 'election-interference', patterns: [/\belection\b.*\binterference\b/i, /\bvote\b.*\bmanipulat/i, /\belection security\b/i] },
  { tag: 'refugee', patterns: [/\brefugee\b/i, /\basylum\b/i, /\bdisplaced person\b/i, /\bmigration crisis\b/i] },
  { tag: 'data-breach', patterns: [/\bdata breach\b/i, /\bdata leak\b/i, /\bcredential\b.*\bleak\b/i, /\bexposed data\b/i] },
  { tag: 'vulnerability', patterns: [/\bCVE-/i, /\bzero.?day\b/i, /\bvulnerabilit/i, /\bexploit\b/i] }
]

export class IntelEnricher {
  enrichReport(report: IntelReport): void {
    const db = getDatabase()
    const now = timestamp()
    const text = `${report.title} ${report.content}`

    // 1. Extract entities
    const entities = this.extractEntities(text)
    if (entities.length > 0) {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO intel_entities (id, report_id, entity_type, entity_value, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      const tx = db.transaction(() => {
        for (const entity of entities) {
          stmt.run(generateId(), report.id, entity.type, entity.value, entity.confidence, now)
        }
      })
      tx()
    }

    // 2. Auto-tag
    const tags = this.extractTags(text)
    tags.push({ tag: report.discipline, confidence: 1.0 })
    tags.push({ tag: `severity:${report.severity}`, confidence: 1.0 })

    // Squawk enrichment for ADS-B reports
    if (report.sourceName.includes('ADS-B') || report.discipline === 'sigint') {
      const squawkMatch = text.match(/\bSquawk[:\s]*(\d{4})\b/i)
      if (squawkMatch) {
        const { squawkClassifier } = require('../sigint/SquawkClassifier')
        const classification = squawkClassifier.classify(squawkMatch[1])
        tags.push({ tag: `squawk:${classification.meaning.toLowerCase().replace(/\s+/g, '-')}`, confidence: 0.95 })
        tags.push({ tag: `squawk-category:${classification.category}`, confidence: 0.95 })
        if (classification.category === 'emergency') tags.push({ tag: 'emergency-squawk', confidence: 1.0 })
        if (classification.category === 'military') tags.push({ tag: 'military-aircraft', confidence: 0.9 })
      }
    }

    if (tags.length > 0) {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      const tx = db.transaction(() => {
        for (const t of tags) {
          stmt.run(report.id, t.tag, t.confidence, 'auto', now)
        }
      })
      tx()
    }

    // 3. Find links to existing reports (shared entities)
    this.findLinks(report, entities, db, now)

    // 4. Corroboration score — how many independent sources report similar content
    const corroborationScore = this.calculateCorroboration(report, entities, tags, db)
    if (corroborationScore > 0) {
      // Update verification score based on corroboration
      const newScore = Math.min(100, report.verificationScore + corroborationScore)
      db.prepare('UPDATE intel_reports SET verification_score = ?, updated_at = ? WHERE id = ?').run(newScore, now, report.id)

      // Add corroboration tag
      db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        report.id, `corroboration:${corroborationScore >= 20 ? 'high' : corroborationScore >= 10 ? 'medium' : 'low'}`,
        corroborationScore / 30, 'enricher', now
      )
    }
  }

  private calculateCorroboration(
    report: IntelReport,
    entities: Array<{ type: string; value: string }>,
    tags: Array<{ tag: string }>,
    db: ReturnType<typeof getDatabase>
  ): number {
    let score = 0
    const oneDay = 24 * 60 * 60 * 1000

    // 1. Count independent sources reporting same entities (different source_name)
    for (const entity of entities.slice(0, 5)) {
      const matches = db.prepare(`
        SELECT COUNT(DISTINCT source_name) as sources FROM intel_reports r
        JOIN intel_entities e ON r.id = e.report_id
        WHERE e.entity_value = ? AND e.entity_type = ? AND r.id != ?
        AND r.source_name != ? AND r.created_at > ?
      `).get(entity.value, entity.type, report.id, report.sourceName, report.createdAt - oneDay * 3) as { sources: number }

      if (matches.sources >= 3) score += 15 // 3+ sources = strong corroboration
      else if (matches.sources >= 2) score += 10
      else if (matches.sources >= 1) score += 5
    }

    // 2. Count reports with same tags from different disciplines
    const reportTags = tags.filter((t) => !t.tag.startsWith('severity:') && t.tag !== report.discipline).slice(0, 3)
    for (const tag of reportTags) {
      const crossDiscipline = db.prepare(`
        SELECT COUNT(DISTINCT discipline) as disciplines FROM intel_reports r
        JOIN intel_tags t ON r.id = t.report_id
        WHERE t.tag = ? AND r.id != ? AND r.discipline != ? AND r.created_at > ?
      `).get(tag.tag, report.id, report.discipline, report.createdAt - oneDay * 3) as { disciplines: number }

      if (crossDiscipline.disciplines >= 2) score += 10 // Cross-discipline corroboration
      else if (crossDiscipline.disciplines >= 1) score += 5
    }

    // 3. Similar titles from different sources (keyword overlap)
    const titleWords = report.title.toLowerCase().split(/\s+/).filter((w) => w.length > 4).slice(0, 3)
    if (titleWords.length > 0) {
      const likeClause = titleWords.map(() => 'LOWER(title) LIKE ?').join(' AND ')
      const likeParams = titleWords.map((w) => `%${w}%`)

      const titleMatches = db.prepare(`
        SELECT COUNT(DISTINCT source_name) as sources FROM intel_reports
        WHERE ${likeClause} AND id != ? AND source_name != ? AND created_at > ?
      `).get(...likeParams, report.id, report.sourceName, report.createdAt - oneDay * 2) as { sources: number }

      if (titleMatches.sources >= 2) score += 10
      else if (titleMatches.sources >= 1) score += 5
    }

    return Math.min(30, score) // Cap at 30 points boost
  }

  private extractEntities(text: string): Array<{ type: string; value: string; confidence: number }> {
    const entities: Array<{ type: string; value: string; confidence: number }> = []
    const seen = new Set<string>()

    for (const [type, pattern] of Object.entries(PATTERNS)) {
      const matches = text.match(pattern) || []
      for (const match of matches) {
        const key = `${type}:${match.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)

        entities.push({
          type,
          value: type === 'country' || type === 'organization' ? match : match.toLowerCase(),
          confidence: type === 'cve' || type === 'ip' ? 0.95 : 0.8
        })
      }
    }

    return entities.slice(0, 50) // Cap per report
  }

  private extractTags(text: string): Array<{ tag: string; confidence: number }> {
    const tags: Array<{ tag: string; confidence: number }> = []

    for (const rule of TAG_RULES) {
      const matchCount = rule.patterns.filter((p) => p.test(text)).length
      if (matchCount > 0) {
        const confidence = Math.min(0.5 + matchCount * 0.2, 1.0)
        tags.push({ tag: rule.tag, confidence })
      }
    }

    return tags
  }

  private findLinks(
    report: IntelReport,
    entities: Array<{ type: string; value: string }>,
    db: ReturnType<typeof getDatabase>,
    now: number
  ): void {
    if (entities.length === 0) return

    const linkStmt = db.prepare(
      'INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )

    // Find other reports sharing the same entities
    for (const entity of entities.slice(0, 10)) { // Check top 10 entities
      const matches = db.prepare(
        'SELECT DISTINCT report_id FROM intel_entities WHERE entity_type = ? AND entity_value = ? AND report_id != ? LIMIT 5'
      ).all(entity.type, entity.value, report.id) as Array<{ report_id: string }>

      for (const match of matches) {
        linkStmt.run(
          generateId(),
          report.id,
          match.report_id,
          'shared_entity',
          entity.type === 'threat_actor' || entity.type === 'cve' ? 0.9 : 0.6,
          `Shared ${entity.type}: ${entity.value}`,
          now
        )
      }
    }

    // Temporal proximity — reports within 1 hour with same discipline
    const oneHourAgo = report.createdAt - 3600000
    const temporalMatches = db.prepare(
      'SELECT id FROM intel_reports WHERE discipline = ? AND id != ? AND created_at >= ? AND created_at <= ? LIMIT 5'
    ).all(report.discipline, report.id, oneHourAgo, report.createdAt) as Array<{ id: string }>

    for (const match of temporalMatches) {
      linkStmt.run(
        generateId(), report.id, match.id,
        'temporal', 0.3,
        `Same discipline (${report.discipline}) within 1 hour`,
        now
      )
    }
  }

  // Get enrichment data for a report
  getTags(reportId: string): Array<{ tag: string; confidence: number }> {
    const db = getDatabase()
    return db.prepare('SELECT tag, confidence FROM intel_tags WHERE report_id = ? ORDER BY confidence DESC').all(reportId) as Array<{ tag: string; confidence: number }>
  }

  getEntities(reportId: string): Array<{ type: string; value: string; confidence: number }> {
    const db = getDatabase()
    return db.prepare('SELECT entity_type as type, entity_value as value, confidence FROM intel_entities WHERE report_id = ? ORDER BY confidence DESC').all(reportId) as Array<{ type: string; value: string; confidence: number }>
  }

  getLinks(reportId: string): Array<{ linkedReportId: string; linkType: string; strength: number; reason: string }> {
    const db = getDatabase()
    const links = db.prepare(
      'SELECT target_report_id as linkedReportId, link_type as linkType, strength, reason FROM intel_links WHERE source_report_id = ? UNION SELECT source_report_id as linkedReportId, link_type as linkType, strength, reason FROM intel_links WHERE target_report_id = ? ORDER BY strength DESC LIMIT 20'
    ).all(reportId, reportId) as Array<{ linkedReportId: string; linkType: string; strength: number; reason: string }>
    return links
  }

  // Stats
  getTopTags(limit: number = 30): Array<{ tag: string; count: number }> {
    const db = getDatabase()
    return db.prepare('SELECT tag, COUNT(*) as count FROM intel_tags GROUP BY tag ORDER BY count DESC LIMIT ?').all(limit) as Array<{ tag: string; count: number }>
  }

  getTopEntities(type?: string, limit: number = 20): Array<{ type: string; value: string; count: number }> {
    const db = getDatabase()
    if (type) {
      return db.prepare('SELECT entity_type as type, entity_value as value, COUNT(*) as count FROM intel_entities WHERE entity_type = ? GROUP BY entity_value ORDER BY count DESC LIMIT ?').all(type, limit) as Array<{ type: string; value: string; count: number }>
    }
    return db.prepare('SELECT entity_type as type, entity_value as value, COUNT(*) as count FROM intel_entities GROUP BY entity_type, entity_value ORDER BY count DESC LIMIT ?').all(limit) as Array<{ type: string; value: string; count: number }>
  }
}

export const intelEnricher = new IntelEnricher()
