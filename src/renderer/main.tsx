import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/layout/Layout'
import { Toaster } from 'sonner'
import { NotificationListener } from './components/NotificationListener'
import { UnlockGate } from './components/UnlockGate'
import { ReportMigrationSplash } from './components/splash/ReportMigrationSplash'
import { lazyNamed } from './lazy'
import './styles/globals.css'

// v1.4.14 — DashboardPage stays eager-loaded so first paint after
// unlock has zero suspension. Every other route is split into its own
// chunk so the initial bundle parse drops dramatically — going from
// ~6.4 MB monolithic to ~2.5 MB shell + ~70-200 KB per route.
import { DashboardPage } from './pages/dashboard/DashboardPage'

// All other routes lazy-loaded. Each becomes its own JS chunk.
const FeedPage = lazyNamed(() => import('./pages/feed/FeedPage'), 'FeedPage')
const SourcesPage = lazyNamed(() => import('./pages/sources/SourcesPage'), 'SourcesPage')
const AlertsPage = lazyNamed(() => import('./pages/alerts/AlertsPage'), 'AlertsPage')
const MapPage = lazyNamed(() => import('./pages/map/MapPage'), 'MapPage')
const ChatPage = lazyNamed(() => import('./pages/chat/ChatPage'), 'ChatPage')
const AuditPage = lazyNamed(() => import('./pages/audit/AuditPage'), 'AuditPage')
const SettingsPage = lazyNamed(() => import('./pages/settings/SettingsPage'), 'SettingsPage')
const VaultPage = lazyNamed(() => import('./pages/vault/VaultPage'), 'VaultPage')
const TokensPage = lazyNamed(() => import('./pages/tokens/TokensPage'), 'TokensPage')
const ExplorePage = lazyNamed(() => import('./pages/explore/ExplorePage'), 'ExplorePage')
const MeshtasticPage = lazyNamed(() => import('./pages/meshtastic/MeshtasticPage'), 'MeshtasticPage')
const BrowsePage = lazyNamed(() => import('./pages/browse/BrowsePage'), 'BrowsePage')
const SyncPage = lazyNamed(() => import('./pages/sync/SyncPage'), 'SyncPage')
const EnrichedPage = lazyNamed(() => import('./pages/enriched/EnrichedPage'), 'EnrichedPage')
const WatchPage = lazyNamed(() => import('./pages/watch/WatchPage'), 'WatchPage')
const MarketsPage = lazyNamed(() => import('./pages/markets/MarketsPage'), 'MarketsPage')
const IwPage = lazyNamed(() => import('./pages/iw/IwPage'), 'IwPage')
const AchPage = lazyNamed(() => import('./pages/ach/AchPage'), 'AchPage')
const NetworkPage = lazyNamed(() => import('./pages/network/NetworkPage'), 'NetworkPage')
const EntitiesPage = lazyNamed(() => import('./pages/entities/EntitiesPage'), 'EntitiesPage')
const CounterintelPage = lazyNamed(() => import('./pages/counterintel/CounterintelPage'), 'CounterintelPage')
const CybintPage = lazyNamed(() => import('./pages/cybint/CybintPage'), 'CybintPage')
const QuarantinePage = lazyNamed(() => import('./pages/quarantine/QuarantinePage'), 'QuarantinePage')
const OvernightPage = lazyNamed(() => import('./pages/overnight/OvernightPage'), 'OvernightPage')
const GeofencesPage = lazyNamed(() => import('./pages/geofences/GeofencesPage'), 'GeofencesPage')
const AnomaliesPage = lazyNamed(() => import('./pages/anomalies/AnomaliesPage'), 'AnomaliesPage')
const ImagesPage = lazyNamed(() => import('./pages/images/ImagesPage'), 'ImagesPage')
const TranscriptsPage = lazyNamed(() => import('./pages/transcripts/TranscriptsPage'), 'TranscriptsPage')
const StixPage = lazyNamed(() => import('./pages/stix/StixPage'), 'StixPage')
const MemoryPage = lazyNamed(() => import('./pages/memory/MemoryPage'), 'MemoryPage')
const DarkWebPage = lazyNamed(() => import('./pages/darkweb/DarkWebPage'), 'DarkWebPage')
const TelegramIntelPage = lazyNamed(() => import('./pages/telegram-intel/TelegramIntelPage'), 'TelegramIntelPage')
const WorkflowEditorPage = lazyNamed(() => import('./pages/workflows/WorkflowEditorPage'), 'WorkflowEditorPage')
const ReportsLibraryPage = lazyNamed(() => import('./pages/library/ReportsLibraryPage'), 'ReportsLibraryPage')
const CaseFilesPage = lazyNamed(() => import('./pages/cases/CaseFilesPage'), 'CaseFilesPage')
const IndicatorWatchlistPage = lazyNamed(() => import('./pages/library/indicators/IndicatorWatchlistPage'), 'IndicatorWatchlistPage')
const SourceReliabilityPage = lazyNamed(() => import('./pages/library/reliability/SourceReliabilityPage'), 'SourceReliabilityPage')
const RevisionInboxPage = lazyNamed(() => import('./pages/library/revisions/RevisionInboxPage'), 'RevisionInboxPage')
const EthicsConsolePage = lazyNamed(() => import('./pages/ethics/EthicsConsolePage'), 'EthicsConsolePage')
const HealthDashboardPage = lazyNamed(() => import('./pages/system/HealthDashboardPage'), 'HealthDashboardPage')
const ForecastAccountabilityPage = lazyNamed(() => import('./pages/system/forecast/ForecastAccountabilityPage'), 'ForecastAccountabilityPage')
const MemoryGraphPage = lazyNamed(() => import('./pages/library/memory/MemoryGraphPage'), 'MemoryGraphPage')
const Phase5Page = lazyNamed(() => import('./pages/phase5/Phase5Page'), 'Phase5Page')
const BriefingsPage = lazyNamed(() => import('./pages/briefings/BriefingsPage'), 'BriefingsPage')
const EntityTimelinePage = lazyNamed(() => import('./pages/entity-timeline/EntityTimelinePage'), 'EntityTimelinePage')
const WatchlistPage = lazyNamed(() => import('./pages/watchlist/WatchlistPage'), 'WatchlistPage')
const GraphCanvasPage = lazyNamed(() => import('./pages/graph-canvas/GraphCanvasPage'), 'GraphCanvasPage')
const ComparisonsPage = lazyNamed(() => import('./pages/comparisons/ComparisonsPage'), 'ComparisonsPage')

