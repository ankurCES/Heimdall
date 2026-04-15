import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel, Discipline } from '@common/types/intel'
import { JSONPath } from 'jsonpath-plus'
import log from 'electron-log'

// Generic JSON API endpoint collector
// Configurable via sourceConfig.config — supports any REST API returning JSON
//
// Example config:
// {
//   url: 'https://api.example.com/threats',
//   method: 'GET',
//   headers: { 'X-API-Key': 'abc' },
//   jsonPath: '$.data.threats[*]',
//   fieldMap: {
//     title: 'name',
//     content: 'description',
//     severity: 'level',
//     severityMap: { critical: 'critical', high: 'high', medium: 'medium' },
//     sourceUrl: 'url',
//     latitude: 'location.lat',
//     longitude: 'location.lon'
//   },
//   discipline: 'cybint'
// }

interface ApiConfig {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  // Header values starting with 'settings:apikeys.X' get resolved from
  // SettingsService at runtime — keeps API keys out of source config
  body?: string
  jsonPath?: string
  fieldMap?: {
    title?: string
    content?: string
    severity?: string
    severityMap?: Record<string, ThreatLevel>
    sourceUrl?: string
    latitude?: string
    longitude?: string
    timestamp?: string
  }
  discipline?: Discipline
  defaultSeverity?: ThreatLevel
  bypassRobots?: boolean
  maxItems?: number
}

export class ApiEndpointCollector extends BaseCollector {
  readonly discipline: Discipline = 'osint'
  readonly type = 'api-endpoint'

  async collect(): Promise<IntelReport[]> {
    const cfg = (this.sourceConfig?.config || {}) as ApiConfig
    if (!cfg.url) {
      log.warn(`ApiEndpointCollector: missing URL for ${this.sourceConfig?.name}`)
      return []
    }

    const reports: IntelReport[] = []
    const discipline = cfg.discipline || 'osint'
    const defaultSeverity = cfg.defaultSeverity || 'info'

    try {
      // Resolve header values like 'settings:apikeys.alpaca_key_id' from SettingsService
      const resolvedHeaders = await this.resolveHeaders(cfg.headers || {})

      const response = cfg.bypassRobots
        ? await fetch(cfg.url, {
            method: cfg.method || 'GET',
            headers: { 'User-Agent': 'Heimdall/0.1.0', Accept: 'application/json', ...resolvedHeaders },
            body: cfg.body,
            signal: AbortSignal.timeout(20000)
          })
        : await this.safeFetch(cfg.url, {
            headers: { Accept: 'application/json', ...resolvedHeaders },
            timeout: 20000
          })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()

      // Extract array of records via JSONPath
      let items: unknown[]
      if (cfg.jsonPath) {
        const result = JSONPath({ path: cfg.jsonPath, json: data as object })
        items = Array.isArray(result) ? result : [result]
      } else if (Array.isArray(data)) {
        items = data
      } else if (data && typeof data === 'object') {
        // Try common array fields
        const obj = data as Record<string, unknown>
        items = (obj.data || obj.items || obj.results || obj.records || [data]) as unknown[]
      } else {
        items = [data]
      }

      const maxItems = cfg.maxItems || 50
      for (const item of items.slice(0, maxItems)) {
        if (!item || typeof item !== 'object') continue

        const map = cfg.fieldMap || {}
        const title = this.extract(item, map.title) || 'Untitled'
        const content = this.extract(item, map.content) || JSON.stringify(item).slice(0, 1000)
        const sourceUrl = this.extract(item, map.sourceUrl) || cfg.url
        const latStr = this.extract(item, map.latitude)
        const lonStr = this.extract(item, map.longitude)
        const lat = latStr ? parseFloat(latStr) : null
        const lon = lonStr ? parseFloat(lonStr) : null

        // Map severity
        let severity: ThreatLevel = defaultSeverity
        if (map.severity) {
          const sevValue = this.extract(item, map.severity)
          if (sevValue) {
            if (map.severityMap && map.severityMap[sevValue]) {
              severity = map.severityMap[sevValue]
            } else if (['critical', 'high', 'medium', 'low', 'info'].includes(sevValue)) {
              severity = sevValue as ThreatLevel
            }
          }
        }

        reports.push({
          ...this.createReport({
            title: String(title).slice(0, 200),
            content: String(content).slice(0, 5000),
            severity,
            sourceUrl: String(sourceUrl),
            sourceName: this.sourceConfig?.name || 'Custom API',
            latitude: lat && !isNaN(lat) ? lat : undefined,
            longitude: lon && !isNaN(lon) ? lon : undefined,
            verificationScore: 70
          }),
          discipline
        })
      }

      log.info(`ApiEndpoint [${this.sourceConfig?.name}]: ${reports.length} reports from ${items.length} items`)
    } catch (err) {
      log.warn(`ApiEndpointCollector failed for ${cfg.url}: ${err}`)
    }

    return reports
  }

  // Resolve header values starting with 'settings:apikeys.X' from SettingsService
  // e.g., 'settings:apikeys.alpaca_key_id' -> the value stored in Settings → API Keys
  private async resolveHeaders(headers: Record<string, string>): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {}
    let settingsService: { get: (key: string) => string | undefined } | null = null

    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string' && value.startsWith('settings:')) {
        if (!settingsService) {
          try {
            const mod = await import('../../services/settings/SettingsService')
            settingsService = mod.settingsService as never
          } catch {
            log.warn(`ApiEndpoint: settings reference but service unavailable`)
            continue
          }
        }
        const key = value.replace(/^settings:/, '')
        const secret = settingsService?.get<string>(key as never) || ''
        if (!secret) {
          log.warn(`ApiEndpoint: empty secret for ${key} (configure in Settings → API Keys)`)
        }
        resolved[name] = secret
      } else {
        resolved[name] = value
      }
    }
    return resolved
  }

  // Extract value from object using dot path (e.g., 'location.lat') or JSONPath ($.foo.bar)
  private extract(obj: unknown, path?: string): string | undefined {
    if (!path || !obj || typeof obj !== 'object') return undefined

    // JSONPath
    if (path.startsWith('$')) {
      try {
        const result = JSONPath({ path, json: obj as object })
        return Array.isArray(result) && result.length > 0 ? String(result[0]) : undefined
      } catch {
        return undefined
      }
    }

    // Simple dot path
    const parts = path.split('.')
    let cur: unknown = obj
    for (const p of parts) {
      if (cur && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[p]
      } else {
        return undefined
      }
    }
    return cur != null ? String(cur) : undefined
  }
}
