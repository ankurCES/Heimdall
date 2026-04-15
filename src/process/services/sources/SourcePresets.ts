import type { Discipline } from '@common/types/intel'

export interface SourcePreset {
  id: string
  name: string
  discipline: Discipline
  type: string
  category: string
  description: string
  config: Record<string, unknown>
  schedule: string
  url?: string  // reference URL for documentation
}

// Curated catalog of intel sources for one-click add
// Categorized by source type for browseability
export const SOURCE_PRESETS: SourcePreset[] = [
  // ═══════════════════════════════════════════════════════════════
  // OSINT TELEGRAM CHANNELS (verified public channels)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'tg-bellingcat',
    name: 'Bellingcat (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Investigative journalism collective — verified OSINT, conflict zones, war crimes',
    config: { channels: [{ username: 'bellingcat' }], maxPostsPerChannel: 10 },
    schedule: '*/30 * * * *',
    url: 'https://t.me/bellingcat'
  },
  {
    id: 'tg-osintdefender',
    name: 'OSINT Defender (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Real-time defense and conflict OSINT updates',
    config: { channels: [{ username: 'osintdefender' }], maxPostsPerChannel: 15 },
    schedule: '*/15 * * * *',
    url: 'https://t.me/osintdefender'
  },
  {
    id: 'tg-aurorasintl',
    name: 'Aurora Intel (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Geopolitical intelligence and Middle East conflict tracking',
    config: { channels: [{ username: 'AuroraIntel' }], maxPostsPerChannel: 10 },
    schedule: '*/30 * * * *',
    url: 'https://t.me/AuroraIntel'
  },
  {
    id: 'tg-bnonews',
    name: 'BNO News (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Breaking news from around the world — fast updates',
    config: { channels: [{ username: 'bnonews' }], maxPostsPerChannel: 15 },
    schedule: '*/15 * * * *',
    url: 'https://t.me/bnonews'
  },
  {
    id: 'tg-liveuamap',
    name: 'LiveUAMap (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Live conflict mapping and geolocated incident reports',
    config: { channels: [{ username: 'liveuamap' }], maxPostsPerChannel: 15 },
    schedule: '*/15 * * * *',
    url: 'https://t.me/liveuamap'
  },
  {
    id: 'tg-warmonitors',
    name: 'War Monitor (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Military operations and combat footage analysis',
    config: { channels: [{ username: 'warmonitors' }], maxPostsPerChannel: 10 },
    schedule: '*/30 * * * *',
    url: 'https://t.me/warmonitors'
  },
  {
    id: 'tg-deepstateua',
    name: 'DeepState UA (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Ukraine conflict frontline mapping and analysis',
    config: { channels: [{ username: 'DeepStateUA' }], maxPostsPerChannel: 10 },
    schedule: '*/30 * * * *',
    url: 'https://t.me/DeepStateUA'
  },
  {
    id: 'tg-nexta',
    name: 'NEXTA (Telegram)',
    discipline: 'osint', type: 'telegram-subscriber',
    category: 'OSINT Telegram',
    description: 'Independent media — Belarus, Ukraine, Russia coverage',
    config: { channels: [{ username: 'nexta_tv' }], maxPostsPerChannel: 10 },
    schedule: '*/30 * * * *',
    url: 'https://t.me/nexta_tv'
  },

  // ═══════════════════════════════════════════════════════════════
  // GITHUB THREAT INTEL REPOS
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'gh-cps-feeds',
    name: 'Public Intelligence Feeds (CriticalPathSecurity)',
    discipline: 'cybint', type: 'github-repo',
    category: 'GitHub Threat Intel',
    description: 'Standard-format threat intelligence feeds — IPs, domains, hashes',
    config: {
      owner: 'CriticalPathSecurity', repo: 'Public-Intelligence-Feeds',
      watchTypes: ['releases', 'commits']
    },
    schedule: '0 */6 * * *',
    url: 'https://github.com/CriticalPathSecurity/Public-Intelligence-Feeds'
  },
  {
    id: 'gh-bert-feeds',
    name: 'Open-Source Threat Intel Feeds (Bert-JanP)',
    discipline: 'cybint', type: 'github-repo',
    category: 'GitHub Threat Intel',
    description: 'Curated free threat feeds — IP, URL, CVE, hash indicators',
    config: {
      owner: 'Bert-JanP', repo: 'Open-Source-Threat-Intel-Feeds',
      watchTypes: ['commits']
    },
    schedule: '0 */6 * * *',
    url: 'https://github.com/Bert-JanP/Open-Source-Threat-Intel-Feeds'
  },
  {
    id: 'gh-davidonzo',
    name: 'Threat-Intel (davidonzo)',
    discipline: 'cybint', type: 'github-repo',
    category: 'GitHub Threat Intel',
    description: 'Threat intelligence repository with API integration',
    config: {
      owner: 'davidonzo', repo: 'Threat-Intel',
      watchTypes: ['releases', 'commits']
    },
    schedule: '0 */6 * * *',
    url: 'https://github.com/davidonzo/Threat-Intel'
  },
  {
    id: 'gh-mitre-attack',
    name: 'MITRE ATT&CK Framework',
    discipline: 'cybint', type: 'github-repo',
    category: 'GitHub Threat Intel',
    description: 'MITRE ATT&CK knowledge base updates and new techniques',
    config: {
      owner: 'mitre', repo: 'cti',
      watchTypes: ['releases', 'commits']
    },
    schedule: '0 0 * * *',
    url: 'https://github.com/mitre/cti'
  },
  {
    id: 'gh-sigma',
    name: 'Sigma Detection Rules',
    discipline: 'cybint', type: 'github-repo',
    category: 'GitHub Threat Intel',
    description: 'Generic signature format for SIEM detection rules',
    config: {
      owner: 'SigmaHQ', repo: 'sigma',
      watchTypes: ['releases']
    },
    schedule: '0 0 * * *',
    url: 'https://github.com/SigmaHQ/sigma'
  },
  {
    id: 'gh-yara-rules',
    name: 'YARA Rules Repository',
    discipline: 'cybint', type: 'github-repo',
    category: 'GitHub Threat Intel',
    description: 'Community YARA rules for malware identification',
    config: {
      owner: 'Yara-Rules', repo: 'rules',
      watchTypes: ['commits']
    },
    schedule: '0 */12 * * *',
    url: 'https://github.com/Yara-Rules/rules'
  },

  // ═══════════════════════════════════════════════════════════════
  // GOVERNMENT ADVISORIES (RSS)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'rss-cisa-alerts',
    name: 'CISA Cybersecurity Advisories',
    discipline: 'cybint', type: 'rss',
    category: 'Government Advisories',
    description: 'US Cybersecurity & Infrastructure Security Agency alerts',
    config: { feeds: [{ url: 'https://www.cisa.gov/news.xml', name: 'CISA Alerts' }] },
    schedule: '*/30 * * * *',
    url: 'https://www.cisa.gov/news-events/cybersecurity-advisories'
  },
  {
    id: 'rss-cisa-icsa',
    name: 'CISA ICS Advisories',
    discipline: 'cybint', type: 'rss',
    category: 'Government Advisories',
    description: 'Industrial Control Systems vulnerability advisories',
    config: { feeds: [{ url: 'https://www.cisa.gov/cybersecurity-advisories/ics-advisories.xml', name: 'CISA ICS' }] },
    schedule: '0 */2 * * *'
  },
  {
    id: 'rss-uscert-alerts',
    name: 'US-CERT Current Activity',
    discipline: 'cybint', type: 'rss',
    category: 'Government Advisories',
    description: 'United States Computer Emergency Readiness Team alerts',
    config: { feeds: [{ url: 'https://www.cisa.gov/uscert/ncas/current-activity.xml', name: 'US-CERT' }] },
    schedule: '0 */1 * * *'
  },
  {
    id: 'rss-ncsc-uk',
    name: 'UK NCSC Threat Reports',
    discipline: 'cybint', type: 'rss',
    category: 'Government Advisories',
    description: 'UK National Cyber Security Centre threat intelligence',
    config: { feeds: [{ url: 'https://www.ncsc.gov.uk/api/1/services/v1/all-rss-feed.xml', name: 'UK NCSC' }] },
    schedule: '0 */3 * * *'
  },

  // ═══════════════════════════════════════════════════════════════
  // CUSTOM API EXAMPLES
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'api-cve-circl',
    name: 'CIRCL CVE Search API',
    discipline: 'cybint', type: 'api-endpoint',
    category: 'Custom APIs',
    description: 'Recent CVE entries from CIRCL public API',
    config: {
      url: 'https://cve.circl.lu/api/last',
      jsonPath: '$[*]',
      fieldMap: {
        title: 'id',
        content: 'summary',
        sourceUrl: 'references[0]',
        severity: 'cvss',
        severityMap: { '9': 'critical', '7': 'high', '5': 'medium', '0': 'low' }
      },
      discipline: 'cybint',
      maxItems: 25
    },
    schedule: '0 */2 * * *',
    url: 'https://cve.circl.lu/'
  },
  {
    id: 'api-shodan-trends',
    name: 'Shodan InternetDB Public API',
    discipline: 'cybint', type: 'api-endpoint',
    category: 'Custom APIs',
    description: 'Internet exposure data — example endpoint (replace IP)',
    config: {
      url: 'https://internetdb.shodan.io/8.8.8.8',
      jsonPath: '$',
      fieldMap: {
        title: 'ip',
        content: 'hostnames'
      },
      discipline: 'cybint',
      defaultSeverity: 'info'
    },
    schedule: '0 0 * * *',
    url: 'https://internetdb.shodan.io/'
  },
  {
    id: 'api-otx-pulses',
    name: 'AlienVault OTX Recent Pulses',
    discipline: 'cybint', type: 'api-endpoint',
    category: 'Custom APIs',
    description: 'Open Threat Exchange pulses (requires API key in headers)',
    config: {
      url: 'https://otx.alienvault.com/api/v1/pulses/subscribed?limit=20',
      headers: { 'X-OTX-API-KEY': 'YOUR_API_KEY_HERE' },
      jsonPath: '$.results[*]',
      fieldMap: {
        title: 'name',
        content: 'description',
        sourceUrl: 'id'
      },
      discipline: 'cybint',
      maxItems: 20
    },
    schedule: '0 */6 * * *',
    url: 'https://otx.alienvault.com/api'
  },

  // ═══════════════════════════════════════════════════════════════
  // CUSTOM RSS EXAMPLES
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'rss-krebs',
    name: 'Krebs on Security',
    discipline: 'cybint', type: 'rss',
    category: 'Cybersecurity News',
    description: 'Brian Krebs\' cybersecurity investigation blog',
    config: { feeds: [{ url: 'https://krebsonsecurity.com/feed/', name: 'Krebs on Security' }] },
    schedule: '0 */2 * * *'
  },
  {
    id: 'rss-darkreading',
    name: 'Dark Reading',
    discipline: 'cybint', type: 'rss',
    category: 'Cybersecurity News',
    description: 'Cybersecurity news, analysis, and threat intelligence',
    config: { feeds: [{ url: 'https://www.darkreading.com/rss.xml', name: 'Dark Reading' }] },
    schedule: '0 */2 * * *'
  },
  {
    id: 'rss-thehackernews',
    name: 'The Hacker News',
    discipline: 'cybint', type: 'rss',
    category: 'Cybersecurity News',
    description: 'Daily cybersecurity news, hacking, and vulnerability updates',
    config: { feeds: [{ url: 'https://feeds.feedburner.com/TheHackersNews', name: 'The Hacker News' }] },
    schedule: '0 */1 * * *'
  },
  {
    id: 'rss-bleepingcomputer',
    name: 'BleepingComputer',
    discipline: 'cybint', type: 'rss',
    category: 'Cybersecurity News',
    description: 'Tech support, malware analysis, and cybersecurity news',
    config: { feeds: [{ url: 'https://www.bleepingcomputer.com/feed/', name: 'BleepingComputer' }] },
    schedule: '0 */2 * * *'
  },

  // ═══════════════════════════════════════════════════════════════
  // SECURITY RESEARCH RSS
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'rss-googlepm',
    name: 'Google Project Zero',
    discipline: 'cybint', type: 'rss',
    category: 'Security Research',
    description: 'Google\'s vulnerability research blog',
    config: { feeds: [{ url: 'https://googleprojectzero.blogspot.com/feeds/posts/default', name: 'Project Zero' }] },
    schedule: '0 */6 * * *'
  },
  {
    id: 'rss-talos',
    name: 'Cisco Talos Intelligence',
    discipline: 'cybint', type: 'rss',
    category: 'Security Research',
    description: 'Cisco Talos security research and threat intelligence',
    config: { feeds: [{ url: 'https://blog.talosintelligence.com/feeds/posts/default', name: 'Cisco Talos' }] },
    schedule: '0 */4 * * *'
  },
  {
    id: 'rss-mandiant',
    name: 'Mandiant Threat Intelligence',
    discipline: 'cybint', type: 'rss',
    category: 'Security Research',
    description: 'Mandiant (Google Cloud) threat research and APT analysis',
    config: { feeds: [{ url: 'https://www.mandiant.com/resources/blog/rss.xml', name: 'Mandiant' }] },
    schedule: '0 */6 * * *'
  },

  // ═══════════════════════════════════════════════════════════════
  // INDIAN MUTUAL FUNDS (MFAPI) — popular schemes
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'mfapi-large-cap',
    name: 'MFAPI: Large Cap Funds (HDFC/ICICI/SBI)',
    discipline: 'finint', type: 'mfapi',
    category: 'Indian Mutual Funds',
    description: 'NAV tracking for top Indian large-cap mutual funds',
    config: {
      schemeCodes: [
        { code: 125497, alias: 'HDFC Top 100 Direct' },
        { code: 120586, alias: 'ICICI Pru Bluechip Direct' },
        { code: 119598, alias: 'SBI BlueChip Direct' },
        { code: 118989, alias: 'HDFC Mid-Cap Direct' },
        { code: 120465, alias: 'Mirae Large Cap Direct' }
      ]
    },
    schedule: '0 18 * * 1-5', // Weekdays 6pm IST (after market close)
    url: 'https://www.mfapi.in/'
  },
  {
    id: 'mfapi-flexi-cap',
    name: 'MFAPI: Flexi/Multi-Cap Funds',
    discipline: 'finint', type: 'mfapi',
    category: 'Indian Mutual Funds',
    description: 'NAV tracking for top Indian flexi-cap and multi-cap funds',
    config: {
      schemeCodes: [
        { code: 122639, alias: 'Parag Parikh Flexi Cap Direct' },
        { code: 120505, alias: 'Kotak Flexicap Direct' },
        { code: 118825, alias: 'HDFC Flexi Cap Direct' },
        { code: 119226, alias: 'Quant Flexi Cap Direct' }
      ]
    },
    schedule: '0 18 * * 1-5',
    url: 'https://www.mfapi.in/'
  },
  {
    id: 'mfapi-debt-funds',
    name: 'MFAPI: Debt & Liquid Funds',
    discipline: 'finint', type: 'mfapi',
    category: 'Indian Mutual Funds',
    description: 'NAV tracking for popular Indian debt and liquid funds',
    config: {
      schemeCodes: [
        { code: 119551, alias: 'HDFC Liquid Direct' },
        { code: 118825, alias: 'ICICI Pru Liquid Direct' },
        { code: 119226, alias: 'SBI Magnum Income Direct' }
      ]
    },
    schedule: '0 18 * * 1-5',
    url: 'https://www.mfapi.in/'
  },

  // ═══════════════════════════════════════════════════════════════
  // ALPACA MARKETS (US Stocks) — requires API key
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'alpaca-stock-snapshots',
    name: 'Alpaca: Stock Snapshots (FAANG+)',
    discipline: 'finint', type: 'api-endpoint',
    category: 'US Stocks (Alpaca)',
    description: 'Latest snapshots for FAANG + key US stocks. Requires Alpaca API key (free at alpaca.markets).',
    config: {
      url: 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA,SPY,QQQ',
      headers: {
        'APCA-API-KEY-ID': 'YOUR_KEY_ID',
        'APCA-API-SECRET-KEY': 'YOUR_SECRET'
      },
      jsonPath: '$.snapshots.*',
      fieldMap: {
        title: 'symbol',
        content: 'latestTrade.p',
        sourceUrl: 'symbol',
        severity: 'dailyBar.c'
      },
      discipline: 'finint',
      defaultSeverity: 'info'
    },
    schedule: '*/15 9-16 * * 1-5', // Every 15min during US market hours
    url: 'https://docs.alpaca.markets/reference/stocksnapshots-1'
  },
  {
    id: 'alpaca-news',
    name: 'Alpaca: Real-time Stock News',
    discipline: 'finint', type: 'api-endpoint',
    category: 'US Stocks (Alpaca)',
    description: 'Latest market news from Benzinga via Alpaca. Requires Alpaca API key.',
    config: {
      url: 'https://data.alpaca.markets/v1beta1/news?limit=20&sort=desc',
      headers: {
        'APCA-API-KEY-ID': 'YOUR_KEY_ID',
        'APCA-API-SECRET-KEY': 'YOUR_SECRET'
      },
      jsonPath: '$.news[*]',
      fieldMap: {
        title: 'headline',
        content: 'summary',
        sourceUrl: 'url',
        timestamp: 'created_at'
      },
      discipline: 'finint',
      defaultSeverity: 'info'
    },
    schedule: '*/15 * * * *',
    url: 'https://docs.alpaca.markets/reference/news-3'
  },
  {
    id: 'alpaca-crypto-snapshots',
    name: 'Alpaca: Crypto Snapshots (BTC/ETH/SOL)',
    discipline: 'finint', type: 'api-endpoint',
    category: 'US Stocks (Alpaca)',
    description: 'Latest crypto snapshots. Requires Alpaca API key.',
    config: {
      url: 'https://data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=BTC%2FUSD,ETH%2FUSD,SOL%2FUSD',
      headers: {
        'APCA-API-KEY-ID': 'YOUR_KEY_ID',
        'APCA-API-SECRET-KEY': 'YOUR_SECRET'
      },
      jsonPath: '$.snapshots.*',
      fieldMap: {
        title: 'symbol',
        content: 'latestTrade.p',
        sourceUrl: 'symbol'
      },
      discipline: 'finint',
      defaultSeverity: 'info'
    },
    schedule: '*/5 * * * *', // Crypto trades 24/7
    url: 'https://docs.alpaca.markets/reference/cryptosnapshots-1'
  }
]

export function getPresetsByCategory(): Record<string, SourcePreset[]> {
  const grouped: Record<string, SourcePreset[]> = {}
  for (const preset of SOURCE_PRESETS) {
    if (!grouped[preset.category]) grouped[preset.category] = []
    grouped[preset.category].push(preset)
  }
  return grouped
}

export function getPresetById(id: string): SourcePreset | undefined {
  return SOURCE_PRESETS.find((p) => p.id === id)
}
