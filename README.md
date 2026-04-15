<p align="center">
  <img src="build/icon.png" alt="Heimdall" width="160" />
</p>

<h1 align="center">Heimdall</h1>
<p align="center"><em>Always vigilant</em></p>

<p align="center">
  <a href="https://github.com/ankurCES/Heimdall/releases"><img src="https://img.shields.io/github/v/release/ankurCES/Heimdall?style=flat-square" alt="Release" /></a>
  <a href="https://github.com/ankurCES/Heimdall/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20|%20Windows%20|%20Linux-lightgrey?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/collectors-50%2B-green?style=flat-square" alt="Collectors" />
</p>

---

**Heimdall** is a desktop intelligence monitoring platform for public safety. It aggregates open-source intelligence across 10+ disciplines, enriches data with AI, and presents a unified operational picture through geospatial mapping, relationship graphs, and real-time alerting.

Built with Electron + React + TypeScript. Runs entirely on your machine — no cloud, no subscriptions.

---

## Screenshots

> The app includes 17 pages organized into 5 sidebar groups: **Overview** (Dashboard, Intel Feed, Map, Markets), **Intelligence** (Browse Intel, Enriched Data, Watch Terms, Explore), **Sources & Sync** (Sources, Sync Center, Obsidian Vault), **AI & Comms** (Chat, Alerts, Meshtastic), **System** (Token Usage, Audit Log, Settings).

---

## Features

### Intelligence Collection (50+ Sources)

| Discipline | Sources | Examples |
|-----------|---------|----------|
| **OSINT** | 13 | RSS feeds (BBC, NYT, Al Jazeera), GDELT, GNews, Factbook, Public Records, arXiv, Polymarket predictions |
| **CYBINT** | 8 | NVD CVEs, abuse.ch (URLhaus, Feodo Tracker), SANS ISC, Ransomware.live, C2IntelFeeds, Internet outage detection (IODA) |
| **FININT** | 6 | SEC EDGAR filings, OFAC sanctions, Yahoo Finance commodities (14 futures), MFAPI Indian mutual funds, Alpaca US stocks, Alpaca crypto |
| **SOCMINT** | 4 | Reddit (public JSON), Telegram channels (Bot API + public scraper), Twitter/X |
| **GEOINT** | 8 | USGS earthquakes, NOAA weather, NASA FIRMS wildfires, NASA EONET, GDACS disaster alerts, Safecast radiation, Open-Meteo climate anomalies, Sentinel satellite |
| **SIGINT** | 8 | ADS-B aircraft (adsb.lol), ISS tracking, AIS maritime vessels, Meshtastic LoRa mesh, FCC licenses, FAA airport delays, maritime chokepoints |
| **RUMINT** | 3 | Forum monitoring, Reddit unverified tips, leak/whistleblower feeds |
| **CI** | 2 | HaveIBeenPwned breaches, breach news feeds |
| **Agency** | 5 | Interpol, FBI Most Wanted, Europol, UN Security Council, government travel advisories (UK FCDO + AU DFAT) |
| **IMINT** | 2 | Traffic cameras (DOT feeds), public webcams with LLM vision analysis |
| **Custom** | ∞ | User-addable: Generic JSON API (JSONPath + field map), Telegram channel scraper, GitHub repo monitor (releases/security/commits/files), RSS/Atom feeds |

### Custom Intel Channels (User-Addable)

Add your own intelligence sources via UI without touching code:

- **Generic JSON API** — any REST API with JSONPath selector and field mapping. API keys live in Settings (`settings:apikeys.X` references)
- **Telegram channels** — public preview scraper, no Bot API needed
- **GitHub repos** — monitor releases, security advisories, commits, issues, or specific JSON files
- **RSS/Atom feeds** — any feed URL via UI
- **Source Preset Gallery** — 30+ curated one-click sources: Bellingcat Telegram, OSINT Defender, CISA advisories, MITRE ATT&CK, Sigma rules, Krebs on Security, Talos, Mandiant, MFAPI funds, Alpaca markets, etc.
- **Live "Test Source"** before saving — preview sample reports

### Markets Dashboard

Dedicated trader-style dashboard surfacing all financial intel:

