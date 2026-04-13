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
    // Match ## Section Name or **Section Name**
    const patterns = [
      new RegExp(`##\\s*\\*?\\*?${sectionName}\\*?\\*?[\\s\\S]*?(?=##|$)`, 'i'),
      new RegExp(`\\*\\*${sectionName}\\*\\*[\\s\\S]*?(?=\\*\\*[A-Z]|##|$)`, 'i')
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
    const items = this.extractSection(content, 'Recommended Actions')
    if (items.length === 0) {
      // Try alternative headings
      const alt = this.extractSection(content, 'Actions')
      items.push(...alt)
    }

    return items.map((item) => ({
      action: item,
      priority: this.classifyPriority(item)
    }))
  }

  private extractGaps(content: string): Array<{ description: string; category: string; severity: 'critical' | 'high' | 'medium' | 'low' }> {
    const items = this.extractSection(content, 'Information Gaps')
    if (items.length === 0) {
      const alt = this.extractSection(content, 'Gaps')
      items.push(...alt)
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
      // Match: - item, * item, 1. item, • item
      const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/)
      if (bulletMatch) {
        const clean = bulletMatch[1].replace(/\*\*/g, '').trim()
        if (clean.length > 5) items.push(clean)
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
