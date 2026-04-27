// TranscriptsPage — v1.4.5 analyst-facing UI for the local-first
// audio/video transcription pipeline.
//
// Layout: master/detail.
//   Top: engine-readiness banner (red/amber/green based on
//        transcription:test_engine) + drag-drop dropzone + ingest
//        controls.
//   Left: list of transcripts (most-recent-first) with filename,
//        duration, language, engine badge, and intel-report link if
//        the transcript was promoted.
//   Right: detail view with full text + timestamped segments. Each
//        segment row shows [mm:ss.s] prefix; clicking the timestamp
//        copies a deeplink for sharing in chat / a report.
//
// All file paths are resolved client-side via the preload's
// getPathForFile helper (Electron's contextBridge'd
// webUtils.getPathForFile) so we never speculate about File.path.

import { useEffect, useMemo, useState, useRef, useCallback, type DragEvent } from 'react'
import {
  Mic, Upload, Loader2, Trash2, Clock, Languages, Cpu, FileText, Search,
  AlertCircle, CheckCircle2, RefreshCw, Link as LinkIcon, Settings as SettingsIcon,
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Languages as LanguagesIcon,
  Square, Circle, FolderOpen, X as XIcon, Download, ChevronDown
} from 'lucide-react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator
} from '@renderer/components/ui/dropdown-menu'
import { Link } from 'react-router-dom'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { cn, formatRelativeTime } from '@renderer/lib/utils'

interface TranscriptSegment {
  start: number
  end: number
  text: string
}

interface Transcript {
  id: string
  source_path: string
  source_kind: 'file' | 'url'
  file_name: string | null
  file_size: number | null
  mime_type: string | null
  sha256: string | null
  duration_ms: number | null
  language: string | null
  model: string | null
  engine: string | null
  full_text: string | null
  segments_json: string | null
  report_id: string | null
  ingested_at: number
  translated_text?: string | null
  translated_lang?: string | null
  translated_at?: number | null
  // v1.4.7 — segment-level translations (mirrors segments_json shape)
  translated_segments_json?: string | null
}

interface EngineStatus {
  ok: boolean
  engine: string | null
  message: string
}

