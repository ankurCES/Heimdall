/**
 * Intel-domain synonym dictionary for query expansion.
 *
 * Each entry maps a root token → list of substitutable terms (incl. the root).
 * The QueryPlanner expands a short query like "weapon attack" into:
 *
 *   (weapon* OR weapons OR armament* OR ordnance OR munition*)
 *   OR (attack* OR strike* OR raid* OR offensive OR assault*)
 *
 * Conservative on purpose:
 *   - Only expand when the original query is short (≤4 substantive tokens).
 *     Long queries already have enough signal — expansion adds noise.
 *   - Keys are stems, not full forms. Lookup is case-insensitive after
 *     stop-word removal.
 *   - Synonyms get the FTS5 `*` prefix-match suffix at expansion time so
 *     "weapon" → "weapon*" matches "weapons", "weaponize", "weaponry".
 *   - Avoid expansions that change polarity ("attack" expanding to
 *     "defence" would hurt, not help).
 */
export const SYNONYMS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  // Kinetic / military
  ['weapon',     ['weapon', 'weapons', 'armament', 'ordnance', 'munition']],
  ['attack',     ['attack', 'strike', 'raid', 'offensive', 'assault', 'incursion']],
  ['missile',    ['missile', 'rocket', 'projectile', 'ballistic']],
  ['drone',      ['drone', 'uav', 'uas', 'quadcopter']],
  ['military',   ['military', 'armed', 'forces', 'troops', 'soldiers']],
  ['conflict',   ['conflict', 'war', 'warfare', 'hostilities', 'combat']],
  ['terror',     ['terror', 'terrorism', 'terrorist', 'extremist', 'jihadist']],

  // Cyber
  ['cyber',      ['cyber', 'cybersecurity', 'cybersec']],
  ['breach',     ['breach', 'compromise', 'intrusion', 'incident']],
  ['malware',    ['malware', 'ransomware', 'trojan', 'rootkit', 'spyware', 'worm']],
  ['vulnerability', ['vulnerability', 'cve', 'exploit', 'flaw', 'weakness']],
  ['phishing',   ['phishing', 'spearphishing', 'smishing', 'vishing']],
  ['leak',       ['leak', 'leaked', 'exposed', 'dump', 'disclosed']],
  ['credential', ['credential', 'credentials', 'password', 'token', 'apikey']],
  ['actor',      ['actor', 'apt', 'threat-actor', 'group', 'gang']],
  ['ransomware', ['ransomware', 'extortion', 'cryptolocker']],

  // Geopolitical
  ['sanction',   ['sanction', 'sanctions', 'embargo', 'restrictions']],
  ['negotiate',  ['negotiate', 'negotiation', 'talks', 'dialogue', 'diplomacy']],
  ['nuclear',    ['nuclear', 'atomic', 'fission', 'enrichment', 'weaponization']],
  ['election',   ['election', 'vote', 'ballot', 'referendum', 'poll']],
  ['protest',    ['protest', 'demonstration', 'rally', 'unrest', 'uprising']],
  ['coup',       ['coup', 'putsch', 'overthrow', 'mutiny']],
  ['refugee',    ['refugee', 'migrant', 'displacement', 'asylum']],
  ['border',     ['border', 'frontier', 'boundary', 'crossing']],

  // Financial / disinfo
  ['fraud',      ['fraud', 'scam', 'embezzlement', 'laundering']],
  ['crypto',     ['crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'stablecoin']],
  ['market',     ['market', 'stock', 'equity', 'trading']],
  ['disinfo',    ['disinfo', 'disinformation', 'misinformation', 'propaganda', 'fake-news']],

  // Generic intel verbs
  ['monitor',    ['monitor', 'surveillance', 'watch', 'track', 'observe']],
  ['intercept',  ['intercept', 'sigint', 'wiretap', 'eavesdrop']],
  ['recruit',    ['recruit', 'recruitment', 'enlistment', 'mobilization']],
  ['train',      ['train', 'training', 'exercise', 'drill']],
  ['supply',     ['supply', 'logistics', 'shipment', 'delivery']],

  // Disaster / crisis
  ['flood',      ['flood', 'flooding', 'inundation']],
  ['fire',       ['fire', 'wildfire', 'blaze']],
  ['earthquake', ['earthquake', 'seismic', 'quake', 'tremor']],
  ['storm',      ['storm', 'hurricane', 'typhoon', 'cyclone']],
  ['outbreak',   ['outbreak', 'epidemic', 'pandemic', 'contagion']]
])

/** Lookup synonyms for a token. Returns an empty array if no entry exists. */
export function getSynonyms(token: string): ReadonlyArray<string> {
  return SYNONYMS.get(token.toLowerCase()) ?? []
}

/**
 * Expand a list of tokens with synonyms, returning a list of OR-groups
 * suitable for FTS5. Each group is the union of (token, *its synonyms*).
 *
 *   ['weapon', 'iran'] → [['weapon', 'weapons', 'armament', ...], ['iran']]
 *
 * No-op for tokens with no entry — they pass through as a single-element group.
 * Caller is responsible for FTS5 escaping + prefix-matching of the output.
 */
export function expandSynonyms(tokens: string[]): string[][] {
  return tokens.map((t) => {
    const syns = getSynonyms(t)
    return syns.length > 0 ? [...syns] : [t]
  })
}
