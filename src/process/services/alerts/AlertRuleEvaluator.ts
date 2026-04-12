import type { IntelReport, ThreatLevel } from '@common/types/intel'
import type { AlertRule, AlertCondition } from '@common/types/alerts'
import { THREAT_LEVEL_ORDER } from '@common/types/intel'

export class AlertRuleEvaluator {
  evaluate(report: IntelReport, rules: AlertRule[]): AlertRule[] {
    return rules.filter((rule) => {
      if (!rule.enabled) return false
      // All conditions must match (AND logic)
      return rule.conditions.every((cond) => this.matchCondition(report, cond))
    })
  }

  private matchCondition(report: IntelReport, cond: AlertCondition): boolean {
    switch (cond.type) {
      case 'severity':
        return this.matchSeverity(report.severity, cond)
      case 'keyword':
        return this.matchKeyword(report, cond)
      case 'discipline':
        return report.discipline === cond.value
      case 'verification':
        return this.matchNumeric(report.verificationScore, cond)
      case 'geofence':
        return this.matchGeofence(report, cond)
      default:
        return false
    }
  }

  private matchSeverity(severity: ThreatLevel, cond: AlertCondition): boolean {
    const reportLevel = THREAT_LEVEL_ORDER[severity]
    const condLevel = THREAT_LEVEL_ORDER[cond.value as ThreatLevel] ?? 4

    switch (cond.operator) {
      case 'eq': return reportLevel === condLevel
      case 'gte': return reportLevel <= condLevel // lower number = higher severity
      case 'lte': return reportLevel >= condLevel
      default: return false
    }
  }

  private matchKeyword(report: IntelReport, cond: AlertCondition): boolean {
    const text = `${report.title} ${report.content}`.toLowerCase()
    const keyword = String(cond.value).toLowerCase()

    if (cond.operator === 'contains') {
      // Support regex patterns
      try {
        return new RegExp(keyword, 'i').test(text)
      } catch {
        return text.includes(keyword)
      }
    }
    return false
  }

  private matchNumeric(value: number, cond: AlertCondition): boolean {
    const target = Number(cond.value)
    switch (cond.operator) {
      case 'gte': return value >= target
      case 'lte': return value <= target
      case 'eq': return value === target
      default: return false
    }
  }

  private matchGeofence(report: IntelReport, cond: AlertCondition): boolean {
    if (!report.latitude || !report.longitude) return false
    // cond.value = "lat,lon,radiusKm"
    const parts = String(cond.value).split(',').map(Number)
    if (parts.length < 3) return false
    const [lat, lon, radiusKm] = parts
    const dist = this.haversineKm(report.latitude, report.longitude, lat, lon)
    return dist <= radiusKm
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }
}
