import { BrowserWindow } from 'electron'

/**
 * Cached BrowserWindow.getAllWindows() with 2-second TTL.
 * Avoids repeated enumeration in hot emit loops across services.
 */
let cachedWindows: BrowserWindow[] = []
let cacheTime = 0
const CACHE_TTL = 2000

export function getWindows(): BrowserWindow[] {
  const now = Date.now()
  if (now - cacheTime > CACHE_TTL) {
    cachedWindows = BrowserWindow.getAllWindows()
    cacheTime = now
  }
  return cachedWindows
}

export function emitToAll(channel: string, ...args: unknown[]): void {
  for (const win of getWindows()) {
    try {
      win.webContents.send(channel, ...args)
    } catch {}
  }
}

export function invalidateWindowCache(): void {
  cachedWindows = []
  cacheTime = 0
}