function fmtDuration(ms: number | null): string {
  if (!ms || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(s: number): string {
  // Guard against Infinity/NaN — MediaRecorder-produced WebM files
  // arrive without a duration in the container header, so HTMLMediaElement
  // reports `audio.duration === Infinity` until the stream is fully
  // walked. Without this guard the UI rendered "Infinity:0NaN".
  if (!Number.isFinite(s) || s < 0) return '0:00.0'
  const mins = Math.floor(s / 60)
  const secs = (s - mins * 60).toFixed(1)
  return `${mins}:${secs.padStart(4, '0')}`
}

function EngineBanner({ status, onRecheck }: { status: EngineStatus | null; onRecheck: () => void }) {
  if (!status) {
    return (
      <div className="border border-border rounded-md bg-muted/30 p-3 text-sm flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Checking transcription engine…</span>
      </div>
    )
  }
  const ok = status.ok
  return (
    <div className={cn(
      'border rounded-md p-3 text-sm flex items-center gap-2 justify-between',
      ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
    )}>
      <div className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        )}
        <div>
          <div className={cn('font-medium', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
            {ok ? 'Transcription engine ready' : 'Transcription engine not configured'}
          </div>
          <div className="text-xs text-muted-foreground">
            {status.engine ? `${status.engine} · ` : ''}{status.message}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onRecheck} className="h-7">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        {!ok && (
          <Link to="/settings" onClick={() => sessionStorage.setItem('settings:initialTab', 'models')}>
            <Button size="sm" variant="outline" className="h-7">
              <SettingsIcon className="h-3.5 w-3.5 mr-1" /> Configure
            </Button>
          </Link>
        )}
      </div>
    </div>
  )
}

// RecordButton — v1.4.7 in-app mic capture. Uses the browser's
// MediaRecorder API to record opus-encoded WebM (universally supported,
// transcribes well via whisper.cpp + ffmpeg). On stop, the buffer is
// shipped to the main process, written to <userData>/recordings/, and
// fed straight into the existing transcription pipeline.
//
// MediaRecorder runs in the renderer (not the main process) so we
// inherit the browser's microphone permission prompt — no Electron
// permission API call needed.
function RecordButton({ onSaved, disabled }: { onSaved: (t: Transcript) => void; disabled: boolean }) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef<number>(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopTimers = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
  }

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
    stopTimers()
  }

  const start = async () => {
    if (recording || busy) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      })
      streamRef.current = stream

      // Pick the best supported mime; webm/opus is the de-facto baseline
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []
      startedAtRef.current = Date.now()

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onerror = (e) => {
        setError(`Recording error: ${(e as unknown as { error?: Error }).error?.message ?? 'unknown'}`)
        cleanupStream()
        setRecording(false)
      }
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        cleanupStream()
        setRecording(false)
        if (blob.size < 2000) {
          setError('Recording too short (under 2 KB) — discarded.')
          return
        }
        setBusy(true)
        try {
          const ext = (recorder.mimeType || 'audio/webm').includes('mp4') ? 'mp4'
            : (recorder.mimeType || 'audio/webm').includes('ogg') ? 'ogg'
            : 'webm'
          const buffer = await blob.arrayBuffer()
          const t = await window.heimdall.invoke('transcription:save_blob', {
            buffer, extension: ext
          }) as Transcript
          onSaved(t)
        } catch (err) {
          setError(String(err).replace(/^Error:\s*/, ''))
        } finally { setBusy(false) }
      }

      recorder.start(1000)   // emit a chunk every second so memory stays bounded
      setRecording(true)
      setElapsed(0)
      tickRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000))
      }, 250)
    } catch (err) {
      setError((err as Error).message || 'Microphone access denied')
      cleanupStream()
    }
  }

  const stop = () => {
    if (!recorderRef.current || !recording) return
    try { recorderRef.current.stop() } catch { /* */ }
  }

  const cancel = () => {
    if (!recording) return
    chunksRef.current = []
    try { recorderRef.current?.stop() } catch { /* */ }
    cleanupStream()
    setRecording(false)
  }

  // Cleanup on unmount
  useEffect(() => () => cleanupStream(), [])

  const fmtElapsed = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <div className="flex items-center gap-2">
      {!recording ? (
        <Button
          size="sm"
          variant="outline"
          onClick={start}
          disabled={disabled || busy}
          className="h-8"
          title="Record from microphone"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Circle className="h-3.5 w-3.5 mr-1 text-red-600 fill-red-600" />
          )}
          {busy ? 'Transcribing…' : 'Record'}
        </Button>
      ) : (
        <>
          <Button size="sm" variant="default" onClick={stop} className="h-8 bg-red-600 hover:bg-red-700">
            <Square className="h-3.5 w-3.5 mr-1 fill-white" /> Stop
          </Button>
          <span className="text-xs font-mono text-red-600 dark:text-red-400 flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-red-600 animate-pulse" />
            REC {fmtElapsed(elapsed)}
          </span>
          <Button size="sm" variant="ghost" onClick={cancel} className="h-7 text-muted-foreground">
            Cancel
          </Button>
        </>
      )}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> {error}
        </span>
      )}
    </div>
  )
}

function Dropzone({ onFiles, busy }: { onFiles: (paths: string[]) => void | Promise<void>; busy: boolean }) {
  const [over, setOver] = useState(false)

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types?.includes('Files')) setOver(true)
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
  }
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    if (busy) return
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files || [])) {
      const p = window.heimdall.getPathForFile(file)
      if (p) paths.push(p)
    }
    if (paths.length > 0) await onFiles(paths)
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
        over ? 'border-primary bg-primary/5' : 'border-border bg-muted/20',
        busy && 'opacity-60 pointer-events-none'
      )}
    >
      <Upload className={cn('h-7 w-7 mx-auto mb-2', over ? 'text-primary' : 'text-muted-foreground')} />
      <div className="text-sm font-medium">
        {over ? 'Release to ingest' : busy ? 'Transcribing…' : 'Drag audio or video here'}
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        Supports .mp3, .wav, .m4a, .flac, .ogg, .opus, .aac, .mp4, .mkv, .mov, .avi, .webm
      </div>
    </div>
  )
}

