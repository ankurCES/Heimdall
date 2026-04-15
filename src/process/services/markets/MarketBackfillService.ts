import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { generateId } from '@common/utils/id'
import { emitToAll } from '../resource/WindowCache'
import log from 'electron-log'

// Backfill 5 years of historical market data
// Sources:
// - Commodities: Yahoo Finance v8/chart (free, no auth)
// - Alpaca Stocks: /v2/stocks/bars (auth via apikeys.alpaca_*)
// - Alpaca Crypto: /v1beta3/crypto/us/bars (auth via apikeys.alpaca_*)
// - MFAPI Funds: /mf/{code} returns full NAV history (no auth)
//
// Idempotency: skips inserting bars older than the oldest existing
// quote for that ticker (so re-running is cheap).

interface ProgressEvent {
  source: string
  ticker: string
  status: 'started' | 'done' | 'error' | 'skipped'
  rows?: number
  error?: string
  totalProgress?: { done: number; total: number }
}

const COMMODITIES = [
  { symbol: 'CL=F', name: 'WTI Crude Oil', category: 'Energy' },
  { symbol: 'BZ=F', name: 'Brent Crude Oil', category: 'Energy' },
  { symbol: 'NG=F', name: 'Natural Gas', category: 'Energy' },
  { symbol: 'RB=F', name: 'Gasoline (RBOB)', category: 'Energy' },
  { symbol: 'GC=F', name: 'Gold', category: 'Metals' },
  { symbol: 'SI=F', name: 'Silver', category: 'Metals' },
  { symbol: 'HG=F', name: 'Copper', category: 'Metals' },
  { symbol: 'PL=F', name: 'Platinum', category: 'Metals' },
  { symbol: 'ZW=F', name: 'Wheat', category: 'Agriculture' },
  { symbol: 'ZC=F', name: 'Corn', category: 'Agriculture' },
  { symbol: 'ZS=F', name: 'Soybeans', category: 'Agriculture' },
  { symbol: 'KC=F', name: 'Coffee', category: 'Agriculture' },
  { symbol: 'DX-Y.NYB', name: 'US Dollar Index', category: 'Currency' },
  { symbol: '^VIX', name: 'VIX Volatility', category: 'Volatility' }
]

class MarketBackfillService {
  private running = false

  isRunning(): boolean {
    return this.running
  }

  private emit(event: ProgressEvent): void {
    emitToAll('markets:backfillProgress', event)
  }

