// modelsBridge — v1.4.3 IPC for the local-model auto-download manager.
//
// Channels:
//   models:list              → AssetStatus[]
//   models:status (id)       → AssetStatus | null
//   models:ensure_required   → kicks off ensureRequired() (idempotent)
//   models:download_one (id) → downloadOne(id), throws on failure
//   models:reinstall (id)    → wipes + re-downloads
//   models:cancel (id)       → aborts an in-flight download
//   models:locate_binary     → { whisper: string|null, ffmpeg: string|null, hints }
//
// Push event (no IPC handler needed):
//   models:status_update     → AssetStatus, broadcast on every change

import { ipcMain, BrowserWindow } from 'electron'
import log from 'electron-log'
import { spawn } from 'child_process'
import { modelDownloadManager } from '../services/models/ModelDownloadManager'
import { findBinary, installHint } from '../services/models/BinaryLocator'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* */ }
  }
}

let listenerWired = false

export function registerModelsBridge(): void {
  if (!listenerWired) {
    modelDownloadManager.on('status', (status) => {
      broadcast('models:status_update', status)
    })
    listenerWired = true
  }

  ipcMain.handle('models:list', () => modelDownloadManager.list())
  ipcMain.handle('models:status', (_e, id: string) => modelDownloadManager.status(id))
  ipcMain.handle('models:ensure_required', () => {
    modelDownloadManager.ensureRequired()
    return { ok: true }
  })
  ipcMain.handle('models:download_one', async (_e, id: string) => {
    await modelDownloadManager.downloadOne(id)
    return modelDownloadManager.status(id)
  })
  ipcMain.handle('models:reinstall', async (_e, id: string) => {
    await modelDownloadManager.reinstall(id)
    return modelDownloadManager.status(id)
  })
  ipcMain.handle('models:cancel', (_e, id: string) => {
    modelDownloadManager.cancel(id)
    return { ok: true }
  })
  // macOS-only: shell out to `brew install <formula>` after the
  // analyst has explicitly clicked the install button. Homebrew
  // doesn't require sudo so this is safe; we still gate by platform
  // and refuse anything outside the small allow-list. stdout/stderr
  // are streamed back so the UI can show a live install log.
  ipcMain.handle('models:install_via_brew', async (_e, args: { formula: 'whisper-cpp' | 'ffmpeg' }) => {
    if (process.platform !== 'darwin') {
      return { ok: false, error: 'brew install is macOS-only' }
    }
    const allowed = new Set(['whisper-cpp', 'ffmpeg'])
    if (!allowed.has(args?.formula)) {
      return { ok: false, error: `formula not allowed: ${args?.formula}` }
    }
    const brew = await findBinary(['brew'])
    if (!brew) {
      return {
        ok: false,
        error: 'Homebrew not found. Install from https://brew.sh first, then retry.'
      }
    }
    log.info(`models: brew install ${args.formula} via ${brew}`)
    return await new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
      const child = spawn(brew, ['install', args.formula], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (b: Buffer) => {
        const chunk = b.toString()
        out += chunk
        broadcast('models:status_update', { id: `brew:${args.formula}`, state: 'downloading', description: `brew install ${args.formula}`, destPath: '', bytesDone: 0, bytesTotal: null, progress: 0, rateBps: 0, error: null, installedAt: null, optional: false, requiredBy: ['transcription'], _logChunk: chunk })
      })
      child.stderr.on('data', (b: Buffer) => { out += b.toString() })
      child.on('error', (err) => resolve({ ok: false, output: out, error: err.message }))
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true, output: out })
        else resolve({ ok: false, output: out, error: `brew install exited ${code}` })
      })
    })
  })

  ipcMain.handle('models:locate_binary', async () => {
    const [whisper, ffmpeg] = await Promise.all([
      findBinary(['whisper-cli', 'whisper-cpp', 'whisper', 'main']),
      findBinary(['ffmpeg'])
    ])
    return {
      whisper,
      ffmpeg,
      hints: {
        whisper: whisper ? null : installHint('whisper'),
        ffmpeg: ffmpeg ? null : installHint('ffmpeg')
      }
    }
  })

  log.info('models bridge registered')
}
