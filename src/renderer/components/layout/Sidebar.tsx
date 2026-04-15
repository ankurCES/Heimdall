import { NavLink } from 'react-router-dom'
import { useState, useEffect } from 'react'
import {
  LayoutDashboard, FileText, Database, Bell, Map, MessageSquare,
  Settings, Activity, BookOpen, Coins, BarChart3, Radio,
  Layers, RefreshCw, Sparkles, Eye, TrendingUp,
  ChevronLeft, ChevronRight, ChevronDown
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import heimdallLogo from '@renderer/assets/heimdall-logo.png'

interface NavGroup {
  id: string
  label: string
  items: Array<{
    to: string
    icon: typeof LayoutDashboard
    label: string
  }>
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/feed', icon: FileText, label: 'Intel Feed' },
      { to: '/map', icon: Map, label: 'Map' },
      { to: '/markets', icon: TrendingUp, label: 'Markets' }
    ]
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    items: [
      { to: '/browse', icon: Layers, label: 'Browse Intel' },
      { to: '/enriched', icon: Sparkles, label: 'Enriched Data' },
      { to: '/watch', icon: Eye, label: 'Watch Terms' },
      { to: '/explore', icon: BarChart3, label: 'Explore' }
    ]
  },
  {
    id: 'sources',
    label: 'Sources & Sync',
    items: [
      { to: '/sources', icon: Database, label: 'Sources' },
      { to: '/sync', icon: RefreshCw, label: 'Sync Center' },
      { to: '/vault', icon: BookOpen, label: 'Obsidian Vault' }
    ]
  },
  {
    id: 'comms',
    label: 'AI & Comms',
    items: [
      { to: '/chat', icon: MessageSquare, label: 'Chat' },
      { to: '/alerts', icon: Bell, label: 'Alerts' },
      { to: '/meshtastic', icon: Radio, label: 'Meshtastic' }
    ]
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { to: '/tokens', icon: Coins, label: 'Token Usage' },
      { to: '/audit', icon: Activity, label: 'Audit Log' },
      { to: '/settings', icon: Settings, label: 'Settings' }
    ]
  }
]

const STORAGE_COLLAPSED = 'sidebar.collapsed'
const STORAGE_GROUPS = 'sidebar.collapsedGroups'

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_COLLAPSED) === 'true' } catch { return false }
  })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_GROUPS)
      return new Set(raw ? JSON.parse(raw) : [])
    } catch { return new Set() }
  })

  useEffect(() => {
    try { localStorage.setItem(STORAGE_COLLAPSED, String(collapsed)) } catch {}
  }, [collapsed])

  useEffect(() => {
    try { localStorage.setItem(STORAGE_GROUPS, JSON.stringify(Array.from(collapsedGroups))) } catch {}
  }, [collapsedGroups])

  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border bg-card transition-all duration-200',
        collapsed ? 'w-14' : 'w-56'
      )}
    >
      {/* Logo + collapse toggle */}
      <div className={cn('flex items-center border-b border-border pt-6 pb-4', collapsed ? 'px-2 justify-center' : 'px-4 justify-between')}>
        <div className={cn('flex items-center gap-2 min-w-0', collapsed && 'justify-center')}>
          <img src={heimdallLogo} alt="Heimdall" className="h-8 w-8 rounded-md shrink-0 shadow-sm shadow-primary/20" />
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-base font-bold tracking-tight leading-none">Heimdall</div>
              <div className="text-[10px] text-muted-foreground italic mt-0.5">Always vigilant</div>
            </div>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
            title="Collapse sidebar"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="mx-auto my-2 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          title="Expand sidebar"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      {/* Navigation */}
      <nav className={cn('flex-1 overflow-y-auto overflow-x-visible', collapsed ? 'px-1.5 py-2' : 'px-2 py-3')}>
        {NAV_GROUPS.map((group) => {
          const isGroupCollapsed = collapsedGroups.has(group.id)
          return (
            <div key={group.id} className={cn('mb-3', collapsed && 'mb-2')}>
              {/* Group header (only when expanded) */}
              {!collapsed && (
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center justify-between w-full px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground"
                >
                  <span>{group.label}</span>
                  <ChevronDown className={cn('h-3 w-3 transition-transform', isGroupCollapsed && '-rotate-90')} />
                </button>
              )}

              {/* Group items (always visible when collapsed; conditional when expanded) */}
              {(collapsed || !isGroupCollapsed) && (
                <div className={cn('space-y-0.5', !collapsed && 'mt-0.5')}>
                  {group.items.map((item) => (
                    <NavItem
                      key={item.to}
                      item={item}
                      collapsed={collapsed}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className={cn('border-t border-border py-2', collapsed ? 'px-1 text-center' : 'px-4')}>
        <p className="text-[10px] text-muted-foreground/70">
          {collapsed ? 'v0.1' : 'v0.1.0 · Public Safety Monitor'}
        </p>
      </div>
    </aside>
  )
}

function NavItem({ item, collapsed }: { item: NavGroup['items'][0]; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-md text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )
      }
      title={collapsed ? item.label : undefined}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}

      {/* Tooltip when collapsed */}
      {collapsed && (
        <span
          className="absolute left-full ml-2 px-2 py-1 rounded bg-popover text-popover-foreground text-xs font-medium opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap shadow-lg border border-border z-50 transition-opacity"
        >
          {item.label}
        </span>
      )}
    </NavLink>
  )
}
