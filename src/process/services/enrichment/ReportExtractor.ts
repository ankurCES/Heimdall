// Extracts structured data from LLM intelligence briefing responses
// Parses: Key Findings, Recommended Actions, Information Gaps

export interface ExtractedReport {
  title: string
  keyFindings: string[]
  actions: Array<{ action: string; priority: 'critical' | 'high' | 'medium' | 'low' }>
  gaps: Array<{ description: string; category: string; severity: 'critical' | 'high' | 'medium' | 'low' }>
}

export class ReportExtractor {
  extract(content: string): ExtractedReport {
    return {
      title: this.extractTitle(content),
      keyFindings: this.extractSection(content, 'Key Findings'),
      actions: this.extractActions(content),
      gaps: this.extractGaps(content)
    }
  }

  private extractTitle(content: string): string {
    // Try ## heading first
    const headingMatch = content.match(/^#{1,3}\s+(.+)$/m)
    if (headingMatch) return headingMatch[1].trim().slice(0, 120)

    // Try **bold** first line
    const boldMatch = content.match(/\*\*(.+?)\*\*/)
    if (boldMatch) return boldMatch[1].trim().slice(0, 120)

    // First meaningful line
    const firstLine = content.split('\n').find((l) => l.trim().length > 10)
    return firstLine?.trim().slice(0, 120) || 'Intelligence Briefing'
  }

  private extractSection(content: string, sectionName: string): string[] {
    // Match various heading formats:
    // ## Recommended Actions
    // ### 4. Recommended Actions
    // **Recommended Actions**
    // # RECOMMENDED COLLECTION ACTIONS
    // Escape regex specials in section name (handles "&" etc.)
    const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const patterns = [
      new RegExp(`#{1,4}\\s*(?:\\d+\\.?\\s*)?\\*?\\*?${escaped}\\*?\\*?[\\s\\S]*?(?=#{1,4}\\s|$)`, 'i'),
      new RegExp(`\\*\\*(?:\\d+\\.?\\s*)?${escaped}\\*\\*[\\s\\S]*?(?=\\*\\*[A-Z\\d]|#{1,4}\\s|$)`, 'i')
    ]

    for (const pattern of patterns) {
      const match = content.match(pattern)
      if (match) {
        return this.extractBulletPoints(match[0])
      }
    }
    return []
  }

  private extractActions(content: string): Array<{ action: string; priority: 'critical' | 'high' | 'medium' | 'low' }> {
    // Try all variations of the heading used across different prompt styles.
    const headings = [
      'Recommended Collection Actions',   // CIA-grade prompt
      'Recommended Actions',              // standard
      'Collection Actions',
      'Actions'
    ]
    let items: string[] = []
    for (const heading of headings) {
      items = this.extractSection(content, heading)
      if (items.length > 0) break
    }

    return items.map((item) => ({
      action: item,
      priority: this.classifyPriority(item)
    }))
  }

  private extractGaps(content: string): Array<{ description: string; category: string; severity: 'critical' | 'high' | 'medium' | 'low' }> {
    const headings = [
      'Information Gaps & Analytic Caveats',  // CIA-grade prompt
      'Information Gaps',                      // standard
      'Analytic Caveats',
      'Gaps'
    ]
    let items: string[] = []
    for (const heading of headings) {
      items = this.extractSection(content, heading)
      if (items.length > 0) break
    }

    return items.map((item) => ({
      description: item,
      category: this.classifyGapCategory(item),
      severity: this.classifyPriority(item)
    }))
  }

  private extractBulletPoints(text: string): string[] {
    const lines = text.split('\n')
    const items: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      // Skip heading lines
      if (trimmed.startsWith('#')) continue
      // Match: - item, * item, *   item, 1. item, • item, **item**
      const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/) ||
        trimmed.match(/^\d+\.\s+(.+)$/) ||
        trimmed.match(/^\*\s{2,}(.+)$/)
      if (bulletMatch) {
        const clean = bulletMatch[1].replace(/\*\*/g, '').replace(/\[.*?\]/g, '').trim()
        if (clean.length > 10) items.push(clean)
      }
    }
    return items
  }

  private classifyPriority(text: string): 'critical' | 'high' | 'medium' | 'low' {
    const lower = text.toLowerCase()
    if (/immediate|urgent|critical|emergency|now/.test(lower)) return 'critical'
    if (/alert|warn|escalate|priority|important/.test(lower)) return 'high'
    if (/monitor|track|watch|investigate|review/.test(lower)) return 'medium'
    return 'low'
  }

  private classifyGapCategory(text: string): string {
    const lower = text.toLowerCase()
    if (/no data|missing|unavailable|lack/.test(lower)) return 'missing_data'
    if (/unverified|unconfirmed|rumor|alleged/.test(lower)) return 'unverified'
    if (/time|temporal|when|date|period/.test(lower)) return 'temporal'
    if (/location|where|geographic|region/.test(lower)) return 'geographic'
    if (/source|origin|attribution/.test(lower)) return 'source'
    return 'general'
  }
}

export const reportExtractor = new ReportExtractor()
