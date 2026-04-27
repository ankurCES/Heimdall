// TranscriptionQueueService — v1.4.8 single-worker queue for bulk
// audio/video ingest.
//
// Why concurrency = 1:
//   whisper.cpp already saturates every CPU core via its OpenMP build.
//   Running two transcriptions in parallel just thrashes the cache and
//   roughly halves throughput per file. A serial queue with a single
//   active job is consistently faster end-to-end and gives much
//   cleaner progress UX ("3 of 47" instead of "all running, none done").
//
// Lifecycle:
//   - enqueue(paths)      — append paths to the tail; idempotent on already-
//                           queued paths
//   - cancel(path?)       — remove a pending path; if path is undefined
//                           and a job is running, cancel the active one
//                           too (best-effort: in-flight whisper-cli is
//                           allowed to finish since killing mid-pass
//                           leaves a half-written .json on disk)
//   - clear()             — drop every pending entry
//
// Progress signal: emits 'queue_progress' on every state change with
// the current snapshot. The bridge forwards that to all renderer
// windows via the transcription:queue_progress IPC event.

import { EventEmitter } from 'events'
import path from 'path'
import log from 'electron-log'
import { transcriptionService, type TranscriptRow } from './TranscriptionService'

export type QueueItemState = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export interface QueueItem {
  path: string
  fileName: string
  state: QueueItemState
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
  transcriptId: string | null
  error: string | null
}

export interface QueueSnapshot {
  items: QueueItem[]
  total: number
  pending: number
  running: number
  done: number
  errored: number
  cancelled: number
  // The most recently completed transcript id, useful for the UI to
  // auto-select after a folder ingest completes.
  lastTranscriptId: string | null
}

export class TranscriptionQueueService extends EventEmitter {
  private items: QueueItem[] = []
  private active: QueueItem | null = null
  private processing = false
  private lastTranscriptId: string | null = null

  /** Append paths to the queue. De-duplicates against entries that are
   *  pending or running so dropping a folder twice is safe. Returns the
   *  number of paths actually added. */
  enqueue(paths: string[]): number {
    let added = 0
    const now = Date.now()
    const liveSet = new Set(
      this.items
        .filter((i) => i.state === 'pending' || i.state === 'running')
        .map((i) => i.path)
    )
    for (const p of paths) {
      if (liveSet.has(p)) continue
      this.items.push({
        path: p,
        fileName: path.basename(p),
        state: 'pending',
        enqueuedAt: now,
        startedAt: null,
        finishedAt: null,
        transcriptId: null,
        error: null
      })
      added++
    }
    if (added > 0) {
      log.info(`transcription-queue: enqueued ${added} path(s) (queue total ${this.items.length})`)
      this.emitSnapshot()
      void this.tick()
    }
    return added
  }

  /** Cancel a specific pending path (no-op if running or already done).
   *  When called with no argument, cancels every pending item — the
   *  active job is left running so the on-disk artifacts stay
   *  consistent. */
  cancel(targetPath?: string): void {
    let mutated = false
    for (const it of this.items) {
      if (it.state !== 'pending') continue
      if (targetPath != null && it.path !== targetPath) continue
      it.state = 'cancelled'
      it.finishedAt = Date.now()
      mutated = true
    }
    if (mutated) {
      log.info(`transcription-queue: cancelled ${targetPath ? '1' : 'all pending'}`)
      this.emitSnapshot()
    }
  }

  /** Drop every entry from the queue (including done/errored history).
   *  Active job is preserved if running. */
  clear(): void {
    this.items = this.items.filter((i) => i.state === 'running')
    this.lastTranscriptId = null
    this.emitSnapshot()
  }

  snapshot(): QueueSnapshot {
    const items = this.items.slice()
    return {
      items,
      total: items.length,
      pending: items.filter((i) => i.state === 'pending').length,
      running: items.filter((i) => i.state === 'running').length,
      done: items.filter((i) => i.state === 'done').length,
      errored: items.filter((i) => i.state === 'error').length,
      cancelled: items.filter((i) => i.state === 'cancelled').length,
      lastTranscriptId: this.lastTranscriptId
    }
  }

  private async tick(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (true) {
        const next = this.items.find((i) => i.state === 'pending')
        if (!next) break
        next.state = 'running'
        next.startedAt = Date.now()
        this.active = next
        this.emitSnapshot()

        let result: TranscriptRow | null = null
        try {
          result = await transcriptionService.ingestFile(next.path, {})
          next.state = 'done'
          next.transcriptId = result?.id ?? null
          if (result?.id) this.lastTranscriptId = result.id
        } catch (err) {
          next.state = 'error'
          next.error = (err as Error).message ?? String(err)
          log.warn(`transcription-queue: ${next.fileName} failed: ${next.error}`)
        } finally {
          next.finishedAt = Date.now()
          this.active = null
          this.emitSnapshot()
        }
      }
    } finally {
      this.processing = false
    }
  }

  private emitSnapshot(): void {
    this.emit('queue_progress', this.snapshot())
  }
}

export const transcriptionQueue = new TranscriptionQueueService()
