// transcriptionBridge — v1.4.2 IPC for audio/video transcription.
//
// Mirrors the imageBridge layout: ingest_file, ingest_pick, list, get,
// delete, plus a test_engine probe for the Settings UI.

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import path from 'path'
import { mkdir, writeFile, readdir, stat } from 'fs/promises'
import log from 'electron-log'
import { transcriptionService } from '../services/transcription/TranscriptionService'
import { transcriptionQueue } from '../services/transcription/TranscriptionQueueService'
import { exportTranscript, type ExportFormat, type ExportView } from '../services/transcription/TranscriptionExporter'

// File extensions the queue is willing to ingest. Mirrors the picker
// filter so a recursive folder walk can't accidentally feed an
// unsupported PDF/zip/etc. to whisper.cpp.
const SUPPORTED_EXTS = new Set([
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.webm',
  '.mp4', '.mkv', '.mov', '.avi', '.m4v', '.mpeg', '.mpg'
])

/** Recursively collect supported audio/video files from a directory.
 *  Skips hidden files and node_modules / .git / __MACOSX dot-dirs. */
async function walkForMedia(root: string, depthLimit = 8): Promise<string[]> {
  const out: string[] = []
  const skip = new Set(['node_modules', '.git', '__MACOSX', '.DS_Store'])
  async function recurse(dir: string, depth: number): Promise<void> {
    if (depth > depthLimit) return
    let entries: string[] = []
    try { entries = await readdir(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.') && name !== '.') continue
      if (skip.has(name)) continue
      const full = path.join(dir, name)
      let st
      try { st = await stat(full) } catch { continue }
      if (st.isDirectory()) {
        await recurse(full, depth + 1)
      } else if (st.isFile()) {
        const ext = path.extname(name).toLowerCase()
        if (SUPPORTED_EXTS.has(ext)) out.push(full)
      }
    }
  }
  await recurse(root, 0)
  return out
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send(channel, payload) } catch { /* */ }
  }
}

let queueListenerWired = false

function validatePath(p: string): string {
  const resolved = path.resolve(p)
  const home = app.getPath('home')
  if (!resolved.startsWith(home)) {
    throw new Error(`Path traversal blocked: ${resolved} is outside ${home}`)
  }
  return resolved
}

