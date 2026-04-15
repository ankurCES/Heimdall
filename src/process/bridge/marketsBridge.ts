import { ipcMain } from 'electron'
import { getDatabase } from '../services/database'
import { marketBackfillService } from '../services/markets/MarketBackfillService'
import log from 'electron-log'

interface MarketQuote {
  ticker: string
  name: string
  category: string
  price: number
  change_pct: number
  change_abs: number | null
  prev_close: number | null
  currency: string | null
  recorded_at: number
}

export function registerMarketsBridge(): void {
  // Latest quote for each ticker
  ipcMain.handle('markets:getLatestQuotes', () => {
    const db = getDatabase()
    try {
      const rows = db.prepare(`
        SELECT q.ticker, q.name, q.category, q.price, q.change_pct, q.change_abs,
               q.prev_close, q.currency, q.recorded_at
        FROM market_quotes q
        INNER JOIN (
          SELECT ticker, MAX(recorded_at) AS max_recorded
          FROM market_quotes
          GROUP BY ticker
        ) latest ON q.ticker = latest.ticker AND q.recorded_at = latest.max_recorded
        ORDER BY q.category, q.name
      `).all() as MarketQuote[]
      return rows
    } catch (err) {
      log.warn(`markets:getLatestQuotes failed: ${err}`)
      return []
    }
  })

  // Historical time-series for one or more tickers
  ipcMain.handle('markets:getHistory', (_event, params: { tickers: string[]; rangeHours?: number }) => {
    const db = getDatabase()
    try {
      const range = params.rangeHours || 168 // default 7 days
      const since = Date.now() - range * 60 * 60 * 1000
      const tickers = params.tickers || []
      if (tickers.length === 0) return {}

      const placeholders = tickers.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT ticker, price, change_pct, recorded_at
        FROM market_quotes
        WHERE ticker IN (${placeholders}) AND recorded_at >= ?
        ORDER BY recorded_at ASC
      `).all(...tickers, since) as Array<{ ticker: string; price: number; change_pct: number; recorded_at: number }>

      // Group by ticker
      const grouped: Record<string, Array<{ t: number; price: number; pct: number }>> = {}
      for (const r of rows) {
        if (!grouped[r.ticker]) grouped[r.ticker] = []
        grouped[r.ticker].push({ t: r.recorded_at, price: r.price, pct: r.change_pct })
      }
      return grouped
    } catch (err) {
      log.warn(`markets:getHistory failed: ${err}`)
      return {}
    }
  })

  // Top-level KPIs
  ipcMain.handle('markets:getKpis', () => {
    const db = getDatabase()
    try {
      const KEY_TICKERS = ['^VIX', 'DX-Y.NYB', 'GC=F', 'CL=F']
      const placeholders = KEY_TICKERS.map(() => '?').join(',')
      const kpiQuotes = db.prepare(`
        SELECT q.ticker, q.name, q.category, q.price, q.change_pct, q.change_abs, q.recorded_at
        FROM market_quotes q
        INNER JOIN (
          SELECT ticker, MAX(recorded_at) AS max_recorded
          FROM market_quotes
          WHERE ticker IN (${placeholders})
          GROUP BY ticker
        ) latest ON q.ticker = latest.ticker AND q.recorded_at = latest.max_recorded
      `).all(...KEY_TICKERS) as MarketQuote[]

      // Top mover from latest quotes
      const allLatest = db.prepare(`
        SELECT q.ticker, q.name, q.category, q.change_pct, q.price
        FROM market_quotes q
        INNER JOIN (
          SELECT ticker, MAX(recorded_at) AS max_recorded
          FROM market_quotes
          GROUP BY ticker
        ) latest ON q.ticker = latest.ticker AND q.recorded_at = latest.max_recorded
      `).all() as Array<{ ticker: string; name: string; category: string; change_pct: number; price: number }>

      const topMover = allLatest.length > 0
        ? allLatest.reduce((max, q) => Math.abs(q.change_pct) > Math.abs(max.change_pct) ? q : max)
        : null

      // Sanctions count in last 24h
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000
      const sanctionsCount = (db.prepare(`
        SELECT COUNT(*) AS c FROM intel_reports
        WHERE source_name IN ('OFAC', 'UN Security Council Sanctions') AND created_at >= ?
      `).get(dayAgo) as { c: number }).c

      return { kpiQuotes, topMover, sanctionsCount }
    } catch (err) {
      log.warn(`markets:getKpis failed: ${err}`)
      return { kpiQuotes: [], topMover: null, sanctionsCount: 0 }
    }
  })

  // Geopolitical context — recent SEC filings + sanctions + Polymarket predictions
  ipcMain.handle('markets:getMarketIntel', () => {
    const db = getDatabase()
    try {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

      const secFilings = db.prepare(`
        SELECT id, title, content, source_url, created_at
        FROM intel_reports
        WHERE source_name = 'SEC EDGAR' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10
      `).all(weekAgo) as Array<Record<string, unknown>>

      const sanctions = db.prepare(`
        SELECT id, title, content, severity, source_name, source_url, created_at
        FROM intel_reports
        WHERE source_name IN ('OFAC', 'UN Security Council Sanctions') AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10
      `).all(weekAgo) as Array<Record<string, unknown>>

      const predictions = db.prepare(`
        SELECT id, title, content, severity, source_url, created_at
        FROM intel_reports
        WHERE source_name = 'Polymarket' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 10
      `).all(weekAgo) as Array<Record<string, unknown>>

      return { secFilings, sanctions, predictions }
    } catch (err) {
      log.warn(`markets:getMarketIntel failed: ${err}`)
      return { secFilings: [], sanctions: [], predictions: [] }
    }
  })

  // Detail for a single ticker (30d history + related news)
  ipcMain.handle('markets:getCommodityDetail', (_event, params: { ticker: string; name: string }) => {
    const db = getDatabase()
    try {
      const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

      const history = db.prepare(`
        SELECT price, change_pct, recorded_at
        FROM market_quotes
        WHERE ticker = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC
      `).all(params.ticker, monthAgo) as Array<{ price: number; change_pct: number; recorded_at: number }>

      // Significant moves > 2%
      const significantMoves = history.filter((h) => Math.abs(h.change_pct) > 2)

      // Related intel — search reports mentioning the commodity name
      const namePattern = `%${params.name}%`
      const relatedIntel = db.prepare(`
        SELECT id, title, source_name, severity, created_at
        FROM intel_reports
        WHERE (title LIKE ? OR content LIKE ?) AND created_at >= ?
        ORDER BY created_at DESC LIMIT 15
      `).all(namePattern, namePattern, monthAgo) as Array<Record<string, unknown>>

      return { history, significantMoves, relatedIntel }
    } catch (err) {
      log.warn(`markets:getCommodityDetail failed: ${err}`)
      return { history: [], significantMoves: [], relatedIntel: [] }
    }
  })

  // Backfill 5 years of historical data for all configured tickers
  ipcMain.handle('markets:backfillHistory', async (_event, params?: { years?: number }) => {
    const years = params?.years || 5
    log.info(`markets:backfillHistory triggered (${years}y)`)
    if (marketBackfillService.isRunning()) {
      return { running: true, message: 'Backfill already in progress' }
    }
    // Fire-and-forget — UI listens to markets:backfillProgress events
    marketBackfillService.backfillAll(years)
      .then((r) => log.info(`Backfill complete: ${r.totalRows} rows from ${r.sources} sources (${r.failures} failed)`))
      .catch((err) => log.error(`Backfill error: ${err}`))
    return { running: true, message: `Started ${years}y backfill — listen to markets:backfillProgress events` }
  })

  ipcMain.handle('markets:backfillStatus', () => {
    return { running: marketBackfillService.isRunning() }
  })

  log.info('Markets bridge registered')
}
