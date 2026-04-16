import { settingsService } from '../settings/SettingsService'

/**
 * Cross-cutting G — Personalised agent prompt builder.
 *
 * Replaces the hardcoded SYSTEM_PROMPT / CAVEMAN_PROMPT / AGENT_SYSTEM_PROMPT
 * constants with a dynamic builder that injects analyst preferences:
 *   - Name / alias
 *   - Area of focus (e.g. "Iran nuclear programme", "APT groups in SEA")
 *   - Preferred disciplines
 *   - Brevity level (verbose / concise / caveman)
 *   - Custom instructions block (free-text)
 *
 * Preferences are stored via SettingsService under `analyst.profile`.
 * Every LLM path (chat, agent, council, wargaming) calls
 * `PromptBuilder.build(mode)` instead of reading a constant.
 */

export interface AnalystProfile {
  name?: string
  focusArea?: string
  preferredDisciplines?: string[]
  brevity?: 'verbose' | 'concise' | 'caveman'
  customInstructions?: string
  speechVoice?: string
  speechRate?: number
  autoSpeak?: boolean
}

const BASE_PROMPT = `You are Heimdall, an intelligence analyst AI assistant. You help analyze collected intelligence data from multiple disciplines (OSINT, CYBINT, FININT, SOCMINT, GEOINT, SIGINT, RUMINT, CI, Agency).

When presented with intelligence reports, you:
- Identify patterns, connections, and anomalies across disciplines
- Assess threat levels and verification scores critically
- Cross-reference information from multiple sources
- Provide actionable analysis with clear recommendations
- Flag potential misinformation or low-verification data
- Use proper intelligence analysis tradecraft

Always cite the discipline and source of information you reference. Be precise and concise.`

const CAVEMAN_SUFFIX = `\n\nSTYLE OVERRIDE: Be ULTRA brief. Use abbreviations. Skip filler words. No intros/outros. Just facts. Max 3 sentences per point. Use bullet lists. Skip "I think"/"It appears". Data only. Cite [DISC:SOURCE].`

const CONCISE_SUFFIX = `\n\nSTYLE: Keep responses short and actionable. Prioritize conclusions over methodology. No boilerplate. Cite sources inline.`

export class PromptBuilder {
  static getProfile(): AnalystProfile {
    try {
      return (settingsService.get<AnalystProfile>('analyst.profile') ?? {}) as AnalystProfile
    } catch {
      return {}
    }
  }

  static saveProfile(profile: AnalystProfile): void {
    settingsService.set('analyst.profile', profile)
  }

  /**
   * Build the system prompt for a given mode. Injects analyst preferences
   * when present. Returns a string ready to use as the system message.
   */
  static build(mode: 'direct' | 'caveman' | 'agentic' = 'direct'): string {
    const profile = this.getProfile()
    const parts: string[] = [BASE_PROMPT]

    // Analyst identity
    if (profile.name) {
      parts.push(`\nThe analyst you are assisting is ${profile.name}.`)
    }

    // Focus area — the model should prioritize this domain
    if (profile.focusArea) {
      parts.push(`\nThe analyst's primary area of focus is: ${profile.focusArea}. Prioritize this domain when interpreting ambiguous queries and when selecting which reports to cite first.`)
    }

    // Preferred disciplines
    if (profile.preferredDisciplines && profile.preferredDisciplines.length > 0) {
      parts.push(`\nPreferred intelligence disciplines (weight these higher in analysis): ${profile.preferredDisciplines.join(', ')}.`)
    }

    // Custom instructions
    if (profile.customInstructions && profile.customInstructions.trim()) {
      parts.push(`\nAnalyst-specific instructions:\n${profile.customInstructions.trim()}`)
    }

    // Brevity override
    const brevity = mode === 'caveman' ? 'caveman' : (profile.brevity ?? 'concise')
    if (brevity === 'caveman') {
      parts.push(CAVEMAN_SUFFIX)
    } else if (brevity === 'concise') {
      parts.push(CONCISE_SUFFIX)
    }
    // 'verbose' = no suffix (full default behavior)

    return parts.join('')
  }
}