export function registerTranscriptionBridge(): void {
  if (!queueListenerWired) {
    transcriptionQueue.on('queue_progress', (snapshot) => {
      broadcast('transcription:queue_progress', snapshot)
    })
    // v1.4.10 — forward per-chunk progress to all renderer windows so
    // long-running file ingests show "transcribing 3 of 12 chunks" in
    // the queue strip without needing to poll.
    transcriptionService.on('chunk_progress', (event) => {
      broadcast('transcription:chunk_progress', event)
    })
    queueListenerWired = true
  }

  ipcMain.handle('transcription:ingest_file', async (_evt, args: { path: string; report_id?: string | null; language?: string }) => {
    return await transcriptionService.ingestFile(validatePath(args.path), {
      reportId: args.report_id ?? null,
      language: args.language
    })
  })

  ipcMain.handle('transcription:ingest_pick', async (_evt, args?: { language?: string }) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select audio/video file(s) to transcribe',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac'] },
        { name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return []
    const out = []
    for (const p of res.filePaths) {
      try {
        out.push(await transcriptionService.ingestFile(p, { language: args?.language }))
      } catch (err) {
        log.warn(`transcription:ingest_pick skipping ${p}: ${(err as Error).message}`)
      }
    }
    return out
  })

  ipcMain.handle('transcription:list', (_evt, args?: { limit?: number }) =>
    transcriptionService.list(args?.limit ?? 100)
  )

  ipcMain.handle('transcription:get', (_evt, id: string) => transcriptionService.get(id))

  ipcMain.handle('transcription:delete', (_evt, id: string) => {
    transcriptionService.remove(id)
    return { ok: true }
  })

  ipcMain.handle('transcription:test_engine', () => transcriptionService.testEngine())

  // v1.4.6 — translate a non-English transcript to English in-place
  // (translated_text column). Returns the updated row, or null when no
  // translation was needed (already English / too short / unchanged).
  ipcMain.handle('transcription:translate', (_evt, id: string) =>
    transcriptionService.translate(id)
  )

  // v1.4.8 — bulk ingest. Pick a folder, walk it recursively, queue
  // every supported audio/video file. Whisper.cpp already saturates
  // every CPU core, so the queue runs serially (concurrency=1) for
  // best end-to-end throughput and clean "X of Y" progress UX.
  ipcMain.handle('transcription:ingest_pick_folder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select a folder to bulk-transcribe',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, queued: 0, scanned: 0, root: null }
    const root = res.filePaths[0]
    const found = await walkForMedia(root)
    const queued = transcriptionQueue.enqueue(found)
    log.info(`transcription: bulk ingest from ${root} — found ${found.length}, queued ${queued}`)
    return { ok: true, queued, scanned: found.length, root }
  })

  // Direct enqueue from a list of paths (drag-drop of multiple files
  // from the renderer hits this; ingest_file is the single-file path).
  ipcMain.handle('transcription:enqueue_paths', (_evt, args: { paths: string[] }) => {
    const paths = (args?.paths ?? []).filter((p) => SUPPORTED_EXTS.has(path.extname(p).toLowerCase()))
    return { ok: true, queued: transcriptionQueue.enqueue(paths) }
  })

  ipcMain.handle('transcription:queue_status', () => transcriptionQueue.snapshot())

  ipcMain.handle('transcription:queue_cancel', (_evt, args?: { path?: string }) => {
    transcriptionQueue.cancel(args?.path)
    return { ok: true }
  })

  ipcMain.handle('transcription:queue_clear', () => {
    transcriptionQueue.clear()
    return { ok: true }
  })

  // v1.4.13 — irreversibly rewrite full_text + segments_json with PII
  // tokens. Compliance use case ("we no longer want the unredacted
  // material on disk"). Audit-logged.
  ipcMain.handle('transcription:permanently_redact', async (_evt, id: string) => {
    return await transcriptionService.permanentlyRedact(id)
  })

  // v1.4.9 — export a transcript as SRT / VTT / JSON / plain text.
  // The renderer asks for `view: 'original' | 'translation'` and a
  // format; the exporter produces both the body and a suggested
  // filename. We open a save dialog seeded with that filename and
  // write the file to whatever the analyst picks (or just return the
  // body to the renderer when no save path is wanted).
  ipcMain.handle('transcription:export', async (_evt, args: {
    id: string
    format: ExportFormat
    view?: ExportView
    save?: boolean   // when true, opens a Save dialog and writes to disk
    mask?: boolean   // v1.4.13 — apply pii_findings to mask spans before export
  }) => {
    const row = transcriptionService.get(args.id)
    if (!row) throw new Error(`Transcript not found: ${args.id}`)

    const result = exportTranscript(row, args.format, args.view ?? 'original', { mask: !!args.mask })

    if (args.save !== false) {
      const win = BrowserWindow.getFocusedWindow()
      const dialogResult = await dialog.showSaveDialog(win ?? undefined!, {
        title: `Export transcript as ${args.format.toUpperCase()}`,
        defaultPath: result.filename,
        filters: [{ name: args.format.toUpperCase(), extensions: [args.format] }]
      })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { ok: false, cancelled: true, body: result.body, filename: result.filename, mime: result.mime }
      }
      await writeFile(dialogResult.filePath, result.body, 'utf-8')
      log.info(`transcription: exported ${args.id} as ${args.format} → ${dialogResult.filePath} (${result.body.length} chars)`)
      return { ok: true, path: dialogResult.filePath, filename: result.filename, mime: result.mime, bytes: result.body.length }
    }

    // body-only mode: renderer wants the string for clipboard / preview
    return { ok: true, body: result.body, filename: result.filename, mime: result.mime }
  })

  // v1.4.7 — receive an ArrayBuffer from the renderer's MediaRecorder,
  // write it to <userData>/recordings/, then immediately ingest the
  // resulting file through the normal transcription pipeline.
  // Filenames are server-stamped to avoid renderer-controlled paths.
  ipcMain.handle('transcription:save_blob', async (_evt, args: {
    buffer: ArrayBuffer | Uint8Array
    extension: string                // 'webm' | 'wav' | 'mp4' | 'm4a' …
    language?: string
  }) => {
    if (!args?.buffer) throw new Error('buffer is required')
    // Allow-list extension to prevent accidental .exe / .sh writes
    const ext = String(args.extension || 'webm').toLowerCase().replace(/[^a-z0-9]/g, '')
    const allowed = new Set(['webm', 'wav', 'mp3', 'm4a', 'ogg', 'opus', 'aac', 'mp4', 'mov', 'mkv'])
    if (!allowed.has(ext)) throw new Error(`Disallowed extension: ${ext}`)

    const dir = path.join(app.getPath('userData'), 'recordings')
    await mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `recording-${ts}.${ext}`
    const filePath = path.join(dir, fileName)

    // Normalize to a Node Buffer for fs.writeFile
    const buf = args.buffer instanceof Uint8Array
      ? Buffer.from(args.buffer)
      : Buffer.from(new Uint8Array(args.buffer))
    await writeFile(filePath, buf)
    log.info(`transcription: saved mic recording → ${filePath} (${buf.length} bytes)`)

    return await transcriptionService.ingestFile(filePath, { language: args.language })
  })

  log.info('transcription bridge registered')
}
