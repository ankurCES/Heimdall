import { useState } from 'react'
import {
  Settings,
  Key,
  Mail,
  Send,
  Radio,
  Database,
  ShieldCheck,
  Brain,
  BookOpen,
  Info
} from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { ApiKeysTab } from './tabs/ApiKeysTab'
import { SmtpTab } from './tabs/SmtpTab'
import { TelegramTab } from './tabs/TelegramTab'
import { MeshtasticTab } from './tabs/MeshtasticTab'
import { SourcesTab } from './tabs/SourcesTab'
import { SafetyTab } from './tabs/SafetyTab'
import { LlmTab } from './tabs/LlmTab'
import { ObsidianTab } from './tabs/ObsidianTab'
import { AboutTab } from './tabs/AboutTab'

const tabs = [
  { id: 'sources', label: 'Sources', icon: Database, component: SourcesTab },
  { id: 'apikeys', label: 'API Keys', icon: Key, component: ApiKeysTab },
  { id: 'smtp', label: 'SMTP', icon: Mail, component: SmtpTab },
  { id: 'telegram', label: 'Telegram', icon: Send, component: TelegramTab },
  { id: 'meshtastic', label: 'Meshtastic', icon: Radio, component: MeshtasticTab },
  { id: 'obsidian', label: 'Obsidian', icon: BookOpen, component: ObsidianTab },
  { id: 'llm', label: 'LLM', icon: Brain, component: LlmTab },
  { id: 'safety', label: 'Safety', icon: ShieldCheck, component: SafetyTab },
  { id: 'about', label: 'About', icon: Info, component: AboutTab }
]

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState('sources')

  const ActiveComponent = tabs.find((t) => t.id === activeTab)?.component ?? SourcesTab

  return (
    <div className="flex h-full">
      {/* Settings sidebar */}
      <div className="w-48 border-r border-border bg-card/50 p-3 space-y-1">
        <div className="flex items-center gap-2 px-3 py-2 mb-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Settings</span>
        </div>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              activeTab === tab.id
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Settings content */}
      <div className="flex-1 overflow-auto p-6">
        <ActiveComponent />
      </div>
    </div>
  )
}
