// transcriptionBridge — v1.4.2 IPC for audio/video transcription.
//
// Mirrors the imageBridge layout: ingest_file, ingest_pick, list, get,
// delete, plus a test_engine probe for the Settings UI.

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import path from 'path'
import { mkdir, writeFile } from 'fs/promises'
import log from 'electron-log'
import { transcriptionService } from '../services/transcription/TranscriptionService'

function validatePath(p: string): string {
  const resolved = path.resolve(p)
  const home = app.getPath('home')
  if (!resolved.startsWith(home)) {
    throw new Error(`Path traversal blocked: ${resolved} is outside ${home}`)
  }
  return resolved
}

export function registerTranscriptionBridge(): void {
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
