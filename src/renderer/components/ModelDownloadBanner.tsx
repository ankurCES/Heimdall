// ModelDownloadBanner — v1.4.4 corner toast that surfaces active
// background model downloads.
//
// Mounts once in Layout. Initial state comes from `models:list` so a
// page reload mid-download still shows the banner. Live updates flow
// from the `models:status_update` event that ModelDownloadManager
// broadcasts every 250 ms during a download.
//
// Auto-dismisses 4 s after every active download finishes. The
// "Hide" button suppresses it for the rest of the session even if
// new downloads start.
//
// Stays out of the way: bottom-right, fixed-positioned, ignores
// pointer events on its container so it never blocks clicks on the
// page underneath.

import { useEffect, useRef, useState } from 'react'
import { Download, X as XIcon, Check } from 'lucide-react'
import { Link } from 'react-router-dom'

interface AssetStatus {
  id: string
  description: string
  state: 'missing' | 'queued' | 'downloading' | 'verifying' | 'ready' | 'error' | 'unsupported_platform' | 'disabled'
  bytesDone: number
  bytesTotal: number | null
  progress: number
  rateBps: number
  error: string | null
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function isActive(s: AssetStatus): boolean {
  return s.state === 'downloading' || s.state === 'verifying' || s.state === 'queued'
}

export function ModelDownloadBanner() {
  const [statuses, setStatuses] = useState<Map<string, AssetStatus>>(new Map())
  const [hiddenForSession, setHiddenForSession] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const completedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sawActiveRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.heimdall.invoke('models:list') as AssetStatus[]
        if (cancelled) return
        const m = new Map<string, AssetStatus>()
        for (const s of list) m.set(s.id, s)
        setStatuses(m)
      } catch { /* */ }
    })()

    const off = window.heimdall.on('models:status_update', (...args: unknown[]) => {
      const update = args[0] as AssetStatus | undefined
      if (!update?.id) return
      // Brew install pseudo-progress: ignore in this banner (the Models tab handles the install log)
      if (update.id.startsWith('brew:')) return
      setStatuses((cur) => {
        const next = new Map(cur)
        next.set(update.id, update)
        return next
      })
    })
    return () => {
      cancelled = true
      try { off() } catch { /* */ }
      if (completedTimer.current) clearTimeout(completedTimer.current)
    }
  }, [])

  const all = Array.from(statuses.values())
  const active = all.filter(isActive)
  const errors = all.filter((s) => s.state === 'error')

  // Track when we transition from "had active downloads" to "all done"
  useEffect(() => {
    if (active.length > 0) {
      sawActiveRef.current = true
      setShowCompleted(false)
      if (completedTimer.current) {
        clearTimeout(completedTimer.current)
        completedTimer.current = null
      }
    } else if (sawActiveRef.current) {
      // Show "All ready" badge briefly, then auto-dismiss
      setShowCompleted(true)
      if (completedTimer.current) clearTimeout(completedTimer.current)
      completedTimer.current = setTimeout(() => {
        setShowCompleted(false)
        sawActiveRef.current = false
      }, 4000)
    }
  }, [active.length])

  if (hiddenForSession) return null
  if (active.length === 0 && !showCompleted && errors.length === 0) return null

  // Aggregate progress
  const totalDone = active.reduce((s, a) => s + (a.bytesDone || 0), 0)
  const totalSize = active.reduce((s, a) => s + (a.bytesTotal || 0), 0)
  const aggProgress = totalSize > 0 ? totalDone / totalSize : (active.length ? 0 : 1)
  const totalRate = active.reduce((s, a) => s + (a.rateBps || 0), 0)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 max-w-sm w-[22rem]">
      <div className="pointer-events-auto bg-card border border-border rounded-lg shadow-lg p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {active.length > 0 ? (
              <Download className="h-4 w-4 text-primary shrink-0 animate-pulse" />
            ) : (
              <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {active.length > 0
                  ? `Downloading ${active.length} model${active.length > 1 ? 's' : ''}…`
                  : errors.length > 0 && active.length === 0
                    ? `${errors.length} model download error${errors.length > 1 ? 's' : ''}`
                    : 'All models ready'}
              </div>
              {active.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  {fmtBytes(totalDone)}{totalSize > 0 ? ` / ${fmtBytes(totalSize)}` : ''}
                  {totalRate > 0 ? ` · ${fmtBytes(totalRate)}/s` : ''}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => setHiddenForSession(true)}
            className="text-muted-foreground hover:text-foreground p-0.5"
            title="Hide for this session"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {active.length > 0 && (
          <>
            <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.max(2, Math.min(100, aggProgress * 100))}%` }}
              />
            </div>
            <ul className="space-y-1 max-h-32 overflow-auto">
              {active.slice(0, 4).map((a) => (
                <li key={a.id} className="text-[11px] text-muted-foreground flex items-center justify-between gap-2">
                  <span className="truncate">{a.description}</span>
                  <span className="font-mono shrink-0">
                    {a.bytesTotal ? `${Math.round(a.progress * 100)}%` : '…'}
                  </span>
                </li>
              ))}
              {active.length > 4 && (
                <li className="text-[11px] text-muted-foreground">+ {active.length - 4} more…</li>
              )}
            </ul>
          </>
        )}

        {errors.length > 0 && active.length === 0 && (
          <ul className="space-y-1">
            {errors.slice(0, 3).map((e) => (
              <li key={e.id} className="text-[11px] text-red-600 dark:text-red-400 truncate">
                {e.description}: {e.error}
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end pt-1">
          <Link
            to="/settings"
            onClick={() => sessionStorage.setItem('settings:initialTab', 'models')}
            className="text-[11px] text-primary hover:underline"
          >
            Manage models →
          </Link>
        </div>
      </div>
    </div>
  )
}