  async backfillAll(yearsBack: number = 5): Promise<{ totalRows: number; sources: number; failures: number }> {
    if (this.running) {
      log.warn('MarketBackfill: already running')
      return { totalRows: 0, sources: 0, failures: 0 }
    }
    this.running = true
    let totalRows = 0
    let failures = 0
    let sources = 0

    try {
      log.info(`MarketBackfill: starting ${yearsBack}-year backfill`)
      const startTs = Math.floor(Date.now() / 1000) - yearsBack * 365 * 24 * 60 * 60

      // ── Commodities (Yahoo v8/chart, no auth) ──────────────────
      for (const c of COMMODITIES) {
        sources++
        try {
          this.emit({ source: 'commodity', ticker: c.symbol, status: 'started' })
          const rows = await this.backfillYahoo(c.symbol, c.name, c.category, yearsBack)
          totalRows += rows
          this.emit({ source: 'commodity', ticker: c.symbol, status: 'done', rows })
          log.info(`Backfill: ${c.symbol} (${c.name}) — ${rows} bars`)
        } catch (err) {
          failures++
          this.emit({ source: 'commodity', ticker: c.symbol, status: 'error', error: String(err) })
          log.warn(`Backfill ${c.symbol} failed: ${err}`)
        }
        // small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 200))
      }

      // ── MFAPI funds (full NAV history is one API call) ──────────
      const mfFunds = this.getStoredMfFunds()
      for (const fund of mfFunds) {
        sources++
        try {
          this.emit({ source: 'mfapi', ticker: `MF-${fund.code}`, status: 'started' })
          const rows = await this.backfillMfapi(fund.code, fund.alias)
          totalRows += rows
          this.emit({ source: 'mfapi', ticker: `MF-${fund.code}`, status: 'done', rows })
          log.info(`Backfill: ${fund.alias} (MF-${fund.code}) — ${rows} bars`)
        } catch (err) {
          failures++
          this.emit({ source: 'mfapi', ticker: `MF-${fund.code}`, status: 'error', error: String(err) })
          log.warn(`Backfill MF-${fund.code} failed: ${err}`)
        }
        await new Promise((r) => setTimeout(r, 200))
      }

      // ── Alpaca stocks (auth required) ──────────────────────────
      const keyId = settingsService.get<string>('apikeys.alpaca_key_id')
      const secret = settingsService.get<string>('apikeys.alpaca_secret')
      if (keyId && secret) {
        const stockSymbols = this.getStoredAlpacaSymbols('alpaca-stock')
        for (const sym of stockSymbols) {
          sources++
          try {
            this.emit({ source: 'alpaca-stock', ticker: sym, status: 'started' })
            const rows = await this.backfillAlpacaBars(sym, sym, 'US Stocks', startTs, keyId, secret, 'stock')
            totalRows += rows
            this.emit({ source: 'alpaca-stock', ticker: sym, status: 'done', rows })
            log.info(`Backfill: ${sym} (stock) — ${rows} bars`)
          } catch (err) {
            failures++
            this.emit({ source: 'alpaca-stock', ticker: sym, status: 'error', error: String(err) })
            log.warn(`Backfill ${sym} failed: ${err}`)
          }
          await new Promise((r) => setTimeout(r, 300))
        }

        const cryptoSymbols = this.getStoredAlpacaSymbols('alpaca-crypto')
        for (const sym of cryptoSymbols) {
          sources++
          try {
            this.emit({ source: 'alpaca-crypto', ticker: sym, status: 'started' })
            const rows = await this.backfillAlpacaBars(sym, sym, 'Crypto', startTs, keyId, secret, 'crypto')
            totalRows += rows
            this.emit({ source: 'alpaca-crypto', ticker: sym, status: 'done', rows })
            log.info(`Backfill: ${sym} (crypto) — ${rows} bars`)
          } catch (err) {
            failures++
            this.emit({ source: 'alpaca-crypto', ticker: sym, status: 'error', error: String(err) })
            log.warn(`Backfill ${sym} failed: ${err}`)
          }
          await new Promise((r) => setTimeout(r, 300))
        }
      } else {
        log.info('Backfill: Alpaca keys not configured, skipping stock/crypto historical')
      }

      log.info(`MarketBackfill DONE: ${totalRows} total bars from ${sources} tickers (${failures} failures)`)
    } finally {
      this.running = false
    }

    return { totalRows, sources, failures }
  }