- **KPI strip**: VIX, USD Index, Gold, WTI Crude, Top Mover, Sanctions count
- **Sector heatmap**: 14 commodities color-coded by % change (red→green divergent)
- **Multi-asset price chart**: Toggle commodities/stocks/crypto/funds, normalized vs raw, ranges 24h / 7d / 30d / 90d / 1y / 5y
- **Geopolitical context panels**: Recent SEC filings, OFAC+UN sanctions, Polymarket geopolitical contracts
- **Detail drawer**: Click any commodity → 30-day chart + significant moves table + related intel
- **5-Year historical backfill**: One-click button pulls ~50K daily bars from Yahoo Finance, Alpaca, MFAPI

### AI-Powered Chat

- **Multi-provider LLM** support: OpenAI, Anthropic, Ollama, OpenRouter, Groq, and any OpenAI-compatible API
- **Agentic orchestration**: Plan -> Research -> Analyze with parallel execution
- **10 built-in tools**: `intel_search`, `vector_search`, `entity_lookup`, `web_fetch`, `whois_lookup`, `cve_detail`, `dns_resolve`, `shell_exec`, `create_report`, `graph_query`
- **RAG** over all collected intelligence with hybrid search (vector + keyword)
- **HUMINT generation**: Record chat sessions as Human Intelligence reports
- **Preliminary reports**: Auto-extract recommended actions and information gaps
- **Collapsible thinking blocks**: See the AI's planning, research, and analysis steps

### Operations Center Dashboard

SOC-style overview with 4 zones, auto-refreshing every 30s:

- **6 KPI cards**: Total reports, Critical (24h), 7-day trend, Knowledge graph size, Active sources, Tag count
- **Stacked hourly activity chart**: 24-hour timeline by severity
- **Discipline distribution**: Doughnut chart across 10 disciplines
- **Geo heatmap**: Mini Leaflet map with severity-colored circles for last-24h critical/high events
- **Top entities**: Threat actors, malware, countries, CVEs by mention count (7d)
- **Top sources**: 24h volume with horizontal bar fill colored by discipline
- **Top market movers**: Sorted by |% change| with arrow indicators
- **Critical activity timeline**: 12 most recent high+critical events

### Geospatial Threat Map

- **Leaflet** dark-themed map with 2000+ geo-tagged intel markers
- **Source-specific icons**: Earthquakes, fires, radiation, cyclones, ships, aircraft, advisories
- **ADS-B & ISS trajectory paths**: Smooth great-circle interpolated dotted lines with distinct colors per aircraft/satellite
- **Meshtastic mesh nodes**: Real-time node positions with battery/SNR telemetry
- **Layer toggles**: Enable/disable any discipline or trajectory paths

### Sidebar & Navigation

- **Grouped categories**: 5 logical groups (Overview, Intelligence, Sources & Sync, AI & Comms, System)
- **Collapsible mini mode**: Toggle to 56px icon-only sidebar with hover tooltips
- **Per-group collapse**: Each group has a chevron to fold its items
- **State persistence**: Sidebar collapse state and per-group fold state saved to localStorage
- **Mobile drawer**: Sidebar slides in from a hamburger button on screens < 768px
- **Heimdall logo** + "Always vigilant" tagline at top

### Enrichment Pipeline

- **Entity extraction**: IPs, CVEs, emails, URLs, hashes (MD5/SHA256), countries, organizations, threat actors, malware families
- **17 auto-tag rules**: Terrorism, cyber-attack, military, nuclear, sanctions, natural disaster, etc.
- **Corroboration scoring**: Cross-source, cross-discipline, temporal, and keyword-overlap analysis
- **Squawk classification**: ICAO/FAA emergency codes (7500/7600/7700) + military codes
- **Military aircraft classification**: 28-country ICAO hex range database + 40 callsign prefixes

### Relationship Graph

- **react-force-graph-2d** visualization with 8 link types
- **Node types**: Intel reports, preliminary reports, HUMINT, information gaps, entities
- **Kuzu graph database** (optional) with Cypher queries: shortest path, 2-hop neighbors, entity patterns
- **SQLite fallback**: Full graph functionality without Kuzu

