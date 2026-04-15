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
import { Toaster } from 'sonner'
import { NotificationListener } from './components/NotificationListener'
import { UnlockGate } from './components/UnlockGate'
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
