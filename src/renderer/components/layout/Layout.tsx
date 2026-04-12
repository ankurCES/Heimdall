import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { ErrorBoundary } from '../ErrorBoundary'

export function Layout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