### Real-Time Alerting

| Channel | Method |
|---------|--------|
| **Telegram** | Bot API with test message verification |
| **Meshtastic** | LoRa mesh via protobuf over HTTP API |
| **Email** | SMTP (configurable) |

### Obsidian Integration

- **Vault sync**: Push intel reports, HUMINT, preliminary reports, and tool call logs to Obsidian
- **Bulk import**: Read and index existing vault files
- **Bi-directional**: Browse vault contents directly in Heimdall

### Watch Terms

- Auto-extract search terms from recommended actions and information gaps
- Manual term addition with priority levels
- Collectors match new intel against enabled terms in real-time
- Visual distinction between manual and agent-generated terms

### Resource Management

- **ResourceManager**: 5-minute cleanup cycle (WAL checkpoint, cache pruning, sync log retention)
- **WindowCache**: Cached BrowserWindow emit with 2s TTL
- **Bounded caches**: Robots.txt (200 max), rate limiter bucket pruning
- **Paginated sync**: GraphSync uses 500/page queries instead of loading all records
- **Vector DB cap**: 20K item limit with corrupt index auto-repair

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 33 + electron-vite 5 |
| Frontend | React 19 + TypeScript 5.7 |
| Styling | Tailwind CSS + shadcn/ui + Radix UI |
| Database | SQLite (better-sqlite3, WAL mode) |
| Vector DB | Vectra (local, 384-dim TF-IDF embeddings) |
| Graph DB | Kuzu (optional, Cypher queries) |
| Map | Leaflet + react-leaflet |
| Charts | Chart.js + react-chartjs-2 |
| Graph | react-force-graph-2d |
| LLM | OpenAI-compatible API with SSE streaming |
| Scheduling | Croner (cron expressions) |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| Notifications | Sonner toast |
| Logging | electron-log |

---

## Getting Started

### Prerequisites

- **Node.js** 20+
- **npm** 9+
- **Git**

### Installation

```bash
# Clone the repository
git clone https://github.com/ankurCES/Heimdall.git
cd Heimdall

# Install dependencies (includes native module rebuild for Electron)
npm install

# Run in development mode
npm run dev
```

### Build for Production

```bash
# Build for your current platform
npm run dist

# Platform-specific builds
npm run dist:mac     # macOS DMG (x64 + arm64)
npm run dist:win     # Windows NSIS installer
npm run dist:linux   # Linux AppImage + .deb
```

### Download Pre-Built