function TranscriptListItem({ t, selected, onSelect }: { t: Transcript; selected: boolean; onSelect: () => void }) {
  const engineColor =
    t.engine === 'whisper-cli' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    : t.engine === 'openai-cloud' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
    : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-2 rounded-md transition-colors border',
        selected ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent'
      )}
    >
      <div className="text-sm font-medium truncate">{t.file_name ?? t.id}</div>
      <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
        <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDuration(t.duration_ms)}</span>
        {t.language && <span className="flex items-center gap-1"><Languages className="h-3 w-3" /> {t.language}</span>}
        {t.engine && <span className={cn('px-1.5 py-0.5 rounded text-[10px]', engineColor)}>{t.engine}</span>}
        <span>· {formatRelativeTime(t.ingested_at)}</span>
      </div>
    </button>
  )
}

// AudioPlayer — v1.4.6 streams an ingested transcript's source audio
// via the heimdall-media:// custom protocol. Exposes a `seek(t)` ref
// callback so the segment list can scrub by clicking timestamps.
type PlayerHandle = {
  seek: (t: number) => void
  isVideo: () => boolean
}

// Pure-video container types where we want the visual preview tile.
// Everything else (audio + ambiguous containers like webm/ogg/m4a, which
// MediaRecorder produces without a video track) renders as <audio> so
// the slim custom controls sit immediately under the metadata header
// instead of hiding behind a 256-pixel black box.
const VIDEO_PREVIEW_MIMES = new Set([
  'video/mp4', 'video/quicktime', 'video/x-matroska', 'video/x-msvideo'
])

function AudioPlayer({ transcriptId, mime, fallbackDurationMs, onTimeUpdate, refHandle }: {
  transcriptId: string
  mime: string | null
  fallbackDurationMs: number | null  // whisper-computed duration (ground truth for MediaRecorder webm)
  onTimeUpdate: (t: number) => void
  refHandle: (h: PlayerHandle | null) => void
}) {
  const audioRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [time, setTime] = useState(0)
  // Seed duration with the whisper-computed value so the UI shows a
  // meaningful total even before the <audio> element resolves its own
  // metadata (which is Infinity for MediaRecorder-produced webm).
  const initialFallback = fallbackDurationMs && fallbackDurationMs > 0 ? fallbackDurationMs / 1000 : 0
  const [duration, setDuration] = useState(initialFallback)
  const [rate, setRate] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const isVideo = VIDEO_PREVIEW_MIMES.has((mime || '').toLowerCase())
  const url = `heimdall-media://transcript/${encodeURIComponent(transcriptId)}`

  useEffect(() => {
    refHandle({
      seek: (t: number) => {
        if (!audioRef.current) return
        try { audioRef.current.currentTime = Math.max(0, t) } catch { /* */ }
      },
      isVideo: () => isVideo
    })
    return () => refHandle(null)
  }, [transcriptId, isVideo, refHandle])

  const togglePlay = () => {
    if (!audioRef.current) return
    if (audioRef.current.paused) {
      void audioRef.current.play().then(() => setPlaying(true)).catch((err) => setError(err.message))
    } else {
      audioRef.current.pause()
      setPlaying(false)
    }
  }
  const skip = (delta: number) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime + delta)
  }
  const cycleRate = () => {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : rate === 2 ? 0.75 : 1
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const Tag = isVideo ? 'video' : 'audio'
  return (
    <div className="space-y-2">
      <Tag
        ref={audioRef as never}
        src={url}
        preload="metadata"
        className={isVideo ? 'w-full max-h-64 rounded bg-black' : 'hidden'}
        onTimeUpdate={(e) => {
          const t = (e.currentTarget as HTMLMediaElement).currentTime
          setTime(t)
          onTimeUpdate(t)
        }}
        onLoadedMetadata={(e) => {
          // Only adopt the element's duration when it's a real finite
          // number. Browser-recorded WebM streams report Infinity here
          // (no duration in the container header), so we keep the
          // whisper-computed fallback in that case.
          const d = (e.currentTarget as HTMLMediaElement).duration
          if (Number.isFinite(d) && d > 0) setDuration(d)
          setError(null)
        }}
        onDurationChange={(e) => {
          // Fires later once the stream is fully walked (or after a
          // seek-to-end), at which point Chromium has the real duration.
          const d = (e.currentTarget as HTMLMediaElement).duration
          if (Number.isFinite(d) && d > 0) setDuration(d)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setError('Failed to load media. Source file may have been moved or deleted.')}
      />
      <div className="flex items-center gap-2 bg-muted/30 rounded-md p-2">
        <Button size="sm" variant="ghost" onClick={() => skip(-10)} className="h-8 w-8 p-0" title="Back 10s">
          <SkipBack className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="default" onClick={togglePlay} className="h-8 w-8 p-0" title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => skip(10)} className="h-8 w-8 p-0" title="Forward 10s">
          <SkipForward className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[11px] font-mono text-muted-foreground tabular-nums">{fmtTime(time)} / {fmtTime(duration)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={(e) => {
            const v = Number(e.target.value)
            setTime(v)
            if (audioRef.current) audioRef.current.currentTime = v
          }}
          className="flex-1 h-1 accent-primary"
        />
        <button
          onClick={cycleRate}
          className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-accent"
          title="Playback speed"
        >
          {rate}×
        </button>
        <Button
          size="sm" variant="ghost"
          onClick={() => {
            if (!audioRef.current) return
            const next = !muted
            setMuted(next)
            audioRef.current.muted = next
          }}
          className="h-8 w-8 p-0"
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> {error}
        </div>
      )}
    </div>
  )
}

