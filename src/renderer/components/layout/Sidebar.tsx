import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  FileText,
  Database,
  Bell,
  Map,
  MessageSquare,
  Settings,
  Shield,
  Activity,
  BookOpen,
  Coins,
  BarChart3
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/feed', icon: FileText, label: 'Intel Feed' },
  { to: '/sources', icon: Database, label: 'Sources' },
  { to: '/alerts', icon: Bell, label: 'Alerts' },
  { to: '/map', icon: Map, label: 'Map' },
  { to: '/vault', icon: BookOpen, label: 'Obsidian Vault' },
  { to: '/chat', icon: MessageSquare, label: 'Chat' },
  { to: '/explore', icon: BarChart3, label: 'Explore' },
  { to: '/tokens', icon: Coins, label: 'Token Usage' },
  { to: '/audit', icon: Activity, label: 'Audit Log' },
  { to: '/settings', icon: Settings, label: 'Settings' }
]

export function Sidebar() {
  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-4">
        <Shield className="h-6 w-6 text-primary" />
        <span className="text-lg font-bold tracking-tight">Heimdall</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2 py-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">Heimdall v0.1.0</p>
        <p className="text-xs text-muted-foreground">Public Safety Monitor</p>
      </div>
    </aside>
  )
}
