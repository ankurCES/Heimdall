import { Outlet, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { Menu, X } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { ErrorBoundary } from '../ErrorBoundary'

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen w-screen overflow-hidden">
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
  )
}