function TranscriptDetail({ transcript, onDelete, onRetranscribe, onTranslate, onExport, busy, translating }: {
  transcript: Transcript
  onDelete: () => void
  onRetranscribe: () => void
  onTranslate: () => void
  onExport: (format: 'srt' | 'vtt' | 'json' | 'text', view: 'original' | 'translation') => void
  busy: boolean
  translating: boolean
}) {
  const segments: TranscriptSegment[] = useMemo(() => {
    if (!transcript.segments_json) return []
    try { return JSON.parse(transcript.segments_json) as TranscriptSegment[] } catch { return [] }
  }, [transcript.segments_json])

  // v1.4.7 — segment-level translation (when available). When the LLM
  // segment pass succeeds, this is identical-length to `segments`; the
  // timestamp-jump UX works in both Original and Translation views.
  const translatedSegments: TranscriptSegment[] = useMemo(() => {
    if (!transcript.translated_segments_json) return []
    try { return JSON.parse(transcript.translated_segments_json) as TranscriptSegment[] } catch { return [] }
  }, [transcript.translated_segments_json])

  const [filter, setFilter] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const playerRef = useRef<PlayerHandle | null>(null)
  const [view, setView] = useState<'original' | 'translation'>('original')
  // v1.4.7 hotfix — analyst can swap between the timestamped per-
  // segment view (default; lets you click to scrub) and a flat
  // "Full text" prose view for quick reading or copy-paste.
  const [layout, setLayout] = useState<'segments' | 'fulltext'>('segments')
  const segmentRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // The segment array currently being rendered (and search-filtered) —
  // changes when the analyst toggles between Original and Translation.
  const activeSegments = view === 'translation' && translatedSegments.length > 0
    ? translatedSegments
    : segments

  const visible = filter
    ? activeSegments.filter((s) => s.text.toLowerCase().includes(filter.toLowerCase()))
    : activeSegments

  // Index of the currently-playing segment (last one whose start <= currentTime).
  // Computed against the active view's segment array so the highlight
  // also tracks playback in the translated view.
  const activeIdx = useMemo(() => {
    if (!activeSegments.length || currentTime <= 0) return -1
    let lo = 0, hi = activeSegments.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (activeSegments[mid].start <= currentTime) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return ans
  }, [activeSegments, currentTime])

  // Auto-scroll the active segment into view (only when playing)
  useEffect(() => {
    if (activeIdx < 0) return
    const el = segmentRefs.current.get(activeIdx)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeIdx])

  const seekTo = (t: number) => {
    if (playerRef.current) playerRef.current.seek(t)
  }

  const hasTranslation = !!transcript.translated_text
  const hasMedia = !!transcript.mime_type && (transcript.mime_type.startsWith('audio/') || transcript.mime_type.startsWith('video/'))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b border-border px-4 py-3 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{transcript.file_name ?? transcript.id}</h2>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtDuration(transcript.duration_ms)}</span>
              <span>{fmtBytes(transcript.file_size)}</span>
              {transcript.language && <span className="flex items-center gap-1"><Languages className="h-3 w-3" /> {transcript.language}</span>}
              {transcript.engine && <span className="flex items-center gap-1"><Cpu className="h-3 w-3" /> {transcript.engine}{transcript.model ? ` · ${transcript.model}` : ''}</span>}
              <span>{segments.length} segments</span>
              {hasTranslation && <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><LanguagesIcon className="h-3 w-3" /> Translated</span>}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 font-mono truncate" title={transcript.source_path}>{transcript.source_path}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!hasTranslation && transcript.language && transcript.language !== 'en' && (
              <Button size="sm" variant="outline" onClick={onTranslate} disabled={translating} className="h-8">
                {translating ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <LanguagesIcon className="h-3.5 w-3.5 mr-1" />}
                Translate to English
              </Button>
            )}
            {transcript.report_id && (
              <Link to={`/library?report=${transcript.report_id}`}>
                <Button size="sm" variant="outline" className="h-8">
                  <LinkIcon className="h-3.5 w-3.5 mr-1" /> Open report
                </Button>
              </Link>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8">
                  <Download className="h-3.5 w-3.5 mr-1" /> Export
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">
                  Exporting from {view === 'translation' ? 'Translation (English)' : `Original${transcript.language ? ` (${transcript.language})` : ''}`}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onExport('srt', view)}>
                  <FileText className="h-3.5 w-3.5 mr-2" /> SubRip (.srt)
                  <span className="ml-auto text-[10px] text-muted-foreground">subtitles</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExport('vtt', view)}>
                  <FileText className="h-3.5 w-3.5 mr-2" /> WebVTT (.vtt)
                  <span className="ml-auto text-[10px] text-muted-foreground">web</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExport('json', view)}>
                  <FileText className="h-3.5 w-3.5 mr-2" /> JSON
                  <span className="ml-auto text-[10px] text-muted-foreground">lossless</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExport('text', view)}>
                  <FileText className="h-3.5 w-3.5 mr-2" /> Plain text
                  <span className="ml-auto text-[10px] text-muted-foreground">no times</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="ghost" onClick={onRetranscribe} disabled={busy} className="h-8">
              <RefreshCw className={cn('h-3.5 w-3.5 mr-1', busy && 'animate-spin')} /> Re-transcribe
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete} className="h-8 text-red-600 dark:text-red-400 hover:bg-red-500/10">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {hasMedia && (
          <AudioPlayer
            transcriptId={transcript.id}
            mime={transcript.mime_type}
            fallbackDurationMs={transcript.duration_ms}
            onTimeUpdate={setCurrentTime}
            refHandle={(h) => { playerRef.current = h }}
          />
        )}
        {hasTranslation && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">View:</span>
            <button
              onClick={() => setView('original')}
              className={cn(
                'px-2 py-1 rounded border',
                view === 'original' ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              Original ({transcript.language || 'unknown'})
            </button>
            <button
              onClick={() => setView('translation')}
              className={cn(
                'px-2 py-1 rounded border',
                view === 'translation' ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:bg-accent'
              )}
            >
              Translation (English)
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Show:</span>
          <button
            onClick={() => setLayout('segments')}
            className={cn(
              'text-xs px-2 py-1 rounded border',
              layout === 'segments' ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:bg-accent'
            )}
          >
            Segments ({activeSegments.length})
          </button>
          <button
            onClick={() => setLayout('fulltext')}
            className={cn(
              'text-xs px-2 py-1 rounded border',
              layout === 'fulltext' ? 'bg-primary/10 border-primary text-primary' : 'border-border text-muted-foreground hover:bg-accent'
            )}
          >
            Full text
          </button>
          {layout === 'segments' && activeSegments.length > 0 && (
            <div className="relative flex-1 min-w-[10rem]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Search ${activeSegments.length} ${view === 'translation' ? 'translated ' : ''}segments…`}
                className="pl-8 h-8"
              />
            </div>
          )}
          {layout === 'fulltext' && (
            <button
              onClick={() => {
                const txt = view === 'translation' && transcript.translated_text
                  ? transcript.translated_text
                  : (transcript.full_text || '')
                navigator.clipboard?.writeText(txt)
              }}
              className="text-xs ml-auto px-2 py-1 rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Copy text
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* v1.4.7 hotfix — flat "Full text" view for quick reading. The
            translated_text is shown when the analyst is in the
            translation view; otherwise the original full_text. */}
        {layout === 'fulltext' ? (
          <pre className="text-sm whitespace-pre-wrap font-sans bg-muted/30 rounded p-4 leading-relaxed">
            {(view === 'translation' && transcript.translated_text)
              ? transcript.translated_text
              : (transcript.full_text || '(empty transcript)')}
          </pre>
        ) : view === 'translation' && hasTranslation && translatedSegments.length === 0 ? (
          // No segment-level translation (legacy v1.4.6 row, or LLM segment
          // pass failed entirely). Fall back to the flat translated text.
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">English translation (LLM-generated; verify against original):</div>
            <pre className="text-sm whitespace-pre-wrap font-sans bg-muted/30 rounded p-3">{transcript.translated_text || ''}</pre>
          </div>
        ) : activeSegments.length === 0 ? (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">No timestamped segments — showing full text:</div>
            <pre className="text-sm whitespace-pre-wrap font-sans bg-muted/30 rounded p-3">{transcript.full_text || '(empty)'}</pre>
          </div>
        ) : (
          <div className="space-y-1.5">
            {visible.length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">No segments match "{filter}"</div>
            )}
            {visible.map((s, i) => {
              // When filtered, find the original-array index so the active
              // highlight + scroll ref still align with playback time.
              const origIdx = filter ? activeSegments.indexOf(s) : i
              const isActive = origIdx === activeIdx
              return (
                <div
                  key={origIdx}
                  ref={(el) => { if (el) segmentRefs.current.set(origIdx, el); else segmentRefs.current.delete(origIdx) }}
                  className={cn(
                    'flex gap-3 py-1 px-2 rounded transition-colors',
                    isActive ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-accent/40'
                  )}
                >
                  <button
                    onClick={() => seekTo(s.start)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      navigator.clipboard?.writeText(`[${fmtTime(s.start)}] ${s.text}`)
                    }}
                    className={cn(
                      'text-[11px] font-mono shrink-0 mt-0.5 hover:text-primary cursor-pointer tabular-nums',
                      isActive ? 'text-primary font-medium' : 'text-muted-foreground'
                    )}
                    title="Click to seek · Right-click to copy"
                  >
                    {fmtTime(s.start)}
                  </button>
                  <span className="text-sm">{s.text}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// v1.4.8 — bulk ingest queue chrome. Renders nothing when the queue is
// empty; otherwise shows a compact strip with current item, X of Y
// progress, and cancel/clear controls.
interface QueueItem {
  path: string
  fileName: string
  state: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  enqueuedAt: number
  startedAt: number | null
  finishedAt: number | null
  transcriptId: string | null
  error: string | null
}
interface QueueSnapshot {
  items: QueueItem[]
  total: number
  pending: number
  running: number
  done: number
  errored: number
  cancelled: number
  lastTranscriptId: string | null
}

function QueueStrip({ snapshot, onCancelAll, onClear }: {
  snapshot: QueueSnapshot
  onCancelAll: () => void
  onClear: () => void
}) {
  const active = snapshot.items.find((i) => i.state === 'running')
  const completed = snapshot.done + snapshot.errored + snapshot.cancelled
  const totalActive = snapshot.total
  if (totalActive === 0) return null
  const allDone = snapshot.pending === 0 && snapshot.running === 0
  const progressPct = totalActive > 0 ? Math.round((completed / totalActive) * 100) : 0

  return (
    <div className={cn(
      'border rounded-md p-3 space-y-2',
      allDone ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-primary/30 bg-primary/5'
    )}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {allDone ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          ) : (
            <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {allDone
                ? `Bulk ingest finished — ${snapshot.done} done${snapshot.errored ? `, ${snapshot.errored} failed` : ''}${snapshot.cancelled ? `, ${snapshot.cancelled} cancelled` : ''}`
                : active
                  ? `Transcribing ${active.fileName}`
                  : `Queue ready — ${snapshot.pending} pending`}
            </div>
            <div className="text-xs text-muted-foreground">
              {completed} of {totalActive} ({progressPct}%)
              {snapshot.errored > 0 && <span className="text-red-600 dark:text-red-400"> · {snapshot.errored} error{snapshot.errored > 1 ? 's' : ''}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {snapshot.pending > 0 && (
            <Button size="sm" variant="ghost" onClick={onCancelAll} className="h-7">
              <XIcon className="h-3.5 w-3.5 mr-1" /> Cancel pending
            </Button>
          )}
          {allDone && (
            <Button size="sm" variant="ghost" onClick={onClear} className="h-7">
              Clear
            </Button>
          )}
        </div>
      </div>
      <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
        <div
          className={cn('h-full transition-all duration-300', allDone ? 'bg-emerald-500' : 'bg-primary')}
          style={{ width: `${Math.max(2, progressPct)}%` }}
        />
      </div>
    </div>
  )
}

export function TranscriptsPage() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [selected, setSelected] = useState<Transcript | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const lastQueueTranscriptId = useRef<string | null>(null)
  const ingestQueue = useRef<string[]>([])

  const load = useCallback(async () => {
    try {
      const rows = await window.heimdall.invoke('transcription:list', { limit: 200 }) as Transcript[]
      setTranscripts(rows)
      // Refresh selection from the latest list (in case detail row was updated)
      setSelected((cur) => cur ? rows.find((r) => r.id === cur.id) ?? null : cur)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }, [])

  const checkEngine = useCallback(async () => {
    try {
      const r = await window.heimdall.invoke('transcription:test_engine') as EngineStatus
      setEngine(r)
    } catch (err) {
      setEngine({ ok: false, engine: null, message: String(err) })
    }
  }, [])

  useEffect(() => { void load(); void checkEngine() }, [load, checkEngine])

  // v1.4.8 — bulk-ingest queue subscription. Initial fetch + push event
  // for live progress. When the queue's most-recently-finished transcript
  // changes, refresh the list so the new row appears in the left pane.
  useEffect(() => {
    void (async () => {
      try {
        const snap = await window.heimdall.invoke('transcription:queue_status') as QueueSnapshot
        setQueue(snap)
      } catch { /* */ }
    })()
    const off = window.heimdall.on('transcription:queue_progress', (...args: unknown[]) => {
      const snap = args[0] as QueueSnapshot
      setQueue(snap)
      if (snap.lastTranscriptId && snap.lastTranscriptId !== lastQueueTranscriptId.current) {
        lastQueueTranscriptId.current = snap.lastTranscriptId
        void load()
      }
    })
    return () => { try { off() } catch { /* */ } }
  }, [load])

  const bulkIngest = async () => {
    setError(null)
    try {
      const r = await window.heimdall.invoke('transcription:ingest_pick_folder') as { ok: boolean; queued: number; scanned: number; root: string | null }
      if (r.ok && r.scanned === 0) {
        setError(`No supported audio/video files found in ${r.root}.`)
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }
  const cancelQueue = async () => {
    try { await window.heimdall.invoke('transcription:queue_cancel', {}) } catch { /* */ }
  }
  const clearQueue = async () => {
    try { await window.heimdall.invoke('transcription:queue_clear') } catch { /* */ }
  }

  const ingestPaths = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true); setError(null)
    ingestQueue.current = paths
    try {
      let firstResult: Transcript | null = null
      for (const p of paths) {
        try {
          const t = await window.heimdall.invoke('transcription:ingest_file', { path: p }) as Transcript
          if (!firstResult) firstResult = t
        } catch (err) {
          setError(String(err).replace(/^Error:\s*/, ''))
        }
      }
      await load()
      if (firstResult) setSelected(firstResult)
    } finally {
      setBusy(false)
      ingestQueue.current = []
    }
  }

  const ingestPick = async () => {
    setBusy(true); setError(null)
    try {
      const rows = await window.heimdall.invoke('transcription:ingest_pick') as Transcript[]
      if (rows.length > 0) setSelected(rows[0])
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const deleteOne = async () => {
    if (!selected) return
    if (!confirm(`Delete transcript "${selected.file_name ?? selected.id}"?`)) return
    try {
      await window.heimdall.invoke('transcription:delete', selected.id)
      setSelected(null)
      await load()
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const exportTranscript = async (format: 'srt' | 'vtt' | 'json' | 'text', view: 'original' | 'translation') => {
    if (!selected) return
    setError(null)
    try {
      const r = await window.heimdall.invoke('transcription:export', {
        id: selected.id,
        format,
        view,
        save: true
      }) as { ok: boolean; cancelled?: boolean; path?: string; bytes?: number; filename?: string }
      if (r.cancelled) return
      if (r.ok && r.path) {
        // Could surface a toast; for now log is enough
        console.info(`Exported ${format} (${r.bytes} chars) → ${r.path}`)
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const translate = async () => {
    if (!selected) return
    setTranslating(true); setError(null)
    try {
      const updated = await window.heimdall.invoke('transcription:translate', selected.id) as Transcript | null
      if (updated) {
        setSelected(updated)
        await load()
      } else {
        setError('No translation needed (already English or too short).')
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setTranslating(false) }
  }

  const retranscribe = async () => {
    if (!selected) return
    const path = selected.source_path
    setBusy(true); setError(null)
    try {
      // Delete existing row so the dedup hash doesn't short-circuit
      await window.heimdall.invoke('transcription:delete', selected.id)
      const t = await window.heimdall.invoke('transcription:ingest_file', { path }) as Transcript
      await load()
      setSelected(t)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
      await load()
    } finally { setBusy(false) }
  }

  const filtered = search
    ? transcripts.filter((t) => {
        const hay = `${t.file_name ?? ''} ${t.full_text ?? ''} ${t.language ?? ''}`.toLowerCase()
        return hay.includes(search.toLowerCase())
      })
    : transcripts

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border space-y-3">
        <div className="flex items-center gap-2">
          <Mic className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Transcripts</h1>
          <Badge variant="outline" className="text-[10px] ml-2">v1.4.5</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Local-first audio &amp; video transcription. Drop a file below — Heimdall transcribes via whisper.cpp
          (or your configured cloud endpoint), persists timestamped segments, and auto-creates an intel report
          for substantial transcripts.
        </p>
        <EngineBanner status={engine} onRecheck={checkEngine} />
      </div>

      <div className="px-6 py-3 border-b border-border space-y-3">
        <Dropzone onFiles={ingestPaths} busy={busy} />
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={ingestPick} disabled={busy} className="h-8">
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
            Choose file…
          </Button>
          <Button size="sm" variant="outline" onClick={bulkIngest} disabled={busy} className="h-8">
            <FolderOpen className="h-3.5 w-3.5 mr-1" /> Ingest folder…
          </Button>
          <RecordButton
            disabled={busy}
            onSaved={async (t) => {
              await load()
              setSelected(t)
            }}
          />
          {error && <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {error}
          </span>}
        </div>
        {queue && queue.total > 0 && (
          <QueueStrip snapshot={queue} onCancelAll={cancelQueue} onClear={clearQueue} />
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 border-r border-border flex flex-col overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${transcripts.length} transcripts…`}
                className="pl-8 h-8"
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {filtered.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center px-3">
                {transcripts.length === 0 ? 'No transcripts yet. Drop a file above to start.' : `No matches for "${search}".`}
              </div>
            ) : (
              filtered.map((t) => (
                <TranscriptListItem
                  key={t.id}
                  t={t}
                  selected={selected?.id === t.id}
                  onSelect={() => setSelected(t)}
                />
              ))
            )}
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {selected ? (
            <TranscriptDetail
              key={selected.id}
              transcript={selected}
              onDelete={deleteOne}
              onRetranscribe={retranscribe}
              onTranslate={translate}
              onExport={exportTranscript}
              busy={busy}
              translating={translating}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 px-6 text-center">
              <FileText className="h-10 w-10 opacity-40" />
              <div className="text-sm">Select a transcript to view its full text and timestamped segments.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
