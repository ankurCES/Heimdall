import type { Discipline, ThreatLevel, AlertChannel } from './intel'

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  conditions: AlertCondition[]
  channels: AlertChannel[]
  createdAt: number
}

export interface AlertCondition {
  type: 'severity' | 'keyword' | 'discipline' | 'verification' | 'geofence'
  operator: 'eq' | 'gte' | 'lte' | 'contains' | 'within'
  value: string | number
}

export interface AlertDispatchResult {
  channel: AlertChannel
  success: boolean
  error?: string
  sentAt?: number
}

export const DEFAULT_RULES: Omit<AlertRule, 'id' | 'createdAt'>[] = [
  {
    name: 'Critical Severity Alert',
    enabled: true,
    conditions: [{ type: 'severity', operator: 'eq', value: 'critical' }],
    channels: ['email', 'telegram']
  },
  {
    name: 'High Severity Alert',
    enabled: true,
    conditions: [{ type: 'severity', operator: 'eq', value: 'high' }],
    channels: ['email']
  }
]
