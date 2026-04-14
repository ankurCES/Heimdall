import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Commodity & Energy Price Tracker
// Uses Yahoo Finance public API (no auth) for futures data
// Tracks key commodities: oil, gas, metals, agriculture

interface YahooQuote {
  symbol: string
  shortName: string
  regularMarketPrice: number
  regularMarketChange: number
  regularMarketChangePercent: number
  regularMarketPreviousClose: number
  currency: string
}

// Key commodity tickers (Yahoo Finance format)
const COMMODITIES: Array<{ symbol: string; name: string; category: string }> = [
  // Energy
  { symbol: 'CL=F', name: 'WTI Crude Oil', category: 'Energy' },
  { symbol: 'BZ=F', name: 'Brent Crude Oil', category: 'Energy' },
  { symbol: 'NG=F', name: 'Natural Gas', category: 'Energy' },
  { symbol: 'RB=F', name: 'Gasoline (RBOB)', category: 'Energy' },
  // Metals
  { symbol: 'GC=F', name: 'Gold', category: 'Metals' },
  { symbol: 'SI=F', name: 'Silver', category: 'Metals' },
  { symbol: 'HG=F', name: 'Copper', category: 'Metals' },
  { symbol: 'PL=F', name: 'Platinum', category: 'Metals' },
  // Agriculture
  { symbol: 'ZW=F', name: 'Wheat', category: 'Agriculture' },
  { symbol: 'ZC=F', name: 'Corn', category: 'Agriculture' },
  { symbol: 'ZS=F', name: 'Soybeans', category: 'Agriculture' },
  { symbol: 'KC=F', name: 'Coffee', category: 'Agriculture' },
  // Indices
  { symbol: 'DX-Y.NYB', name: 'US Dollar Index', category: 'Currency' },
  { symbol: '^VIX', name: 'VIX Volatility', category: 'Volatility' }
]

export class CommodityCollector extends BaseCollector {
  readonly discipline = 'finint' as const
  readonly type = 'commodity'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    try {
      const symbols = COMMODITIES.map((c) => c.symbol).join(',')
      // Use direct fetch — Yahoo Finance blocks via robots.txt
      const response = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName,currency`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(15000)
        }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as {
        quoteResponse: { result: YahooQuote[] }
      }

      const quotes = data?.quoteResponse?.result || []

      // Group by category for summary reports
      const byCategory = new Map<string, Array<{ name: string; price: number; change: number; pct: number }>>()

      for (const quote of quotes) {
        const commodity = COMMODITIES.find((c) => c.symbol === quote.symbol)
        if (!commodity) continue

        const price = quote.regularMarketPrice
        const change = quote.regularMarketChange
        const pct = quote.regularMarketChangePercent

        if (!byCategory.has(commodity.category)) byCategory.set(commodity.category, [])
        byCategory.get(commodity.category)!.push({ name: commodity.name, price, change, pct })

        // Individual alert for significant moves (>5%)
        if (Math.abs(pct) > 5) {
          const direction = pct > 0 ? 'SURGE' : 'CRASH'
          reports.push(this.createReport({
            title: `Commodity ${direction}: ${commodity.name} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
            content: `**Commodity**: ${commodity.name}\n**Category**: ${commodity.category}\n**Price**: $${price.toFixed(2)} ${quote.currency}\n**Change**: ${change > 0 ? '+' : ''}${change.toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)\n**Previous Close**: $${quote.regularMarketPreviousClose.toFixed(2)}\n\n_A move of ${Math.abs(pct).toFixed(1)}% is significant and may indicate supply disruption, geopolitical event, or market stress._`,
            severity: Math.abs(pct) > 10 ? 'critical' : 'high',
            sourceUrl: `https://finance.yahoo.com/quote/${commodity.symbol}`,
            sourceName: 'Yahoo Finance Commodities',
            verificationScore: 95
          }))
        }
      }

      // Category summary reports
      for (const [category, items] of byCategory) {
        const lines = items.map((i) => {
          const arrow = i.pct > 0 ? '\u2191' : i.pct < 0 ? '\u2193' : '\u2192'
          return `- **${i.name}**: $${i.price.toFixed(2)} ${arrow} ${i.pct > 0 ? '+' : ''}${i.pct.toFixed(2)}%`
        }).join('\n')

        const avgPct = items.reduce((s, i) => s + Math.abs(i.pct), 0) / items.length
        const severity: ThreatLevel = avgPct > 5 ? 'high' : avgPct > 2 ? 'medium' : 'info'

        reports.push(this.createReport({
          title: `Commodities: ${category} Market Summary`,
          content: `**Category**: ${category}\n**Items**: ${items.length}\n\n${lines}\n\n_Updated from Yahoo Finance futures market data._`,
          severity,
          sourceUrl: 'https://finance.yahoo.com/markets/commodities/',
          sourceName: 'Yahoo Finance Commodities',
          verificationScore: 95
        }))
      }

      log.info(`Commodities: ${quotes.length} quotes, ${reports.length} reports`)
    } catch (err) {
      log.warn(`Commodity collection failed: ${err}`)
    }

    return reports
  }
}
