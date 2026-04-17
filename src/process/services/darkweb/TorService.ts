import net from 'net'
import path from 'path'
import fs from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import log from 'electron-log'
import { safeFetcher } from '../../collectors/SafeFetcher'
import { settingsService } from '../settings/SettingsService'
import type { DarkWebConfig } from '@common/types/settings'

/**
 * On-demand Tor lifecycle for dark-web search.
 *
 * connect() does:
 *   1. Probe SOCKS5 host:port (default 127.0.0.1:9050). If something already
 *      answers, treat it as an EXTERNAL Tor (system-managed via brew or the
 *      Tor Browser bundle) and just wire SafeFetcher to it. We never start
 *      or stop external instances — we only borrow them.
 *   2. Otherwise look for a `tor` binary on PATH and spawn it as a managed
 *      subprocess writing to <userData>/tor with a minimal torrc. We watch
 *      stdout for "Bootstrapped 100%" (or any "Bootstrapped <X>") to know
 *      when it's safe to use.
 *   3. If no binary is available, return an error pointing the analyst at
 *      `brew install tor` (macOS) / `apt install tor` (Linux).
 *
 * disconnect() unbinds SafeFetcher and (if we spawned tor) kills the child.
 */

export type TorStatus = 'stopped' | 'probing' | 'starting' | 'connected_external' | 'connected_managed' | 'error'

export interface TorState {
  status: TorStatus
  socksHost: string
  socksPort: number
  managed: boolean
  bootstrapPercent: number | null
  lastError: string | null
  binaryPath: string | null
}

class TorServiceImpl {
  private state: TorState = {
    status: 'stopped',
    socksHost: '127.0.0.1',
    socksPort: 9050,
    managed: false,
    bootstrapPercent: null,
    lastError: null,
    binaryPath: null
  }
  private child: ChildProcess | null = null

  /** Public read-only view of the current state. */
  getState(): TorState {
    return { ...this.state }
  }