  private async backfillYahoo(symbol: string, name: string, category: string, years: number): Promise<number> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000)
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as {
      chart?: { result?: Array<{
        meta: { symbol: string; currency: string }
        timestamp: number[]
        indicators: { quote: Array<{ close: number[]; open: number[]; high: number[]; low: number[]; volume: number[] }> }
      }> }
    }

    const result = data.chart?.result?.[0]
    if (!result) throw new Error('No chart data')

    const timestamps = result.timestamp || []
    const closes = result.indicators?.quote?.[0]?.close || []
    const currency = result.meta?.currency || 'USD'

    return this.insertBars(symbol, name, category, currency, timestamps, closes)
  }

  private async backfillMfapi(code: number, alias?: string): Promise<number> {
    const resp = await fetch(`https://api.mfapi.in/mf/${code}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Heimdall/0.1.0' },
      signal: AbortSignal.timeout(30000)
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as {
      meta: { scheme_name: string }
      data: Array<{ date: string; nav: string }>
    }

    const ticker = `MF-${code}`
    const name = alias || data.meta.scheme_name
    // MFAPI dates are DD-MM-YYYY
    const timestamps: number[] = []
    const prices: number[] = []
    for (const d of data.data) {
      const [dd, mm, yyyy] = d.date.split('-')
      const ts = Math.floor(new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`).getTime() / 1000)
      const nav = parseFloat(d.nav)
      if (!isNaN(nav) && nav > 0) {
        timestamps.unshift(ts)  // MFAPI returns newest-first; we want oldest-first
        prices.unshift(nav)
      }
    }

    return this.insertBars(ticker, name, 'Mutual Funds (IN)', 'INR', timestamps, prices)
  }

  private async backfillAlpacaBars(symbol: string, name: string, category: string, startTs: number, keyId: string, secret: string, kind: 'stock' | 'crypto'): Promise<number> {
    const start = new Date(startTs * 1000).toISOString()
    const url = kind === 'stock'
      ? `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}&limit=10000`
      : `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}&limit=10000`

    const resp = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(30000)
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json() as { bars?: Record<string, Array<{ t: string; c: number }>> }
    const bars = data.bars?.[symbol] || []

    const timestamps: number[] = []
    const prices: number[] = []
    for (const b of bars) {
      const ts = Math.floor(new Date(b.t).getTime() / 1000)
      if (b.c && b.c > 0) {
        timestamps.push(ts)
        prices.push(b.c)
      }
    }

    return this.insertBars(symbol, name, category, 'USD', timestamps, prices)
  }

  private insertBars(ticker: string, name: string, category: string, currency: string, timestamps: number[], prices: number[]): number {
    if (timestamps.length === 0) return 0
    const db = getDatabase()

    // Find oldest existing recorded_at for this ticker — skip inserting older bars
    const oldest = db.prepare(
      'SELECT MIN(recorded_at) AS min_t FROM market_quotes WHERE ticker = ?'
    ).get(ticker) as { min_t: number | null }
    const oldestExistingMs = oldest?.min_t || Number.MAX_SAFE_INTEGER

    const stmt = db.prepare(
      'INSERT INTO market_quotes (id, ticker, name, category, price, change_pct, change_abs, prev_close, currency, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )

    let inserted = 0
    const tx = db.transaction(() => {
      for (let i = 0; i < timestamps.length; i++) {
        const recordedMs = timestamps[i] * 1000
        // Skip if this bar's date is already covered (avoids duplicates)
        if (recordedMs >= oldestExistingMs) continue

        const price = prices[i]
        const prevPrice = i > 0 ? prices[i - 1] : price
        const change = price - prevPrice
        const pct = prevPrice !== 0 ? (change / prevPrice) * 100 : 0

        try {
          stmt.run(generateId(), ticker, name, category, price, pct, change, prevPrice, currency, recordedMs)
          inserted++
        } catch {}
      }
    })
    tx()
    return inserted
  }

  // Read all unique scheme codes from MFAPI source configs in DB
  private getStoredMfFunds(): Array<{ code: number; alias?: string }> {
    try {
      const db = getDatabase()
      const rows = db.prepare("SELECT config FROM sources WHERE type = 'mfapi'").all() as Array<{ config: string }>
      const all: Array<{ code: number; alias?: string }> = []
      const seen = new Set<number>()
      for (const r of rows) {
        try {
          const cfg = JSON.parse(r.config) as { schemeCodes?: Array<{ code: number; alias?: string }> }
          for (const s of cfg.schemeCodes || []) {
            if (!seen.has(s.code)) { seen.add(s.code); all.push(s) }
          }
        } catch {}
      }
      return all
    } catch { return [] }
  }

  // Read all stock/crypto symbols from Alpaca source configs
  private getStoredAlpacaSymbols(type: 'alpaca-stock' | 'alpaca-crypto'): string[] {
    try {
      const db = getDatabase()
      const rows = db.prepare('SELECT config FROM sources WHERE type = ?').all(type) as Array<{ config: string }>
      const all = new Set<string>()
      for (const r of rows) {
        try {
          const cfg = JSON.parse(r.config) as { symbols?: string[] }
          for (const s of cfg.symbols || []) all.add(s)
        } catch {}
      }
      return Array.from(all)
    } catch { return [] }
  }
}

export const marketBackfillService = new MarketBackfillService()
