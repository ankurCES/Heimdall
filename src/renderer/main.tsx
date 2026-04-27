import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/layout/Layout'
import { DashboardPage } from './pages/dashboard/DashboardPage'
import { FeedPage } from './pages/feed/FeedPage'
import { SourcesPage } from './pages/sources/SourcesPage'
import { AlertsPage } from './pages/alerts/AlertsPage'
import { MapPage } from './pages/map/MapPage'
import { ChatPage } from './pages/chat/ChatPage'
import { AuditPage } from './pages/audit/AuditPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { VaultPage } from './pages/vault/VaultPage'
import { TokensPage } from './pages/tokens/TokensPage'
import { ExplorePage } from './pages/explore/ExplorePage'
import { MeshtasticPage } from './pages/meshtastic/MeshtasticPage'
import { BrowsePage } from './pages/browse/BrowsePage'
import { SyncPage } from './pages/sync/SyncPage'
import { EnrichedPage } from './pages/enriched/EnrichedPage'
import { WatchPage } from './pages/watch/WatchPage'
import { MarketsPage } from './pages/markets/MarketsPage'
import { IwPage } from './pages/iw/IwPage'
import { AchPage } from './pages/ach/AchPage'
import { NetworkPage } from './pages/network/NetworkPage'
import { EntitiesPage } from './pages/entities/EntitiesPage'
import { CounterintelPage } from './pages/counterintel/CounterintelPage'
import { CybintPage } from './pages/cybint/CybintPage'
import { QuarantinePage } from './pages/quarantine/QuarantinePage'
import { OvernightPage } from './pages/overnight/OvernightPage'
import { GeofencesPage } from './pages/geofences/GeofencesPage'
import { AnomaliesPage } from './pages/anomalies/AnomaliesPage'
import { ImagesPage } from './pages/images/ImagesPage'
import { StixPage } from './pages/stix/StixPage'
import { MemoryPage } from './pages/memory/MemoryPage'
import { DarkWebPage } from './pages/darkweb/DarkWebPage'
import { TelegramIntelPage } from './pages/telegram-intel/TelegramIntelPage'
import { WorkflowEditorPage } from './pages/workflows/WorkflowEditorPage'
import { ReportsLibraryPage } from './pages/library/ReportsLibraryPage'
import { CaseFilesPage } from './pages/cases/CaseFilesPage'
import { IndicatorWatchlistPage } from './pages/library/indicators/IndicatorWatchlistPage'
import { SourceReliabilityPage } from './pages/library/reliability/SourceReliabilityPage'
import { RevisionInboxPage } from './pages/library/revisions/RevisionInboxPage'
import { EthicsConsolePage } from './pages/ethics/EthicsConsolePage'
import { HealthDashboardPage } from './pages/system/HealthDashboardPage'
import { ForecastAccountabilityPage } from './pages/system/forecast/ForecastAccountabilityPage'
import { MemoryGraphPage } from './pages/library/memory/MemoryGraphPage'
import { Phase5Page } from './pages/phase5/Phase5Page'
import { Toaster } from 'sonner'
import { NotificationListener } from './components/NotificationListener'
import { UnlockGate } from './components/UnlockGate'
import { ReportMigrationSplash } from './components/splash/ReportMigrationSplash'
import './styles/globals.css'

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
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/browse" element={<BrowsePage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/markets" element={<MarketsPage />} />
          <Route path="/meshtastic" element={<MeshtasticPage />} />
          <Route path="/vault" element={<VaultPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/enriched" element={<EnrichedPage />} />
          <Route path="/watch" element={<WatchPage />} />
          <Route path="/iw" element={<IwPage />} />
          <Route path="/ach" element={<AchPage />} />
          <Route path="/network" element={<NetworkPage />} />
          <Route path="/entities" element={<EntitiesPage />} />
          <Route path="/counterintel" element={<CounterintelPage />} />
          <Route path="/cybint" element={<CybintPage />} />
          <Route path="/quarantine" element={<QuarantinePage />} />
          <Route path="/overnight" element={<OvernightPage />} />
          <Route path="/geofences" element={<GeofencesPage />} />
          <Route path="/anomalies" element={<AnomaliesPage />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/stix" element={<StixPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/darkweb" element={<DarkWebPage />} />
          <Route path="/telegram-intel" element={<TelegramIntelPage />} />
          <Route path="/workflows" element={<WorkflowEditorPage />} />
          <Route path="/library" element={<ReportsLibraryPage />} />
          <Route path="/cases" element={<CaseFilesPage />} />
          <Route path="/indicators" element={<IndicatorWatchlistPage />} />
          <Route path="/reliability" element={<SourceReliabilityPage />} />
          <Route path="/revisions" element={<RevisionInboxPage />} />
          <Route path="/ethics" element={<EthicsConsolePage />} />
          <Route path="/system" element={<HealthDashboardPage />} />
          <Route path="/forecast" element={<ForecastAccountabilityPage />} />
          <Route path="/memory-graph" element={<MemoryGraphPage />} />
          <Route path="/advanced" element={<Phase5Page />} />
          <Route path="/sync" element={<SyncPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      </UnlockGate>
    </HashRouter>
  </React.StrictMode>
)
