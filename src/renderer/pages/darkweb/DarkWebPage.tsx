import { useState } from 'react'
import { Moon, ListChecks, Sparkles, FileSearch, Network } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { DarkWebIntelTab } from './DarkWebIntelTab'
import { DarkWebExplorerTab } from './DarkWebExplorerTab'
import { DarkWebEnrichmentTab } from './DarkWebEnrichmentTab'
import { DarkWebNetworkTab } from './DarkWebNetworkTab'

/**
 * Dark Web page — four tabs:
 *   - Intel       : the existing list of stored [DARKWEB] reports + Refresh All
 *   - Explorer    : seeded sweep + custom search (Tor required)
 *   - Network     : force-directed graph of onion_crossref links, threat-colored
 *   - Enrichment  : IOC summary, top actors / marketplaces / tags, manual enrich
 */
type Tab = 'intel' | 'explorer' | 'network' | 'enrichment'

const TABS: Array<{ id: Tab; label: string; icon: typeof Moon }> = [
  { id: 'intel',      label: 'Intel',      icon: FileSearch },
  { id: 'explorer',   label: 'Explorer',   icon: ListChecks },
  { id: 'network',    label: 'Network',    icon: Network },
  { id: 'enrichment', label: 'Enrichment', icon: Sparkles }
]

export function DarkWebPage() {
  const [tab, setTab] = useState<Tab>('intel')
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab strip */}
      <div className="px-4 pt-3 border-b border-border bg-card/30 flex items-center gap-1">
        <Moon className="h-4 w-4 text-fuchsia-400 mr-2" />
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
              tab === id
                ? 'border-fuchsia-400 text-fuchsia-200'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-hidden">
        {tab === 'intel' && <DarkWebIntelTab />}
        {tab === 'explorer' && <DarkWebExplorerTab />}
        {tab === 'network' && <DarkWebNetworkTab />}
        {tab === 'enrichment' && <DarkWebEnrichmentTab />}
      </div>
    </div>
  )
}
