import log from 'electron-log'
import { llmService } from './LlmService'

/**
 * Theme 3.7 — OSINT geolocation assistant.
 *
 * Given an image (as a data URL), asks the LLM vision model to estimate
 * the geographic location based on visible clues: terrain, vegetation,
 * architecture style, road markings, signage language, sun angle,
 * shadows, satellite dishes, power-line styles, vehicle types, etc.
 *
 * Returns structured output: estimated coordinates, confidence band,
 * reasoning chain, and identified features. No external API needed —
 * the LLM does the analysis directly.
 */

export interface GeoLocationResult {
  latitude: number | null
  longitude: number | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  country: string | null
  region: string | null
  reasoning: string
  features: string[]
}

const SYSTEM_PROMPT = `You are an expert OSINT geolocation analyst. Given an image, estimate the geographic location based on visible clues.

Analyze these categories:
- **Terrain & vegetation**: biome, elevation, soil type, tree species
- **Architecture**: building style, materials, roof type, window patterns
- **Infrastructure**: road surface, lane markings, traffic signs, power lines, utility poles
- **Signage & text**: language, alphabet, brand names, phone number formats
- **Vehicles**: license plate format, vehicle types, driving side
- **Sun & shadows**: sun angle, shadow direction, time-of-day estimate
- **Cultural indicators**: clothing, advertisements, flags, religious buildings
- **Climate**: weather patterns, seasonal vegetation state

Output a JSON object with these keys:
- latitude: number or null (decimal degrees, best estimate)
- longitude: number or null (decimal degrees, best estimate)
- confidence: "high" | "medium" | "low" | "unknown"
- country: string or null (best guess)
- region: string or null (state/province/city if determinable)
- reasoning: string (2-4 sentences explaining your deduction chain)
- features: string[] (list of specific clues you identified)

If you cannot determine a location, set lat/lng to null and confidence to "unknown".
Output ONLY the JSON object. No prose wrapper.`

export class GeoLocationAssistant {
  async analyze(imageDataUrl: string): Promise<GeoLocationResult> {
    if (!llmService.hasUsableConnection()) {
      throw new Error('No LLM connection configured. Add one in Settings → LLM.')
    }

    const raw = await llmService.completeVision(SYSTEM_PROMPT, [imageDataUrl], { timeoutMs: 120000 })

    try {
      // Extract JSON from the response — tolerate code fences.
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON in response')
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>

      const result: GeoLocationResult = {
        latitude: typeof parsed.latitude === 'number' ? parsed.latitude : null,
        longitude: typeof parsed.longitude === 'number' ? parsed.longitude : null,
        confidence: ['high', 'medium', 'low', 'unknown'].includes(String(parsed.confidence))
          ? parsed.confidence as GeoLocationResult['confidence']
          : 'unknown',
        country: typeof parsed.country === 'string' ? parsed.country : null,
        region: typeof parsed.region === 'string' ? parsed.region : null,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : raw.slice(0, 500),
        features: Array.isArray(parsed.features) ? (parsed.features as unknown[]).map(String) : []
      }

      log.info(`geolocation: ${result.confidence} confidence → ${result.country ?? 'unknown'} (${result.latitude?.toFixed(3)}, ${result.longitude?.toFixed(3)})`)
      return result
    } catch (err) {
      log.warn(`geolocation: failed to parse LLM response: ${(err as Error).message}`)
      return {
        latitude: null, longitude: null, confidence: 'unknown',
        country: null, region: null,
        reasoning: raw.slice(0, 500),
        features: []
      }
    }
  }
}

export const geoLocationAssistant = new GeoLocationAssistant()
