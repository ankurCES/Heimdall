/**
 * Curated default dark-web seed queries.
 *
 * These are the FIRST seeds inserted on a fresh install. The analyst can
 * disable any of them, edit them, or add custom seeds + categories via
 * the Dark Web Explorer page.
 *
 * **POLICY: NO CSAM** — child-exploitation content is explicitly excluded.
 * Heimdall has a CSAM SHA-256 blocklist (SafeFetcher.csamBlocklist) and
 * the platform's safety stance is "discover via reporting workflows,
 * never crawl". Any seed that could surface CSAM-adjacent content is
 * rejected at submission time by the SeedService denylist scan.
 *
 * The categories are intentionally broad — analysts will add their own
 * via the UI for theatre-specific monitoring (e.g. "balkans-arms",
 * "south-china-sea-cyber").
 */

export interface DefaultSeed {
  category: string
  query: string
  description: string
}

export const DEFAULT_DARKWEB_SEEDS: ReadonlyArray<DefaultSeed> = [
  // ── Cybercrime ──
  { category: 'cybercrime', query: 'ransomware victim leak', description: 'Active ransomware group leak sites' },
  { category: 'cybercrime', query: 'credential dump database', description: 'Compromised account dumps' },
  { category: 'cybercrime', query: 'zero day exploit sale', description: 'Brokers selling 0-day vulns' },
  { category: 'cybercrime', query: 'malware as a service', description: 'MaaS panels and rentals' },
  { category: 'cybercrime', query: 'stolen credit cards', description: 'Carding shops + dumps' },
  { category: 'cybercrime', query: 'bank logs sale', description: 'Compromised banking sessions / cookies' },
  { category: 'cybercrime', query: 'phishing kit', description: 'Phishing-as-a-service kits' },

  // ── Financial fraud ──
  { category: 'financial-fraud', query: 'carding forum', description: 'Forums for stolen-card trading' },
  { category: 'financial-fraud', query: 'money laundering service', description: 'Mixing + cash-out operators' },
  { category: 'financial-fraud', query: 'cryptocurrency mixer', description: 'BTC / ETH mixers + tumblers' },
  { category: 'financial-fraud', query: 'stolen identity', description: 'Full identity packages (fullz)' },
  { category: 'financial-fraud', query: 'fake bank statements', description: 'KYC-bypass document services' },

  // ── Marketplaces (illicit goods) ──
  { category: 'marketplace', query: 'drug marketplace', description: 'Illicit substance vendors' },
  { category: 'marketplace', query: 'counterfeit currency', description: 'Fake-bill vendors' },
  { category: 'marketplace', query: 'fake passport', description: 'Counterfeit travel-document vendors' },
  { category: 'marketplace', query: 'weapons forum', description: 'Illicit arms-trade discussion' },

  // ── Trafficking (CSAM excluded by policy) ──
  { category: 'trafficking', query: 'human trafficking', description: 'Labour / migrant smuggling discussion' },

  // ── Threat actors ──
  { category: 'threat-actor', query: 'LockBit leak', description: 'LockBit ransomware activity' },
  { category: 'threat-actor', query: 'ALPHV BlackCat', description: 'ALPHV / BlackCat ransomware' },
  { category: 'threat-actor', query: 'Conti ransomware blog', description: 'Conti successor groups' },
  { category: 'threat-actor', query: 'Clop dump', description: 'Clop / Cl0p ransomware leaks' },
  { category: 'threat-actor', query: 'Akira leak site', description: 'Akira ransomware activity' },
  { category: 'threat-actor', query: 'Black Basta victim', description: 'Black Basta extortion posts' },
  { category: 'threat-actor', query: 'Royal ransomware', description: 'Royal / BlackSuit activity' },
  { category: 'threat-actor', query: 'Medusa leak', description: 'Medusa ransomware leaks' },
  { category: 'threat-actor', query: 'BianLian extortion', description: 'BianLian double-extortion' },

  // ── Geopolitical / conflict intelligence ──
  { category: 'geopolitical', query: 'hostage video', description: 'Conflict-zone hostage propaganda' },
  { category: 'geopolitical', query: 'extremist propaganda', description: 'Extremist recruitment / propaganda' },
  { category: 'geopolitical', query: 'war crime documentation', description: 'Conflict accountability content' },
  { category: 'geopolitical', query: 'sanctions evasion', description: 'Sanctioned-entity dark-web activity' },

  // ─────────────────────────────────────────────────────────────────
  // v1.4 — Expanded coverage. Brings the total seed count from 30 to
  // 100+ across the original six categories plus four new ones:
  // initial-access-broker, supply-chain, espionage, infrastructure.
  // ─────────────────────────────────────────────────────────────────

  // ── Cybercrime expansion ──
  { category: 'cybercrime', query: 'fortinet vpn access', description: 'Stolen Fortinet/Cisco SSL VPN credentials' },
  { category: 'cybercrime', query: 'cookie theft session hijack', description: 'Browser session-cookie marketplaces' },
  { category: 'cybercrime', query: 'cracked rdp access', description: 'Compromised RDP endpoints' },
  { category: 'cybercrime', query: 'webshell deployed', description: 'Pre-installed webshells for sale' },
  { category: 'cybercrime', query: 'mfa bypass otp grabber', description: 'OTP-interception kits / SIM-swap services' },
  { category: 'cybercrime', query: 'browser extension malware', description: 'Malicious-extension-as-a-service' },
  { category: 'cybercrime', query: 'supply chain compromise', description: 'NPM/PyPI/registry attack chatter' },
  { category: 'cybercrime', query: 'cryptocurrency wallet drainer', description: 'Wallet-drainer kits + affiliate programs' },
  { category: 'cybercrime', query: 'github token leak', description: 'Stolen GitHub PATs and SSH keys' },
  { category: 'cybercrime', query: 'aws access key dump', description: 'Cloud-credential dumps' },

  // ── Financial-fraud expansion ──
  { category: 'financial-fraud', query: 'business email compromise kit', description: 'BEC playbooks + lookalike domain services' },
  { category: 'financial-fraud', query: 'bank account takeover', description: 'ATO services + verified mules' },
  { category: 'financial-fraud', query: 'crypto p2p washing', description: 'P2P-exchange laundering networks' },
  { category: 'financial-fraud', query: 'gift card fraud bulk', description: 'Stolen gift-card resale' },
  { category: 'financial-fraud', query: 'pix fraud brazil', description: 'Brazilian PIX instant-payment fraud' },
  { category: 'financial-fraud', query: 'invoice fraud wire transfer', description: 'Wire-transfer interception services' },

  // ── Marketplace expansion ──
  { category: 'marketplace', query: 'firearm parts kit', description: 'Untraceable firearm component shops' },
  { category: 'marketplace', query: 'precursor chemical', description: 'Chemical-precursor vendors' },
  { category: 'marketplace', query: 'ghost gun blueprint', description: '3D-printed firearm files' },
  { category: 'marketplace', query: 'stolen vehicle vin', description: 'VIN-cloning services' },
  { category: 'marketplace', query: 'fake covid vaccine certificate', description: 'Counterfeit health-credential vendors' },

  // ── Threat-actor expansion (active groups Q1 2026) ──
  { category: 'threat-actor', query: 'INC ransom data leak', description: 'INC Ransom leak site' },
  { category: 'threat-actor', query: 'Qilin extortion blog', description: 'Qilin / Agenda affiliate program' },
  { category: 'threat-actor', query: 'Cactus ransomware', description: 'Cactus group leak site' },
  { category: 'threat-actor', query: 'NoName ddos campaign', description: 'NoName057 hacktivist DDoS targets' },
  { category: 'threat-actor', query: 'Killnet operation', description: 'Killnet operations chatter' },
  { category: 'threat-actor', query: 'Anonymous Sudan', description: 'Anonymous Sudan target list' },
  { category: 'threat-actor', query: 'ScatteredSpider sim swap', description: 'Scattered Spider / Octo Tempest activity' },
  { category: 'threat-actor', query: 'FIN7 targeting retail', description: 'FIN7 financially-motivated activity' },
  { category: 'threat-actor', query: 'APT28 fancy bear', description: 'GRU 26165 targeting' },
  { category: 'threat-actor', query: 'APT29 cozy bear svr', description: 'SVR-attributed activity' },

  // ── Geopolitical expansion ──
  { category: 'geopolitical', query: 'iran nuclear procurement', description: 'Iranian dual-use procurement chatter' },
  { category: 'geopolitical', query: 'north korea cryptocurrency theft', description: 'DPRK Lazarus crypto theft' },
  { category: 'geopolitical', query: 'china taiwan invasion preparation', description: 'PLA preparedness signaling' },
  { category: 'geopolitical', query: 'russia ukraine prisoner war', description: 'POW exchange / treatment reporting' },
  { category: 'geopolitical', query: 'wagner africa operation', description: 'Wagner / Africa Corps activity' },
  { category: 'geopolitical', query: 'belarus migrant border', description: 'Belarus weaponized-migration ops' },
  { category: 'geopolitical', query: 'venezuela colombia border', description: 'Venezuela-Colombia border flashpoint' },
  { category: 'geopolitical', query: 'red sea houthi shipping', description: 'Houthi maritime targeting' },

  // ── Trafficking / public-safety ──
  { category: 'trafficking', query: 'human smuggling route', description: 'Migrant-smuggling logistics' },
  { category: 'trafficking', query: 'organ trafficking network', description: 'Illicit organ-trade indicators' },
  { category: 'trafficking', query: 'wildlife rhino horn ivory', description: 'Endangered-species trade' },
  { category: 'trafficking', query: 'fentanyl precursor china', description: 'Fentanyl precursor trade routes' },

  // ── NEW CATEGORY: Initial Access Brokers ──
  { category: 'initial-access-broker', query: 'corporate vpn access for sale', description: 'IAB listings — corporate VPN' },
  { category: 'initial-access-broker', query: 'fortune 500 access for sale', description: 'High-value enterprise initial access' },
  { category: 'initial-access-broker', query: 'government access for sale', description: 'Government / .gov access listings (HIGH PRIORITY)' },
  { category: 'initial-access-broker', query: 'critical infrastructure access', description: 'CI/utility/SCADA access listings (HIGH PRIORITY)' },
  { category: 'initial-access-broker', query: 'managed service provider compromise', description: 'MSP supply-chain entry points' },

  // ── NEW CATEGORY: Supply Chain ──
  { category: 'supply-chain', query: 'npm package backdoor', description: 'NPM supply-chain attacks' },
  { category: 'supply-chain', query: 'pypi malicious package', description: 'PyPI malicious uploads' },
  { category: 'supply-chain', query: 'docker image trojanized', description: 'Trojanized container images' },
  { category: 'supply-chain', query: 'github action compromised', description: 'CI/CD pipeline attacks' },

  // ── NEW CATEGORY: Espionage / state-sponsored ──
  { category: 'espionage', query: 'leaked diplomatic cable', description: 'Leaked diplomatic communications' },
  { category: 'espionage', query: 'classified document dump', description: 'Classified-document publication' },
  { category: 'espionage', query: 'industrial espionage trade secret', description: 'Trade-secret theft listings' },
  { category: 'espionage', query: 'defense contractor breach', description: 'DIB compromises' },

  // ── NEW CATEGORY: Infrastructure / OPSEC ──
  { category: 'infrastructure', query: 'bulletproof hosting offshore', description: 'Bulletproof hosting providers' },
  { category: 'infrastructure', query: 'residential proxy network', description: 'Residential-proxy / IP-rental networks' },
  { category: 'infrastructure', query: 'sim card farm rental', description: 'SIM-farm services for SMS verification' },
  { category: 'infrastructure', query: 'voip number rental anonymous', description: 'Anonymous VoIP / DID rental' },
  { category: 'infrastructure', query: 'tor exit node operator', description: 'Tor exit-node operator chatter' }
]

