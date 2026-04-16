import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import type { Discipline, SourceType } from '@common/types/intel'
import log from 'electron-log'

interface SeedSource {
  name: string
  discipline: Discipline
  type: string
  schedule: string
  config: Record<string, unknown>
}

// All publicly available sources that require no API keys
const FREE_SOURCES: SeedSource[] = [
  // ── DARK WEB (clearnet, no Tor) ───────────────────────────────────
  {
    name: 'Ahmia Dark-Web Search',
    discipline: 'osint',
    type: 'ahmia',
    schedule: '0 */4 * * *', // every 4 hours
    config: {
      // Watch terms come from settings.darkWeb.watchTerms by default;
      // override here per-source by setting `queries: ['term', ...]`
    }
  },
  // ── OSINT ──────────────────────────────────────────────────────────
  {
    name: 'Global News RSS',
    discipline: 'osint',
    type: 'rss',
    schedule: '*/15 * * * *', // every 15 min
    config: {
      feeds: [
        { url: 'https://www.reuters.com/arc/outboundfeeds/v3/all/rss.xml', name: 'Reuters World' },
        { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'NYT World' },
        { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World' },
        { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
        { url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', name: 'UN News' },
        { url: 'https://www.state.gov/rss-feed/press-releases/feed/', name: 'US State Dept' }
      ]
    }
  },
  {
    name: 'Security News RSS',
    discipline: 'osint',
    type: 'rss',
    schedule: '*/30 * * * *', // every 30 min
    config: {
      feeds: [
        { url: 'https://www.darkreading.com/rss.xml', name: 'Dark Reading' },
        { url: 'https://threatpost.com/feed/', name: 'Threatpost' },
        { url: 'https://thehackernews.com/feeds/posts/default', name: 'The Hacker News' },
        { url: 'https://www.securityweek.com/feed', name: 'SecurityWeek' }
      ]
    }
  },
  {
    name: 'Court Records (Security)',
    discipline: 'osint',
    type: 'public-records',
    schedule: '0 */6 * * *', // every 6 hours
    config: {
      searchTerms: ['terrorism', 'national security', 'cybercrime', 'sanctions violation', 'espionage']
    }
  },
  {
    name: 'Academic Papers (Security & AI)',
    discipline: 'osint',
    type: 'academic',
    schedule: '0 */4 * * *', // every 4 hours
    config: {
      categories: ['cs.CR', 'cs.AI']
    }
  },
  {
    name: 'GDELT Global Events',
    discipline: 'osint',
    type: 'gdelt',
    schedule: '*/30 * * * *',
    config: {
      queries: [
        { q: 'terrorism attack', category: 'Terrorism', timespan: '24h' },
        { q: 'military conflict armed', category: 'Conflict', timespan: '24h' },
        { q: 'cyber attack breach hacking', category: 'Cyber', timespan: '24h' },
        { q: 'natural disaster earthquake flood', category: 'Disaster', timespan: '24h' },
        { q: 'sanctions embargo', category: 'Sanctions', timespan: '24h' },
        { q: 'nuclear weapons proliferation', category: 'WMD', timespan: '48h' },
        { q: 'refugee crisis humanitarian', category: 'Humanitarian', timespan: '48h' },
        { q: 'election unrest protest coup', category: 'Political', timespan: '24h' }
      ]
    }
  },
  {
    name: 'CIA World Factbook',
    discipline: 'osint',
    type: 'factbook',
    schedule: '0 0 * * 0', // weekly on Sunday midnight
    config: {
      regions: ['africa', 'europe', 'middle-east', 'south-asia', 'east-n-southeast-asia',
        'central-asia', 'north-america', 'south-america']
    }
  },
  {
    name: 'Government Data (World Bank, WHO, Federal Register, UK Gov)',
    discipline: 'osint',
    type: 'government-data',
    schedule: '0 */6 * * *', // every 6 hours
    config: {}
  },
  {
    name: 'Asia-Pacific News RSS',
    discipline: 'osint',
    type: 'rss',
    schedule: '*/30 * * * *',
    config: {
      feeds: [
        { url: 'https://www3.nhk.or.jp/nhkworld/en/news/list.html', name: 'NHK World Japan' },
        { url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml', name: 'CNA Asia' },
        { url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', name: 'Times of India' },
        { url: 'https://www.scmp.com/rss/91/feed', name: 'SCMP' }
      ]
    }
  },
  {
    name: 'Middle East & Africa News RSS',
    discipline: 'osint',
    type: 'rss',
    schedule: '*/30 * * * *',
    config: {
      feeds: [
        { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
        { url: 'https://www.france24.com/en/rss', name: 'France 24' },
        { url: 'https://rss.dw.com/xml/rss-en-all', name: 'Deutsche Welle' }
      ]
    }
  },
  {
    name: 'Americas & Europe News RSS',
    discipline: 'osint',
    type: 'rss',
    schedule: '*/30 * * * *',
    config: {
      feeds: [
        { url: 'https://feeds.washingtonpost.com/rss/world', name: 'Washington Post World' },
        { url: 'https://rss.cbc.ca/lineup/world.xml', name: 'CBC World Canada' },
        { url: 'https://www.theguardian.com/world/rss', name: 'The Guardian World' },
        { url: 'https://www.spiegel.de/international/index.rss', name: 'Der Spiegel International' }
      ]
    }
  },
  {
    name: 'Government Gazettes & Notices',
    discipline: 'osint',
    type: 'rss',
    schedule: '0 */4 * * *',
    config: {
      feeds: [
        { url: 'https://www.govinfo.gov/rss/fr.xml', name: 'US Federal Register (GovInfo)' },
        { url: 'https://www.govinfo.gov/rss/cprt.xml', name: 'US Congressional Reports' },
        { url: 'https://www.govinfo.gov/rss/cdoc.xml', name: 'US Congressional Documents' },
        { url: 'https://www.legislation.gov.uk/new/data.feed', name: 'UK Legislation (XML)' }
      ]
    }
  },
  {
    name: 'Defense & Military News RSS',
    discipline: 'osint',
    type: 'rss',
    schedule: '*/30 * * * *',
    config: {
      feeds: [
        { url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945', name: 'US DoD News' },
        { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', name: 'Defense News' },
        { url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', name: 'Defense News' }
      ]
    }
  },

  // ── CRIME & POLICE ─────────────────────────────────────────────────
  {
    name: 'UK Police Street Crime',
    discipline: 'osint',
    type: 'uk-police-crime',
    schedule: '0 */4 * * *',
    config: {
      forces: ['metropolitan', 'west-midlands', 'greater-manchester', 'west-yorkshire', 'merseyside'],
      locations: [
        { name: 'London', lat: 51.5074, lng: -0.1278 },
        { name: 'Birmingham', lat: 52.4862, lng: -1.8904 },
        { name: 'Manchester', lat: 53.4808, lng: -2.2426 }
      ]
    }
  },

  // ── IMINT (Camera Feeds) ───────────────────────────────────────────
  {
    name: 'Traffic Cameras (US Cities)',
    discipline: 'imint',
    type: 'traffic-camera',
    schedule: '*/30 * * * *',
    config: {}
  },
  {
    name: 'Public Cameras (Weather, Cities, Ports)',
    discipline: 'imint',
    type: 'public-camera',
    schedule: '0 */1 * * *',
    config: {}
  },

  // ── GEOINT (additional) ───────────────────────────────────────────
  {
    name: 'NASA FIRMS Fire Detection',
    discipline: 'geoint',
    type: 'nasa-firms',
    schedule: '0 */2 * * *',
    config: {}
  },
  {
    name: 'NASA EONET Natural Events',
    discipline: 'geoint',
    type: 'nasa-eonet',
    schedule: '0 */3 * * *',
    config: {}
  },

  // ── SIGINT (additional) ────────────────────────────────────────────
  {
    name: 'ADS-B Aircraft (adsb.lol)',
    discipline: 'sigint',
    type: 'adsb-lol',
    schedule: '*/15 * * * *',
    config: {}
  },
  {
    name: 'ISS Satellite Tracker',
    discipline: 'sigint',
    type: 'satellite',
    schedule: '*/30 * * * *',
    config: {}
  },

  // ── CYBINT ─────────────────────────────────────────────────────────
  {
    name: 'SANS ISC Threat Level & Top Ports',
    discipline: 'cybint',
    type: 'sans-isc',
    schedule: '0 */1 * * *',
    config: {}
  },
  {
    name: 'NVD CVE Monitor',
    discipline: 'cybint',
    type: 'cve',
    schedule: '*/20 * * * *',
    config: {}
  },
  {
    name: 'abuse.ch Threat Feeds',
    discipline: 'cybint',
    type: 'threat-feed',
    schedule: '*/30 * * * *',
    config: {} // OTX requires API key, URLhaus is free
  },

  // ── FININT ─────────────────────────────────────────────────────────
  {
    name: 'SEC EDGAR Filings',
    discipline: 'finint',
    type: 'edgar',
    schedule: '0 */3 * * *', // every 3 hours
    config: {
      searchTerms: ['sanctions', 'money laundering', 'fraud', 'investigation', 'terrorist financing']
    }
  },
  {
    name: 'OFAC & UN Sanctions',
    discipline: 'finint',
    type: 'sanctions',
    schedule: '0 */6 * * *', // every 6 hours
    config: {}
  },

  // ── SOCMINT ────────────────────────────────────────────────────────
  {
    name: 'Reddit Intelligence',
    discipline: 'socmint',
    type: 'reddit',
    schedule: '*/15 * * * *',
    config: {
      subreddits: ['worldnews', 'cybersecurity', 'netsec', 'geopolitics', 'intelligence', 'OSINT']
    }
  },

  // ── RUMINT (Unverified / Chatter) ──────────────────────────────────
  {
    name: 'RUMINT: Conflict & Crisis Chatter',
    discipline: 'rumint',
    type: 'forum',
    schedule: '*/30 * * * *',
    config: {
      feeds: [
        { url: 'https://www.bellingcat.com/feed/', name: 'Bellingcat', tier: 'established' },
        { url: 'https://www.thedailybeast.com/rss', name: 'Daily Beast', tier: 'established' },
        { url: 'https://www.vice.com/en/rss', name: 'VICE News', tier: 'community' },
        { url: 'https://theintercept.com/feed/?rss', name: 'The Intercept', tier: 'established' }
      ]
    }
  },
  {
    name: 'RUMINT: Cyber Underground Chatter',
    discipline: 'rumint',
    type: 'forum',
    schedule: '0 */2 * * *',
    config: {
      feeds: [
        { url: 'https://www.schneier.com/feed/', name: 'Schneier on Security', tier: 'established' },
        { url: 'https://risky.biz/feeds/risky-business/', name: 'Risky Business', tier: 'established' },
        { url: 'https://grahamcluley.com/feed/', name: 'Graham Cluley', tier: 'community' },
        { url: 'https://nakedsecurity.sophos.com/feed/', name: 'Naked Security', tier: 'established' }
      ]
    }
  },
  {
    name: 'RUMINT: Leak & Whistleblower Monitoring',
    discipline: 'rumint',
    type: 'rss',
    schedule: '0 */3 * * *',
    config: {
      feeds: [
        { url: 'https://wikileaks.org/feed', name: 'WikiLeaks' },
        { url: 'https://www.documentcloud.org/feed', name: 'DocumentCloud' },
        { url: 'https://www.propublica.org/feeds/propublica/main', name: 'ProPublica' },
        { url: 'https://www.occrp.org/en/component/content/?format=feed&type=rss', name: 'OCCRP' }
      ]
    }
  },
  {
    name: 'RUMINT: Reddit Unverified Tips',
    discipline: 'rumint',
    type: 'reddit',
    schedule: '*/30 * * * *',
    config: {
      subreddits: ['conspiracy', 'UnresolvedMysteries', 'RBI', 'TrueCrime', 'datahoarder', 'privacy']
    }
  },

  // ── GEOINT ─────────────────────────────────────────────────────────
  {
    name: 'USGS Earthquakes (M4.0+)',
    discipline: 'geoint',
    type: 'usgs-earthquake',
    schedule: '*/10 * * * *', // every 10 min
    config: { minMagnitude: 4.0 }
  },
  {
    name: 'NOAA Weather Alerts',
    discipline: 'geoint',
    type: 'noaa-weather',
    schedule: '*/10 * * * *',
    config: {}
  },

  // ── CI ─────────────────────────────────────────────────────────────
  {
    name: 'Breach News Feeds',
    discipline: 'ci',
    type: 'breach-feed',
    schedule: '*/30 * * * *',
    config: {
      feeds: [
        { url: 'https://www.databreaches.net/feed/', name: 'DataBreaches.net' },
        { url: 'https://krebsonsecurity.com/feed/', name: 'Krebs on Security' },
        { url: 'https://www.bleepingcomputer.com/feed/', name: 'BleepingComputer' }
      ]
    }
  },

  // ── Agency ─────────────────────────────────────────────────────────
  {
    name: 'Interpol Notices',
    discipline: 'agency',
    type: 'interpol',
    schedule: '0 */2 * * *', // every 2 hours
    config: {}
  },
  {
    name: 'FBI Most Wanted',
    discipline: 'agency',
    type: 'fbi',
    schedule: '0 */4 * * *', // every 4 hours
    config: {}
  },
  {
    name: 'Europol Alerts',
    discipline: 'agency',
    type: 'europol',
    schedule: '0 */3 * * *',
    config: {}
  },
  {
    name: 'UN Security Council',
    discipline: 'agency',
    type: 'unsc',
    schedule: '0 */3 * * *',
    config: {}
  },

  // ── Phase A: Natural Disasters & Environmental ────────────────────
  {
    name: 'Radiation Monitoring (Safecast + EPA)',
    discipline: 'geoint',
    type: 'radiation',
    schedule: '0 */1 * * *', // every hour
    config: {}
  },
  {
    name: 'GDACS Disaster Alerts (UN)',
    discipline: 'geoint',
    type: 'gdacs',
    schedule: '*/15 * * * *', // every 15 min
    config: {}
  },
  {
    name: 'Internet Outage Detection (IODA)',
    discipline: 'cybint',
    type: 'internet-outage',
    schedule: '*/15 * * * *',
    config: {}
  },
  {
    name: 'Security Advisories (UK FCDO + AU DFAT)',
    discipline: 'agency',
    type: 'security-advisory',
    schedule: '0 */12 * * *', // every 12 hours
    config: {}
  },

  // ── Phase B: Enhanced Cyber + Markets ─────────────────────────────
  {
    name: 'Cyber IOCs (Feodo + Ransomware.live + C2Intel)',
    discipline: 'cybint',
    type: 'cyber-ioc',
    schedule: '0 */2 * * *', // every 2 hours
    config: {}
  },
  {
    name: 'Commodity & Energy Prices',
    discipline: 'finint',
    type: 'commodity',
    schedule: '*/30 * * * *', // every 30 min during market hours
    config: {}
  },
  {
    name: 'Polymarket Geopolitical Predictions',
    discipline: 'osint',
    type: 'prediction-market',
    schedule: '0 */3 * * *', // every 3 hours
    config: {}
  },

  // ── Phase C: Maritime & Aviation ──────────────────────────────────
  {
    name: 'FAA Airport Delays (14 US Hubs)',
    discipline: 'sigint',
    type: 'airport-delay',
    schedule: '*/15 * * * *', // every 15 min
    config: {}
  },
  {
    name: 'Maritime Chokepoint Monitor',
    discipline: 'sigint',
    type: 'chokepoint',
    schedule: '0 */2 * * *', // every 2 hours
    config: {}
  },

  // ── Phase D+E: Climate + Enhanced Intel ───────────────────────────
  {
    name: 'Climate Anomaly Detection (15 Zones)',
    discipline: 'geoint',
    type: 'climate-anomaly',
    schedule: '0 */6 * * *', // every 6 hours
    config: {}
  }
]

// Sources that require API keys — created disabled, enabled once keys are configured
const API_KEY_SOURCES: SeedSource[] = [
  {
    name: 'AlienVault OTX Pulses',
    discipline: 'cybint',
    type: 'threat-feed',
    schedule: '*/30 * * * *',
    config: { requiresKey: 'otx' }
  },
  {
    name: 'Twitter/X Intelligence',
    discipline: 'socmint',
    type: 'twitter',
    schedule: '*/15 * * * *',
    config: {
      queries: [
        '(terrorism OR attack OR explosion) -"fantasy football"',
        'cyber attack critical infrastructure',
        'breaking emergency evacuate'
      ],
      requiresKey: 'twitter'
    }
  },
  {
    name: 'HaveIBeenPwned Breaches',
    discipline: 'ci',
    type: 'hibp',
    schedule: '0 */6 * * *',
    config: { requiresKey: 'hibp' }
  },
  {
    name: 'FBI Crime Statistics',
    discipline: 'osint',
    type: 'fbi-crime-stats',
    schedule: '0 */6 * * *',
    config: {
      states: ['CA', 'TX', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI'],
      requiresKey: 'datagov'
    }
  },
  {
    name: 'GNews Global Intelligence',
    discipline: 'osint',
    type: 'gnews',
    schedule: '0 */2 * * *', // every 2 hours (100 req/day free limit)
    config: {
      queries: [
        { q: 'terrorism attack security threat' },
        { q: 'cyber attack data breach' },
        { q: 'military conflict escalation' },
        { q: 'sanctions enforcement' },
        { q: 'natural disaster emergency' }
      ],
      requiresKey: 'gnews'
    }
  }
]

const SEEDED_FLAG = 'system.seeded'

export function seedDefaultSources(): void {
  const db = getDatabase()

  // Check if already seeded
  const flag = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEEDED_FLAG) as
    | { value: string }
    | undefined
  if (flag) {
    // Already seeded — but check for NEW sources added since last seed
    addMissingSources(db)
    return
  }

  const now = timestamp()
  const insertStmt = db.prepare(`
    INSERT INTO sources (id, name, discipline, type, config, schedule, enabled, error_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `)

  const tx = db.transaction(() => {
    // Free sources — enabled by default
    for (const src of FREE_SOURCES) {
      insertStmt.run(
        generateId(), src.name, src.discipline, src.type,
        JSON.stringify(src.config), src.schedule, 1, now, now
      )
    }

    // API-key sources — disabled by default
    for (const src of API_KEY_SOURCES) {
      insertStmt.run(
        generateId(), src.name, src.discipline, src.type,
        JSON.stringify(src.config), src.schedule, 0, now, now
      )
    }

    // Mark as seeded
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SEEDED_FLAG, '"true"', now
    )
  })

  tx()

  const total = FREE_SOURCES.length + API_KEY_SOURCES.length
  log.info(`Seeded ${FREE_SOURCES.length} free sources + ${API_KEY_SOURCES.length} API-key sources (${total} total)`)
}

// Add any new sources that don't exist yet (for upgrades)
function addMissingSources(db: ReturnType<typeof getDatabase>): void {
  const existing = new Set(
    (db.prepare('SELECT name FROM sources').all() as Array<{ name: string }>).map((r) => r.name)
  )

  const now = timestamp()
  const insertStmt = db.prepare(`
    INSERT INTO sources (id, name, discipline, type, config, schedule, enabled, error_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `)

  let added = 0
  for (const src of FREE_SOURCES) {
    if (!existing.has(src.name)) {
      insertStmt.run(generateId(), src.name, src.discipline, src.type, JSON.stringify(src.config), src.schedule, 1, now, now)
      added++
    }
  }
  for (const src of API_KEY_SOURCES) {
    if (!existing.has(src.name)) {
      insertStmt.run(generateId(), src.name, src.discipline, src.type, JSON.stringify(src.config), src.schedule, 0, now, now)
      added++
    }
  }

  if (added > 0) {
    log.info(`Added ${added} new sources (upgrade migration)`)
  }
}
