import { Outlet, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { Menu, X } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { ErrorBoundary } from '../ErrorBoundary'
import { ClassificationBanner, type Classification, isClassification } from '../ClassificationBanner'
import { ModelDownloadBanner } from '../ModelDownloadBanner'
import { UniversalSearchOverlay } from '../UniversalSearchOverlay'
import { WhatsNewModal } from '../WhatsNewModal'

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [clearance, setClearance] = useState<Classification>('UNCLASSIFIED')
  const location = useLocation()

  // Read current user clearance once at mount and after settings change.
  // The banner reflects the user's clearance — the highest classification
  // they're allowed to view in this session — not the per-page maximum,
  // which is a future enhancement. This matches the SCIF convention of
  // marking the room with the highest cleared level present.
  useEffect(() => {
    const load = async () => {
      try {
        const value = await window.heimdall.invoke('settings:get', { key: 'security.clearance' })
        if (isClassification(value)) setClearance(value)
      } catch {}
    }
    void load()
    const id = setInterval(load, 30_000) // pick up Settings changes
    return () => clearInterval(id)
  }, [])

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      {/* Top + bottom classification banner — SCIF convention. The user's
          current clearance level is shown; raising clearance via Settings
          surfaces immediately. */}
      <ClassificationBanner level={clearance} />

      <div className="flex flex-1 overflow-hidden">
      {/* Desktop sidebar (always visible >= md) */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <Sidebar />
          </div>
        </>
      )}

      <main className="flex-1 overflow-auto flex flex-col">
        {/* Mobile top bar with hamburger */}
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50 sticky top-0 z-30">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-1.5 rounded hover:bg-accent"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <span className="text-sm font-semibold">Heimdall</span>
        </div>

        <div className="flex-1 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      </div>

      {/* Bottom banner mirrors the top — SCIF convention. */}
      <ClassificationBanner level={clearance} />

      {/* v1.4.4 — non-intrusive corner toast for background model downloads.
          Renders nothing when no downloads are active or pending. */}
      <ModelDownloadBanner />

      {/* v1.5.1 — Cmd/Ctrl+K spotlight search across intel + transcripts.
          Listens for the keystroke globally; renders nothing until opened. */}
      <UniversalSearchOverlay />

      {/* v2.0.0 — first-launch what's-new splash. Self-gates on
          localStorage so it only fires once per major version. */}
      <WhatsNewModal />
    </div>
  )
}
