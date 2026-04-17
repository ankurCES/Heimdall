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
  { category: 'geopolitical', query: 'sanctions evasion', description: 'Sanctioned-entity dark-web activity' }
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