  /** Probe a TCP port to see if anything answers within `timeoutMs`. */
  private async probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket()
      const done = (ok: boolean) => { try { sock.destroy() } catch {} ; resolve(ok) }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
      sock.connect(port, host)
    })
  }

  /** Find `tor` on PATH or in common Homebrew locations. */
  private findTorBinary(): string | null {
    const candidates = [
      '/opt/homebrew/bin/tor',          // Apple Silicon Homebrew
      '/usr/local/bin/tor',              // Intel Homebrew / Linux
      '/usr/bin/tor',                    // Linux distros
      '/usr/local/sbin/tor'
    ]
    for (const p of candidates) {
      try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
    }
    return null
  }

  /**
   * Start (or attach to) Tor and bind SafeFetcher to its SOCKS5 port.
   *
   *   - If something already listens on the configured port → external mode
   *   - If `tor` is available on disk → spawn managed subprocess
   *   - Otherwise return an actionable error
   */
  async connect(): Promise<{ ok: boolean; mode?: 'external' | 'managed'; error?: string }> {
    // Always read host/port from current settings so the user can change them
    // without restarting the app.
    const cfg = settingsService.get<DarkWebConfig>('darkWeb')
    const host = cfg?.socks5Host || '127.0.0.1'
    const port = cfg?.socks5Port || 9050
    this.state.socksHost = host
    this.state.socksPort = port
    this.state.lastError = null
    this.state.status = 'probing'

    // 1. External-Tor probe.
    const alreadyUp = await this.probe(host, port, 1500)
    if (alreadyUp) {
      safeFetcher.setSocks5(host, port)
      this.state.managed = false
      this.state.bootstrapPercent = 100
      this.state.status = 'connected_external'
      log.info(`TorService: attached to existing Tor at ${host}:${port}`)
      return { ok: true, mode: 'external' }
    }

    // 2. Managed-Tor spawn.
    const bin = this.findTorBinary()
    this.state.binaryPath = bin
    if (!bin) {
      this.state.status = 'error'
      this.state.lastError = 'No `tor` binary found. Install Tor (macOS: brew install tor — Linux: apt install tor) or start the Tor Browser bundle and click Connect again.'
      return { ok: false, error: this.state.lastError }
    }

    this.state.status = 'starting'
    this.state.bootstrapPercent = 0
    const dataDir = path.join(app.getPath('userData'), 'tor')
    try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }) } catch { /* exists */ }

    const args = [
      '--SocksPort', String(port),
      '--DataDirectory', dataDir,
      '--Log', 'notice stdout',
      '--ClientOnly', '1',
      '--AvoidDiskWrites', '1',
      '--DisableNetwork', '0'
    ]
    log.info(`TorService: spawning ${bin} ${args.join(' ')}`)

    return new Promise((resolve) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = proc
      let resolved = false
      const finish = (result: { ok: boolean; mode?: 'external' | 'managed'; error?: string }) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      // Hard timeout: if we don't see Bootstrapped 100% in 90s, fail.
      const timer = setTimeout(() => {
        if (this.state.bootstrapPercent !== 100) {
          this.state.status = 'error'
          this.state.lastError = `Tor bootstrap timed out at ${this.state.bootstrapPercent ?? 0}% after 90s`
          try { proc.kill() } catch {}
          this.child = null
          finish({ ok: false, error: this.state.lastError })
        }
      }, 90_000)

      const onLine = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          // Match "Bootstrapped 50%" or "Bootstrapped 50% (conn_done):"
          const m = line.match(/Bootstrapped\s+(\d+)\s*%/)
          if (m) {
            const pct = parseInt(m[1], 10)
            this.state.bootstrapPercent = pct
            if (pct === 100) {
              safeFetcher.setSocks5(host, port)
              this.state.managed = true
              this.state.status = 'connected_managed'
              clearTimeout(timer)
              log.info(`TorService: managed Tor bootstrapped 100% on ${host}:${port}`)
              finish({ ok: true, mode: 'managed' })
            }
          }
          // Capture last meaningful warning for diagnostics.
          if (/\[(warn|err)\]/i.test(line)) {
            this.state.lastError = line.trim().slice(0, 240)
          }
        }
      }
      proc.stdout?.on('data', onLine)
      proc.stderr?.on('data', onLine)

      proc.once('error', (err) => {
        clearTimeout(timer)
        this.state.status = 'error'
        this.state.lastError = `Failed to spawn tor: ${err.message}`
        this.child = null
        finish({ ok: false, error: this.state.lastError })
      })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        this.child = null
        if (this.state.status !== 'connected_managed') {
          this.state.status = 'error'
          this.state.lastError = (this.state.lastError || '') + ` (tor exited with code ${code})`
          finish({ ok: false, error: this.state.lastError })
        } else {
          // External lifecycle stop or crash — mark as stopped.
          this.state.status = 'stopped'
          this.state.bootstrapPercent = null
          safeFetcher.setSocks5(null)
          log.warn(`TorService: managed tor exited unexpectedly (code ${code})`)
        }
      })
    })
  }

  /** Unbind SafeFetcher and kill the child if we own one. */
  async disconnect(): Promise<{ ok: boolean }> {
    safeFetcher.setSocks5(null)
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch {}
      // Wait briefly for graceful exit, then SIGKILL
      await new Promise((r) => setTimeout(r, 1500))
      if (this.child && !this.child.killed) {
        try { this.child.kill('SIGKILL') } catch {}
      }
      this.child = null
    }
    this.state.status = 'stopped'
    this.state.managed = false
    this.state.bootstrapPercent = null
    return { ok: true }
  }

  /** Quick health check — does the bound SOCKS5 port still answer? */
  async healthCheck(): Promise<boolean> {
    if (this.state.status !== 'connected_external' && this.state.status !== 'connected_managed') return false
    return this.probe(this.state.socksHost, this.state.socksPort, 1000)
  }
}

export const torService = new TorServiceImpl()
