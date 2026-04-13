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
import { Toaster } from 'sonner'
import { NotificationListener } from './components/NotificationListener'
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
      <NotificationListener />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/browse" element={<BrowsePage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route path="/meshtastic" element={<MeshtasticPage />} />
          <Route path="/vault" element={<VaultPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>
)
