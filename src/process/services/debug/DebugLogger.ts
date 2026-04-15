import { app } from 'electron'
import log from 'electron-log'

// Dev-mode only debug logger — emits structured logs to verify data flow
// Production builds skip these entirely (zero overhead).
const IS_DEV = !app.isPackaged

export function debugLog(category: string, message: string, data?: unknown): void {
  if (!IS_DEV) return
  if (data !== undefined) {
    let summary: string
    try {
      summary = typeof data === 'string' ? data : JSON.stringify(data)
    } catch {
      summary = String(data)
    }
    log.info(`[DEBUG/${category}] ${message} ${summary.length > 300 ? summary.slice(0, 300) + '…' : summary}`)
  } else {
    log.info(`[DEBUG/${category}] ${message}`)
  }
}

// Specialized helpers
export function debugCollector(sourceName: string, message: string, data?: unknown): void {
  debugLog(`COLLECTOR/${sourceName}`, message, data)
}

export function debugFetch(url: string, status: number, sizeBytes?: number): void {
  if (!IS_DEV) return
  const sizeStr = sizeBytes ? ` (${(sizeBytes / 1024).toFixed(1)}KB)` : ''
  log.info(`[DEBUG/FETCH] ${status} ${url}${sizeStr}`)
}

export function debugStore(sourceName: string, collected: number, stored: number, dupes: number): void {
  if (!IS_DEV) return
  const ratio = collected > 0 ? Math.round((stored / collected) * 100) : 0
  log.info(`[DEBUG/STORE] ${sourceName}: collected=${collected} stored=${stored} dupes=${dupes} (${ratio}% new)`)
}

export function isDevMode(): boolean {
  return IS_DEV
}
