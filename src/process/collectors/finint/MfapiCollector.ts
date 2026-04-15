import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import { getDatabase } from '../../services/database'
import { generateId } from '@common/utils/id'
import log from 'electron-log'

// MFAPI.in — free, no-auth Indian Mutual Fund NAV API
// Docs: https://www.mfapi.in/docs/
//
// Example config:
// {
//   schemeCodes: [
//     { code: 118989, alias: 'HDFC Mid Cap' },
//     { code: 125497, alias: 'HDFC Top 100' }
//   ]
// }

interface MfapiResponse {
  meta: {
    fund_house: string
    scheme_type: string
    scheme_category: string
    scheme_code: number
    scheme_name: string
  }
  data: Array<{ date: string; nav: string }>
  status: string
}

interface MfapiConfig {
  schemeCodes?: Array<{ code: number; alias?: string }>
}

export class MfapiCollector extends BaseCollector {
  readonly discipline = 'finint' as const
  readonly type = 'mfapi'

  async collect(): Promise<IntelReport[]> {
    const cfg = (this.sourceConfig?.config || {}) as MfapiConfig
    const schemes = cfg.schemeCodes || []
    if (schemes.length === 0) {
      log.warn('MfapiCollector: no schemeCodes configured')
      return []
    }

    const reports: IntelReport[] = []
    const db = getDatabase()
    const insertStmt = db.prepare(
      'INSERT INTO market_quotes (id, ticker, name, category, price, change_pct, change_abs, prev_close, currency, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const now = Date.now()

    for (const scheme of schemes) {
      try {
        const resp = await fetch(`https://api.mfapi.in/mf/${scheme.code}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'Heimdall/0.1.0' },
          signal: AbortSignal.timeout(10000)
        })
        if (!resp.ok) {
          log.debug(`MFAPI ${scheme.code}: HTTP ${resp.status}`)
          continue
        }
        const data = await resp.json() as MfapiResponse
        if (!data.data || data.data.length === 0) continue

        const meta = data.meta
        const latestNav = parseFloat(data.data[0].nav)
        const prevNav = data.data.length > 1 ? parseFloat(data.data[1].nav) : latestNav
        const change = latestNav - prevNav
        const pct = prevNav !== 0 ? (change / prevNav) * 100 : 0
        const ticker = `MF-${meta.scheme_code}`
        const name = scheme.alias || meta.scheme_name

        // Dual-write to market_quotes time-series
        try {
          insertStmt.run(
            generateId(), ticker, name, 'Mutual Funds (IN)',
            latestNav, pct, change, prevNav, 'INR', now
          )
        } catch (e) {
          log.debug(`market_quotes insert failed for ${ticker}: ${e}`)
        }

        // Generate IntelReport for significant moves only (>1%)
        if (Math.abs(pct) > 1) {
          const direction = pct > 0 ? 'UP' : 'DOWN'
          const severity: ThreatLevel = Math.abs(pct) > 5 ? 'high' : Math.abs(pct) > 3 ? 'medium' : 'low'

          reports.push(this.createReport({
            title: `MF ${direction}: ${name} ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`,
            content: `**Scheme**: ${meta.scheme_name}\n**Fund House**: ${meta.fund_house}\n**Category**: ${meta.scheme_category}\n**Latest NAV**: ₹${latestNav.toFixed(4)} (${data.data[0].date})\n**Previous NAV**: ₹${prevNav.toFixed(4)} (${data.data[1]?.date || 'N/A'})\n**Change**: ${change > 0 ? '+' : ''}${change.toFixed(4)} (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)\n**Scheme Code**: ${meta.scheme_code}`,
            severity,
            sourceUrl: `https://www.mfapi.in/mf/${meta.scheme_code}`,
            sourceName: 'MFAPI Mutual Funds',
            verificationScore: 95
          }))
        } else {
          // Always create at least one summary report for the latest NAV (low severity)
          reports.push(this.createReport({
            title: `MF NAV: ${name} ₹${latestNav.toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`,
            content: `**Scheme**: ${meta.scheme_name}\n**Fund House**: ${meta.fund_house}\n**Category**: ${meta.scheme_category}\n**Latest NAV**: ₹${latestNav.toFixed(4)} (${data.data[0].date})\n**Change**: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`,
            severity: 'info',
            sourceUrl: `https://www.mfapi.in/mf/${meta.scheme_code}`,
            sourceName: 'MFAPI Mutual Funds',
            verificationScore: 95
          }))
        }
      } catch (err) {
        log.debug(`MFAPI ${scheme.code} failed: ${err}`)
      }
    }

    log.info(`MFAPI: ${reports.length} reports for ${schemes.length} schemes`)
    return reports
  }
}
