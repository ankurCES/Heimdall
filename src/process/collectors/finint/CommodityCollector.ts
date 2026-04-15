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
      // Yahoo Finance v7/quote endpoint now requires crumb auth (HTTP 401).
      // Use v8/chart endpoint per-symbol instead — works without auth.
      const quotes: YahooQuote[] = []
      const fetchOne = async (symbol: string): Promise<YahooQuote | null> => {
        try {
          const resp = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`,
            {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'application/json' },
              signal: AbortSignal.timeout(10000)
            }
          )
          if (!resp.ok) return null
          const j = await resp.json() as { chart?: { result?: Array<{ meta?: { symbol?: string; regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; currency?: string; longName?: string; shortName?: string } }> } }
          const meta = j?.chart?.result?.[0]?.meta
          if (!meta || meta.regularMarketPrice == null) return null
          const prev = meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice
          const change = meta.regularMarketPrice - prev
          const pct = prev !== 0 ? (change / prev) * 100 : 0
          return {
            symbol: meta.symbol || symbol,
            shortName: meta.shortName || meta.longName || symbol,
            regularMarketPrice: meta.regularMarketPrice,
            regularMarketChange: change,
            regularMarketChangePercent: pct,
            regularMarketPreviousClose: prev,
            currency: meta.currency || 'USD'
          }
        } catch {
          return null
        }
      }

      // Fetch in parallel batches of 5 to avoid overwhelming the API
      for (let i = 0; i < COMMODITIES.length; i += 5) {
        const batch = COMMODITIES.slice(i, i + 5)
        const results = await Promise.all(batch.map((c) => fetchOne(c.symbol)))
        for (const q of results) {
          if (q) quotes.push(q)
        }
      }

      if (quotes.length === 0) throw new Error('No quotes fetched from Yahoo Finance')

      // Group by category for summary reports
      const byCategory = new Map<string, Array<{ name: string; price: number; change: number; pct: number }>>()

      // Dual-write to market_quotes table for time-series charts
      try {
        const { getDatabase } = require('../../services/database')
        const { generateId } = require('@common/utils/id')
        const db = getDatabase()
        const stmt = db.prepare(
          'INSERT INTO market_quotes (id, ticker, name, category, price, change_pct, change_abs, prev_close, currency, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        const now = Date.now()
        const tx = db.transaction(() => {
          for (const quote of quotes) {
            const commodity = COMMODITIES.find((c) => c.symbol === quote.symbol)
            if (!commodity || quote.regularMarketPrice == null) continue
            stmt.run(
              generateId(), commodity.symbol, commodity.name, commodity.category,
              quote.regularMarketPrice, quote.regularMarketChangePercent || 0,
              quote.regularMarketChange || 0, quote.regularMarketPreviousClose || 0,
              quote.currency || 'USD', now
            )
          }
        })
        tx()
        log.debug(`market_quotes: inserted ${quotes.length} quotes`)
      } catch (err) {
        log.debug(`market_quotes write failed: ${err}`)
      }

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
