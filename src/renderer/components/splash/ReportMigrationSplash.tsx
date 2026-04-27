import { useEffect, useState } from 'react'
import { CheckCircle2, X } from 'lucide-react'
import heimdallLogo from '@renderer/assets/heimdall-logo.png'

/**
 * One-shot splash shown when the v1.1 report-promotion migration is
 * running. Subscribed to `reports:promotion_progress` events from the
 * main process. Auto-dismisses 1.5s after `complete` status.
 *
 * Behavior:
 *   - Mounts on app start
 *   - Polls promotion_state once on mount
 *   - If state is 'complete' or there's nothing to migrate, never shows
 *   - Otherwise overlays the entire app, branded with Heimdall logo
 *   - Shows progress bar + verbose live log of which message is being
 *     processed
 *   - Dismissable (X button) — migration continues in background
 */

interface PromotionProgress {
  status: 'pending' | 'running' | 'complete' | 'error'
  total: number
  processed: number
  promoted: number
  skipped: number
  currentTitle?: string
  lastError?: string
  startedAt?: number
  completedAt?: number
}

interface LogEntry {
  at: number
  text: string
}

const MAX_LOG_LINES = 8

export function ReportMigrationSplash() {
  const [progress, setProgress] = useState<PromotionProgress | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [autoDismissCountdown, setAutoDismissCountdown] = useState<number | null>(null)

  // Initial poll — figure out whether migration is needed at all
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await window.heimdall.invoke('reports:promotion_state') as {
          ok: boolean; state?: PromotionProgress
        }
        if (cancelled) return
        if (r.ok && r.state) {
          // Only show splash if there's actual work to do
          if (r.state.status === 'pending' || r.state.status === 'running') {
            setProgress(r.state)
          } else {
            // 'complete' or 'error' — don't show at all
            setProgress({ ...r.state, total: 0, processed: 0 } as PromotionProgress)
          }
        }
      } catch (err) {
        // If the bridge isn't ready yet (early boot), fail silently
        console.warn('promotion_state poll failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Subscribe to live progress events
  useEffect(() => {
    const handler = (p: PromotionProgress) => {
      setProgress(p)
      if (p.currentTitle) {
        setLogs((prev) => {
          const next = [...prev, { at: Date.now(), text: `Promoting: ${p.currentTitle}` }]
          return next.slice(-MAX_LOG_LINES)
        })
      }
      if (p.status === 'complete') {
        setLogs((prev) => [
          ...prev,
          { at: Date.now(), text: `✓ Migration complete — ${p.promoted} promoted, ${p.skipped} skipped` }
        ].slice(-MAX_LOG_LINES))
      }
      if (p.status === 'error' && p.lastError) {
        setLogs((prev) => [
          ...prev,
          { at: Date.now(), text: `✗ Error: ${p.lastError}` }
        ].slice(-MAX_LOG_LINES))
      }
    }
    const unsubscribe = window.heimdall.on('reports:promotion_progress', handler)
    return () => { unsubscribe() }
  }, [])

  // Auto-dismiss 1.5s after completion
  useEffect(() => {
    if (progress?.status !== 'complete') return
    setAutoDismissCountdown(15)
    const id = setInterval(() => {
      setAutoDismissCountdown((c) => {
        if (c === null) return null
        if (c <= 1) {
          setDismissed(true)
          return null
        }
        return c - 1
      })
    }, 100)
    return () => clearInterval(id)
  }, [progress?.status])

  // Decide visibility
  if (dismissed) return null
  if (!progress) return null
  // Don't show splash for already-complete state (returning user) or empty migration
  if (progress.status === 'complete' && progress.total === 0) return null
  if (progress.status === 'pending' && progress.total === 0 && !progress.startedAt) {
    // Briefly visible while migration spins up — count brief logo flash as fine
  }

  const pct = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : (progress.status === 'complete' ? 100 : 0)

  const isComplete = progress.status === 'complete'
  const isError = progress.status === 'error'

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-gradient-to-br from-[#06080d] via-[#0a0e16] to-[#06080d] backdrop-blur-md animate-in fade-in duration-300">
      {/* Subtle grid backdrop */}
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '40px 40px'
        }}
      />

      {/* Dismiss button */}
      <button
        onClick={() => setDismissed(true)}
        className="absolute top-6 right-6 p-2 rounded-md text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
        title="Continue in background"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="relative w-full max-w-2xl px-8">
        {/* Logo + title */}
        <div className="flex flex-col items-center mb-10">
          <img
            src={heimdallLogo}
            alt="Heimdall"
            className={`w-24 h-24 rounded-2xl shadow-2xl shadow-primary/30 mb-6 ${isComplete ? '' : 'animate-pulse'}`}
          />
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">Heimdall</h1>
          <p className="text-sm text-white/50 italic mb-6">Always vigilant</p>
          <div className="text-center">
            <div className="text-base text-white/90 font-medium mb-1">
              {isComplete ? 'Migration complete' : isError ? 'Migration error' : 'Upgrading to v1.1 — Living Reports'}
            </div>
            <p className="text-xs text-white/50 max-w-md leading-relaxed">
              {isComplete
                ? 'Your existing chat-generated reports have been promoted into the Reports Library. You can review them anytime.'
                : isError
                ? progress.lastError || 'An error occurred during migration.'
                : 'Promoting your existing chat-generated analyst products into the new first-class Reports Library. This is a one-time migration.'}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-6">
          <div className="flex justify-between text-xs text-white/60 mb-2 font-mono">
            <span>
              {progress.processed.toLocaleString()} / {progress.total.toLocaleString()} processed
            </span>
            <span className={isComplete ? 'text-emerald-400' : isError ? 'text-red-400' : 'text-cyan-300'}>
              {pct}%
            </span>
          </div>
          <div className="h-2 bg-white/5 rounded-full overflow-hidden border border-white/10">
            <div
              className={`h-full transition-all duration-300 ${
                isComplete ? 'bg-gradient-to-r from-emerald-500 to-emerald-400'
                : isError ? 'bg-gradient-to-r from-red-500 to-red-400'
                : 'bg-gradient-to-r from-cyan-500 to-blue-400'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-white/40 mt-2 font-mono">
            <span>✓ {progress.promoted} promoted</span>
            <span>↷ {progress.skipped} skipped</span>
          </div>
        </div>

        {/* Verbose log */}
        {logs.length > 0 && (
          <div className="border border-white/10 rounded-md bg-black/40 p-3 font-mono text-[11px] text-white/60 leading-relaxed max-h-48 overflow-hidden">
            {logs.map((log, i) => (
              <div key={i} className="truncate" style={{ opacity: Math.max(0.3, 1 - (logs.length - 1 - i) * 0.12) }}>
                <span className="text-white/30 mr-2">{new Date(log.at).toLocaleTimeString().split(' ')[0]}</span>
                {log.text}
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        {isComplete && (
          <div className="flex items-center justify-center gap-2 mt-6 text-xs text-emerald-400">
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {autoDismissCountdown !== null
                ? `Continuing in ${(autoDismissCountdown / 10).toFixed(1)}s…`
                : 'Continuing…'}
            </span>
          </div>
        )}
        {!isComplete && !isError && (
          <p className="text-center text-[10px] text-white/30 mt-6">
            You can dismiss this splash and continue working — the migration will finish in the background.
          </p>
        )}
      </div>
    </div>
  )
}