Download the latest release from the [Releases page](https://github.com/ankurCES/Heimdall/releases).

> **macOS note**: The app is unsigned. On first launch: right-click the app -> Open -> Open to bypass Gatekeeper.

---

## Configuration

### LLM Connection

1. Go to **Settings -> LLM**
2. Enter your API base URL (e.g., `http://localhost:11434/v1` for Ollama, `https://api.openai.com/v1` for OpenAI)
3. Enter API key (if required)
4. Select or type a model name
5. Click **Test Connection**

Supported providers: OpenAI, Anthropic (via proxy), Ollama, OpenRouter, Groq, Together AI, or any OpenAI-compatible endpoint.

### Telegram Alerts

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Go to **Settings -> Telegram**
3. Paste the bot token
4. Add target chat IDs (use [@userinfobot](https://t.me/userinfobot) to find your ID)
5. Click **Send Test Message** to verify

### Meshtastic

1. Connect your Meshtastic device to WiFi
2. Go to **Settings -> Meshtastic**
3. Select TCP/WiFi and enter the device IP (e.g., `10.0.0.193`)
4. Enable Collection (SIGINT) and/or Alert Dispatch
5. Click **Test Connection**, then **Send Test Message**

### Obsidian

1. Install the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin in Obsidian
2. Go to **Settings -> Obsidian**
3. Enter the API key from the plugin settings
4. Configure sync folder (default: `Heimdall`)
5. Click **Test Connection**

### API Keys (Optional)

Some collectors work better with API keys. Configure in **Settings -> API Keys**:

- **GNews**: Free tier at [gnews.io](https://gnews.io/) (100 requests/day)
- **AlienVault OTX**: Free at [otx.alienvault.com](https://otx.alienvault.com/)
- **HaveIBeenPwned**: Paid at [haveibeenpwned.com/API](https://haveibeenpwned.com/API/Key)

> Most collectors (38+) work without any API keys using free public data sources.

---

## Project Structure

```
src/
  common/           # Shared types, utilities, IPC bridge definitions
  preload/          # Electron preload script (IPC allowlist)
  process/          # Main process (Node.js)
    agents/         # Agent orchestrator (Lead, Analyst, Summary)
    bridge/         # IPC handlers (chat, intel, settings, enrichment, etc.)
    collectors/     # 42+ data source collectors organized by discipline
      osint/        # RSS, GDELT, GNews, Factbook, etc.
      cybint/       # CVE, threat feeds, IOCs, internet outages
      finint/       # EDGAR, sanctions, commodities
      socmint/      # Reddit, Telegram, Twitter
      geoint/       # USGS, NOAA, NASA, radiation, climate, GDACS
      sigint/       # ADS-B, AIS, Meshtastic, ISS, airports, chokepoints
      rumint/       # Forums, unverified tips
      ci/           # Breach feeds, HIBP
      agency/       # Interpol, FBI, Europol, UNSC, advisories
      imint/        # Traffic cameras, public webcams
    services/       # Core services
      database/     # SQLite schema, migrations
      enrichment/   # Entity extraction, tagging, corroboration
      graphdb/      # Kuzu graph DB + SQLite sync
      humint/       # HUMINT report generation
      llm/          # LLM service, agentic orchestrator, RAG, tool calling
      obsidian/     # Obsidian REST API client
      resource/     # ResourceManager, WindowCache
      sync/         # SyncManager (10 job types)
      vectordb/     # Vectra vector DB + ingestion pipeline
      watch/        # Watch terms service
  renderer/         # React frontend
    pages/          # 16 app pages
    components/     # Shared UI components (shadcn/ui)
```

---

## Database

Heimdall uses SQLite (WAL mode) with 20+ tables:

- `intel_reports` — Core intelligence data (7000+ reports typical)
- `sources` — 46+ configured data sources with cron schedules
- `intel_tags`, `intel_entities`, `intel_links` — Enrichment data
- `chat_sessions`, `chat_messages` — LLM conversation history
- `preliminary_reports`, `intel_gaps`, `recommended_actions` — Analysis products
- `humint_reports` — Human intelligence from chat sessions
- `watch_terms` — Targeted collection terms
- `tool_call_logs` — Agent tool execution audit trail
- `meshtastic_nodes` — Mesh network node tracking
- `token_usage` — LLM token consumption tracking
- `audit_log` — System audit trail

Versioned migrations with automatic pre-migration backups ensure zero data loss on upgrades.

---

## Architecture

```
                    Electron Main Process
                    ┌─────────────────────────────────────┐
                    │  CollectorManager (42+ collectors)    │
                    │  EnrichmentOrchestrator (15s poll)    │
                    │  IntelPipeline (vector ingestion)     │
                    │  ResourceManager (5min cleanup)       │
                    │  CronService (job scheduling)         │
                    │  AlertEngine (3 dispatchers)          │
                    │  KuzuService (graph DB)               │
                    │  SyncManager (10 sync jobs)           │
                    │                                       │
                    │  SQLite ←→ Vectra ←→ Kuzu             │
                    └────────────┬────────────────────────┘
                                 │ IPC Bridge (60+ channels)
                    ┌────────────┴────────────────────────┐
                    │        Electron Renderer             │
                    │  React 19 + Tailwind + shadcn/ui     │
                    │  16 Pages + Leaflet Map              │
                    │  Chart.js + Force Graph              │
                    │  SSE Streaming Chat                   │
                    └─────────────────────────────────────┘
```

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Developer

**Ankur Nair**

- [GitHub](https://github.com/ankurCES)
- [LinkedIn](https://www.linkedin.com/in/ankur-nair-10baab350/)

---

<p align="center">
  <strong>Heimdall</strong> — Always vigilant<br/>
  <sub>Built with Electron + React + TypeScript + SQLite + Vectra</sub>
</p>
