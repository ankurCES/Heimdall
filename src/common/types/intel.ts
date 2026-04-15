export type Discipline =
  | 'osint'
  | 'cybint'
  | 'finint'
  | 'socmint'
  | 'geoint'
  | 'sigint'
  | 'rumint'
  | 'ci'
  | 'agency'
  | 'imint'

export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type SourceType = 'rss' | 'api' | 'scraper' | 'stream'

export type AlertChannel = 'email' | 'telegram' | 'meshtastic'

export type AlertStatus = 'pending' | 'sent' | 'failed'

export interface IntelReport {
  id: string
  discipline: Discipline
  title: string
  content: string
  summary: string | null
  severity: ThreatLevel
  sourceId: string
  sourceUrl: string | null
  sourceName: string
  contentHash: string
  latitude: number | null
  longitude: number | null
  verificationScore: number
  /** NATO STANAG 2511 information credibility rating: 1=confirmed, 2=probably true,
   *  3=possibly true, 4=doubtfully true, 5=improbable, 6=truth cannot be judged.
   *  Null = not yet rated; UI treats as 6 (unknown). */
  credibility: number | null
  /** STANAG 2511 source reliability A–F, joined from the source row. */
  sourceReliability: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | null
  /** US/NATO classification level. Defaults to UNCLASSIFIED. */
  classification: 'UNCLASSIFIED' | 'CONFIDENTIAL' | 'SECRET' | 'TOP SECRET'
  reviewed: boolean
  createdAt: number
  updatedAt: number
}

export interface Source {
  id: string
  name: string
  discipline: Discipline
  type: SourceType
  config: Record<string, unknown>
  schedule: string | null
  enabled: boolean
  /** NATO STANAG 2511 source reliability: A=completely reliable,
   *  B=usually reliable, C=fairly reliable, D=not usually reliable,
   *  E=unreliable, F=reliability unknown. Null = not yet rated. */
  admiralty_reliability: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | null
  lastCollectedAt: number | null
  lastError: string | null
  errorCount: number
  createdAt: number
  updatedAt: number
}

export interface Alert {
  id: string
  intelReportId: string | null
  channel: AlertChannel
  recipient: string
  status: AlertStatus
  error: string | null
  sentAt: number | null
  createdAt: number
}

export interface AuditEntry {
  id: string
  action: string
  details: Record<string, unknown> | null
  sourceUrl: string | null
  httpStatus: number | null
  createdAt: number
}

export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  osint: 'Open Source',
  cybint: 'Cyber',
  finint: 'Financial',
  socmint: 'Social Media',
  geoint: 'Geospatial',
  sigint: 'Signals',
  rumint: 'Rumor',
  ci: 'Counter-Intel',
  agency: 'Agency',
  imint: 'Imagery'
}

export const THREAT_LEVEL_ORDER: Record<ThreatLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
}
