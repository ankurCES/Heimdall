import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { getDatabase } from '../../services/database'
import { settingsService } from '../../services/settings/SettingsService'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

// Alpaca Markets snapshot collector — supports both stocks and crypto
// API: https://data.alpaca.markets/v2/stocks/snapshots?symbols=...
//      https://data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=...
//
// Both return: { snapshots: { "AAPL": {...}, "MSFT": {...} } }
// where the symbol is the OBJECT KEY (not a field), so generic
// ApiEndpointCollector can't render the title properly.
//
// This dedicated collector also dual-writes to market_quotes for the
// Markets dashboard.

interface AlpacaConfig {
  symbols?: string[]
}

interface AlpacaSnapshot {
  latestTrade?: { p: number; t: string }
  latestQuote?: { ap: number; bp: number }
  dailyBar?: { c: number; o: number; h: number; l: number; v: number; t: string }
  prevDailyBar?: { c: number; t: string }
}

export class AlpacaStockCollector extends BaseCollector {
  readonly discipline = 'finint' as const
  readonly type = 'alpaca-stock'

  async collect(): Promise<IntelReport[]> {
    return collectAlpaca(this, 'stock')
  }
}

export class AlpacaCryptoCollector extends BaseCollector {
  readonly discipline = 'finint' as const
  readonly type = 'alpaca-crypto'

  async collect(): Promise<IntelReport[]> {
    return collectAlpaca(this, 'crypto')
  }
}

async function collectAlpaca(collector: BaseCollector, kind: 'stock' | 'crypto'): Promise<IntelReport[]> {
  const cfg = (((collector as unknown) as { sourceConfig: { config: AlpacaConfig; name: string } }).sourceConfig?.config || {}) as AlpacaConfig
  const symbols = cfg.symbols || []
  if (symbols.length === 0) {
    log.warn(`AlpacaCollector: no symbols configured`)
    return []
  }

  const keyId = settingsService.get<string>('apikeys.alpaca_key_id')
  const secret = settingsService.get<string>('apikeys.alpaca_secret')
  if (!keyId || !secret) {
    log.warn('AlpacaCollector: API keys not configured (Settings → API Keys → Markets)')
    return []
  }

  const url = kind === 'stock'
    ? `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}`
    : `https://data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(symbols.join(','))}`

  const reports: IntelReport[] = []
  let snapshots: Record<string, AlpacaSnapshot> = {}

  try {
    const resp = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(15000)
    })
    if (!resp.ok) {
      log.warn(`AlpacaCollector ${kind} HTTP ${resp.status}: ${await resp.text().catch(() => '')}`)
      return reports
    }
    const data = await resp.json() as { snapshots?: Record<string, AlpacaSnapshot>; [k: string]: unknown }
    // Stock API returns top-level symbol keys (no `snapshots` wrapper); crypto API has `snapshots`
    snapshots = (data.snapshots || data) as Record<string, AlpacaSnapshot>
  } catch (err) {
    log.warn(`AlpacaCollector ${kind} fetch failed: ${err}`)
    return reports
  }

  // Dual-write to market_quotes
  const db = getDatabase()
  const insertStmt = db.prepare(
    'INSERT INTO market_quotes (id, ticker, name, category, price, change_pct, change_abs, prev_close, currency, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const now = Date.now()
  const category = kind === 'stock' ? 'US Stocks' : 'Crypto'
  const currency = 'USD'

  for (const [symbol, snap] of Object.entries(snapshots)) {
    if (!snap || typeof snap !== 'object') continue

    const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? 0
    const prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price
    const change = price - prevClose
    const pct = prevClose !== 0 ? (change / prevClose) * 100 : 0

    if (!price || price === 0) continue

    try {
      insertStmt.run(generateId(), symbol, symbol, category, price, pct, change, prevClose, currency, now)
    } catch {}

    const direction = pct > 0 ? 'UP' : 'DOWN'
    const severity: ThreatLevel = Math.abs(pct) > 5 ? 'high' : Math.abs(pct) > 2 ? 'medium' : 'info'
    const arrow = pct > 0 ? '\u2191' : pct < 0 ? '\u2193' : '\u2192'

    reports.push(collector['createReport']({
      title: `${kind === 'crypto' ? '\u20BF' : '\u{1F4C8}'} ${symbol} ${arrow} $${price.toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%) ${direction}`,
      content: `**Symbol**: ${symbol}\n**Category**: ${category}\n**Price**: $${price.toFixed(2)} ${currency}\n**Previous Close**: $${prevClose.toFixed(2)}\n**Change**: ${change > 0 ? '+' : ''}${change.toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)${snap.dailyBar ? `\n**Today's Range**: $${snap.dailyBar.l.toFixed(2)} - $${snap.dailyBar.h.toFixed(2)}\n**Open**: $${snap.dailyBar.o.toFixed(2)}\n**Volume**: ${snap.dailyBar.v.toLocaleString()}` : ''}`,
      severity,
      sourceUrl: `https://app.alpaca.markets/market-data/${symbol}`,
      sourceName: kind === 'stock' ? 'Alpaca Stocks' : 'Alpaca Crypto',
      verificationScore: 95
    }))
  }

  log.info(`Alpaca ${kind}: ${reports.length} snapshots`)
  return reports
}