// Lightweight loading indicator for route transitions. Sized to match
// the main content area and centered so swap-in feels deliberate
// rather than blank.
function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-full w-full text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <div className="h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        Loading…
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <Toaster
        theme="dark"
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{
          style: { background: 'hsl(222 47% 8%)', border: '1px solid hsl(217 33% 17%)', color: 'hsl(210 40% 93%)' }
        }}
      />
      <UnlockGate>
      <NotificationListener />
      <ReportMigrationSplash />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/feed" element={<Suspense fallback={<RouteFallback />}><FeedPage /></Suspense>} />
          <Route path="/browse" element={<Suspense fallback={<RouteFallback />}><BrowsePage /></Suspense>} />
          <Route path="/sources" element={<Suspense fallback={<RouteFallback />}><SourcesPage /></Suspense>} />
          <Route path="/alerts" element={<Suspense fallback={<RouteFallback />}><AlertsPage /></Suspense>} />
          <Route path="/map" element={<Suspense fallback={<RouteFallback />}><MapPage /></Suspense>} />
          <Route path="/markets" element={<Suspense fallback={<RouteFallback />}><MarketsPage /></Suspense>} />
          <Route path="/meshtastic" element={<Suspense fallback={<RouteFallback />}><MeshtasticPage /></Suspense>} />
          <Route path="/vault" element={<Suspense fallback={<RouteFallback />}><VaultPage /></Suspense>} />
          <Route path="/chat" element={<Suspense fallback={<RouteFallback />}><ChatPage /></Suspense>} />
          <Route path="/explore" element={<Suspense fallback={<RouteFallback />}><ExplorePage /></Suspense>} />
          <Route path="/enriched" element={<Suspense fallback={<RouteFallback />}><EnrichedPage /></Suspense>} />
          <Route path="/watch" element={<Suspense fallback={<RouteFallback />}><WatchPage /></Suspense>} />
          <Route path="/iw" element={<Suspense fallback={<RouteFallback />}><IwPage /></Suspense>} />
          <Route path="/ach" element={<Suspense fallback={<RouteFallback />}><AchPage /></Suspense>} />
          <Route path="/network" element={<Suspense fallback={<RouteFallback />}><NetworkPage /></Suspense>} />
          <Route path="/entities" element={<Suspense fallback={<RouteFallback />}><EntitiesPage /></Suspense>} />
          <Route path="/counterintel" element={<Suspense fallback={<RouteFallback />}><CounterintelPage /></Suspense>} />
          <Route path="/cybint" element={<Suspense fallback={<RouteFallback />}><CybintPage /></Suspense>} />
          <Route path="/quarantine" element={<Suspense fallback={<RouteFallback />}><QuarantinePage /></Suspense>} />
          <Route path="/overnight" element={<Suspense fallback={<RouteFallback />}><OvernightPage /></Suspense>} />
          <Route path="/geofences" element={<Suspense fallback={<RouteFallback />}><GeofencesPage /></Suspense>} />
          <Route path="/anomalies" element={<Suspense fallback={<RouteFallback />}><AnomaliesPage /></Suspense>} />
          <Route path="/images" element={<Suspense fallback={<RouteFallback />}><ImagesPage /></Suspense>} />
          <Route path="/transcripts" element={<Suspense fallback={<RouteFallback />}><TranscriptsPage /></Suspense>} />
          <Route path="/stix" element={<Suspense fallback={<RouteFallback />}><StixPage /></Suspense>} />
          <Route path="/memory" element={<Suspense fallback={<RouteFallback />}><MemoryPage /></Suspense>} />
          <Route path="/darkweb" element={<Suspense fallback={<RouteFallback />}><DarkWebPage /></Suspense>} />
          <Route path="/telegram-intel" element={<Suspense fallback={<RouteFallback />}><TelegramIntelPage /></Suspense>} />
          <Route path="/workflows" element={<Suspense fallback={<RouteFallback />}><WorkflowEditorPage /></Suspense>} />
          <Route path="/library" element={<Suspense fallback={<RouteFallback />}><ReportsLibraryPage /></Suspense>} />
          <Route path="/cases" element={<Suspense fallback={<RouteFallback />}><CaseFilesPage /></Suspense>} />
          <Route path="/indicators" element={<Suspense fallback={<RouteFallback />}><IndicatorWatchlistPage /></Suspense>} />
          <Route path="/reliability" element={<Suspense fallback={<RouteFallback />}><SourceReliabilityPage /></Suspense>} />
          <Route path="/revisions" element={<Suspense fallback={<RouteFallback />}><RevisionInboxPage /></Suspense>} />
          <Route path="/ethics" element={<Suspense fallback={<RouteFallback />}><EthicsConsolePage /></Suspense>} />
          <Route path="/system" element={<Suspense fallback={<RouteFallback />}><HealthDashboardPage /></Suspense>} />
          <Route path="/forecast" element={<Suspense fallback={<RouteFallback />}><ForecastAccountabilityPage /></Suspense>} />
          <Route path="/memory-graph" element={<Suspense fallback={<RouteFallback />}><MemoryGraphPage /></Suspense>} />
          <Route path="/advanced" element={<Suspense fallback={<RouteFallback />}><Phase5Page /></Suspense>} />
          <Route path="/sync" element={<Suspense fallback={<RouteFallback />}><SyncPage /></Suspense>} />
          <Route path="/tokens" element={<Suspense fallback={<RouteFallback />}><TokensPage /></Suspense>} />
          <Route path="/audit" element={<Suspense fallback={<RouteFallback />}><AuditPage /></Suspense>} />
          <Route path="/briefings" element={<Suspense fallback={<RouteFallback />}><BriefingsPage /></Suspense>} />
          <Route path="/entity/:id" element={<Suspense fallback={<RouteFallback />}><EntityTimelinePage /></Suspense>} />
          <Route path="/watchlist" element={<Suspense fallback={<RouteFallback />}><WatchlistPage /></Suspense>} />
          <Route path="/graph" element={<Suspense fallback={<RouteFallback />}><GraphCanvasPage /></Suspense>} />
          <Route path="/comparisons" element={<Suspense fallback={<RouteFallback />}><ComparisonsPage /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<RouteFallback />}><SettingsPage /></Suspense>} />
        </Route>
      </Routes>
      </UnlockGate>
    </HashRouter>
  </React.StrictMode>
)