/**
 * CSAM-related lexicon for the seed-submission denylist scan. Custom
 * seeds containing any of these tokens are rejected with an audit log
 * entry. Conservative — false positives are acceptable here, false
 * negatives are not. List intentionally not exhaustive — combined with
 * SafeFetcher's hash-based CSAM hostname blocklist for defense in depth.
 */
export const CSAM_DENYLIST_TOKENS: ReadonlyArray<string> = [
  'csam', 'cp', 'cheese pizza', 'preteen', 'pre-teen', 'underage',
  'minor abuse', 'child abuse', 'child porn', 'chld', 'lolita',
  'jailbait', 'pthc', 'kdv', 'ptsc'
]

/**
 * Returns true if `query` matches any CSAM-related token. Case-insensitive
 * whole-word match (with hyphenation tolerated). Intentionally broad — the
 * cost of false-positives is rejecting legitimate searches; the cost of
 * a miss is far worse.
 */
export function matchesCsamDenylist(query: string): boolean {
  const lower = query.toLowerCase().replace(/[-_]+/g, ' ')
  for (const token of CSAM_DENYLIST_TOKENS) {
    const normalised = token.toLowerCase().replace(/[-_]+/g, ' ')
    if (lower === normalised) return true
    // Whole-word match
    const re = new RegExp(`\\b${normalised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(lower)) return true
  }
  return false
}
