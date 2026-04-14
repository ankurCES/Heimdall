import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Polymarket Prediction Markets — Geopolitical contract prices
// Free, no auth — Gamma API for event listing
// Filters out sports/entertainment, requires $50K+ volume

const POLYMARKET_API = 'https://gamma-api.polymarket.com'

// Exclude non-geopolitical topics
const EXCLUDE_KEYWORDS = [
  'super bowl', 'nfl', 'nba', 'mlb', 'nhl', 'premier league', 'champions league',
  'world cup soccer', 'tennis', 'golf', 'boxing', 'ufc', 'mma', 'f1', 'formula',
  'oscars', 'grammy', 'emmy', 'bachelor', 'bachelorette', 'reality tv', 'survivor',
  'big brother', 'love island', 'tiktok', 'youtube', 'twitch', 'spotify',
  'bitcoin price', 'ethereum price', 'solana price', 'dogecoin', 'memecoin',
  'weather temperature', 'will it rain', 'will it snow',
  'baby name', 'royal family', 'celebrity', 'kardashian', 'taylor swift',
  'elon musk tweet', 'kanye', 'drake', 'beyonce'
]

// Geopolitical signal keywords — boost these
const GEO_KEYWORDS = [
  'war', 'conflict', 'military', 'invasion', 'attack', 'strike', 'sanctions',
  'election', 'president', 'prime minister', 'regime', 'coup', 'revolution',
  'nuclear', 'missile', 'nato', 'china', 'taiwan', 'russia', 'ukraine',
  'iran', 'israel', 'north korea', 'syria', 'gaza', 'hamas', 'hezbollah',
  'ceasefire', 'peace', 'treaty', 'embargo', 'tariff', 'trade war',
  'fed rate', 'recession', 'inflation', 'default', 'debt ceiling',
  'pandemic', 'outbreak', 'who emergency', 'vaccine'
]

interface PolymarketEvent {
  id: string
  title: string
  slug: string
  description: string
  startDate: string
  endDate: string
  active: boolean
  closed: boolean
  volume: number
  liquidity: number
  markets: Array<{
    id: string
    question: string
    outcomePrices: string // JSON string like '["0.65","0.35"]'
    volume: number
    active: boolean
  }>
}

export class PredictionMarketCollector extends BaseCollector {
  readonly discipline = 'osint' as const
  readonly type = 'prediction-market'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const data = await this.fetchJson<Array<PolymarketEvent>>(
        `${POLYMARKET_API}/events?active=true&closed=false&limit=100&order=volume&ascending=false`,
        { timeout: 20000 }
      )

      if (!data || !Array.isArray(data)) return reports

      for (const event of data) {
        // Filter: must have volume > $50K
        if ((event.volume || 0) < 50000) continue

        // Filter: exclude non-geopolitical topics
        const titleLower = event.title.toLowerCase()
        if (EXCLUDE_KEYWORDS.some((kw) => titleLower.includes(kw))) continue

        // Boost: check if geopolitically relevant
        const isGeo = GEO_KEYWORDS.some((kw) => titleLower.includes(kw))
        if (!isGeo && event.volume < 200000) continue // Non-geo needs higher volume

        // Parse market probabilities
        const markets = (event.markets || []).filter((m) => m.active)
        if (markets.length === 0) continue

        const marketLines = markets.slice(0, 5).map((m) => {
          let prices: number[] = []
          try { prices = JSON.parse(m.outcomePrices) } catch {}
          const yesProb = prices[0] ? (prices[0] * 100).toFixed(0) : '?'
          return `- **${m.question}**: ${yesProb}% YES ($${(m.volume / 1000).toFixed(0)}K vol)`
        }).join('\n')

        // Severity based on probability of "destabilizing" events
        const primaryMarket = markets[0]
        let primaryProb = 0.5
        try {
          const prices = JSON.parse(primaryMarket.outcomePrices)
          primaryProb = prices[0] || 0.5
        } catch {}

        const severity = this.probabilitySeverity(primaryProb, isGeo)

        reports.push(this.createReport({
          title: `Prediction: ${event.title} (${(primaryProb * 100).toFixed(0)}%)`,
          content: `**Event**: ${event.title}\n**Volume**: $${(event.volume / 1000).toFixed(0)}K\n**Liquidity**: $${((event.liquidity || 0) / 1000).toFixed(0)}K\n**Status**: ${event.active ? 'Active' : 'Closed'}\n**End Date**: ${event.endDate || 'TBD'}\n\n**Markets**:\n${marketLines}\n\n${event.description ? event.description.slice(0, 300) : ''}\n\n_Real-money prediction market — prices reflect crowd-aggregated probability estimates._`,
          severity,
          sourceUrl: `https://polymarket.com/event/${event.slug}`,
          sourceName: 'Polymarket',
          verificationScore: 70
        }))
      }

      log.info(`Polymarket: ${reports.length} geopolitical contracts (${data.length} total events scanned)`)
    } catch (err) {
      log.warn(`Polymarket collection failed: ${err}`)
    }

    return reports
  }

  private probabilitySeverity(prob: number, isGeo: boolean): ThreatLevel {
    // High-probability negative events are more concerning
    if (isGeo && prob > 0.8) return 'critical'
    if (isGeo && prob > 0.6) return 'high'
    if (prob > 0.7) return 'medium'
    return 'low'
  }
}
