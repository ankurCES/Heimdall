// Premium OSINT integrations — registered as agent-callable tools.
//
// Each connector reads its API key from the settings store (encrypted at
// rest; settings.osint.<provider>.apiKey). Free tiers are documented per
// provider; the connector returns a helpful error if no key is set.
//
// The set is intentionally focused on cyber threat intelligence — IPs,
// domains, file hashes, URLs, exposed services, breached credentials.
// Geospatial / financial OSINT goes in a separate module.

import { safeFetcher } from '../../collectors/SafeFetcher'
import { settingsService } from '../settings/SettingsService'
import { toolRegistry, type ToolResult } from '../tools/ToolRegistry'
import log from 'electron-log'

interface OsintApiKeys {
  shodan?: string
  virustotal?: string
  greynoise?: string
  abuseipdb?: string
  hibp?: string
  urlscan?: string
  ipinfo?: string
}

// Reads keys from the flat `apikeys.<service>` slots used by ApiKeysTab
// (each one stored individually so safeStorage can encrypt it on disk).
// Falls back to the legacy nested `osint.apiKeys.<provider>` object so
// existing installs keep working after the v1.4.1 schema reconciliation.
function getKeys(): OsintApiKeys {
  const legacy = settingsService.get<OsintApiKeys>('osint.apiKeys') || {}
  const pick = (svc: keyof OsintApiKeys): string | undefined => {
    const flat = settingsService.get<string>(`apikeys.${svc}`)
    return (flat && flat.trim()) || legacy[svc]
  }
  return {
    shodan: pick('shodan'),
    virustotal: pick('virustotal'),
    greynoise: pick('greynoise'),
    abuseipdb: pick('abuseipdb'),
    hibp: pick('hibp'),
    urlscan: pick('urlscan'),
    ipinfo: pick('ipinfo')
  }
}

function noKeyResult(provider: string, signupUrl: string): ToolResult {
  return {
    output: `${provider} API key not configured. Add one in Settings → API Keys → OSINT (free tier sign-up: ${signupUrl}).`,
    error: 'NO_API_KEY'
  }
}

/** Register all premium OSINT tools into the existing ToolRegistry. */
export function registerPremiumOsintTools(): void {
  // ── Shodan: host lookup ────────────────────────────────────────────
  toolRegistry.register({
    name: 'shodan_host',
    description: 'Look up an IP address in Shodan: open ports, services, banners, hostnames, ASN, geolocation, vulnerabilities. Requires a Shodan API key.',
    parameters: { type: 'object', properties: {
      ip: { type: 'string', description: 'IPv4 or IPv6 address' }
    }, required: ['ip'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().shodan
    if (!key) return noKeyResult('Shodan', 'https://account.shodan.io/register')
    try {
      const data = await safeFetcher.fetchJson<{
        ip_str: string; hostnames: string[]; ports: number[]; org?: string;
        country_name?: string; city?: string; asn?: string; os?: string;
        vulns?: string[]; data?: Array<{ port: number; product?: string; version?: string; transport?: string }>
      }>(`https://api.shodan.io/shodan/host/${params.ip}?key=${key}`)
      const summary = [
        `IP: ${data.ip_str}`,
        `Hostnames: ${(data.hostnames || []).join(', ') || '—'}`,
        `Org: ${data.org || '—'} · ${data.asn || '—'}`,
        `Location: ${data.city || '—'}, ${data.country_name || '—'}`,
        `OS: ${data.os || '—'}`,
        `Open ports: ${(data.ports || []).join(', ')}`,
        data.vulns ? `Vulnerabilities: ${data.vulns.slice(0, 10).join(', ')}` : '',
        '',
        'Services:',
        ...(data.data || []).slice(0, 10).map((s) => `  ${s.transport || 'tcp'}/${s.port} — ${s.product || ''} ${s.version || ''}`.trim())
      ].filter(Boolean).join('\n')
      return { output: summary, data }
    } catch (err) {
      return { output: `Shodan error: ${(err as Error).message}`, error: 'SHODAN_ERROR' }
    }
  })

  // ── VirusTotal: URL lookup ─────────────────────────────────────────
  toolRegistry.register({
    name: 'virustotal_url',
    description: 'Look up a URL in VirusTotal: AV-engine verdicts, categories, last-analyzed date. Requires a VirusTotal API key (free tier: 4 lookups/min).',
    parameters: { type: 'object', properties: {
      url: { type: 'string', description: 'URL to check' }
    }, required: ['url'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().virustotal
    if (!key) return noKeyResult('VirusTotal', 'https://www.virustotal.com/gui/join-us')
    try {
      const url = params.url as string
      const id = Buffer.from(url).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')
      const resp = await fetch(`https://www.virustotal.com/api/v3/urls/${id}`, {
        headers: { 'x-apikey': key }
      })
      if (resp.status === 404) return { output: `URL not yet analysed by VirusTotal. Submit it via virustotal_submit_url.` }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as { data: { attributes: {
        last_analysis_stats: { harmless: number; malicious: number; suspicious: number; undetected: number };
        last_analysis_date: number; categories?: Record<string, string>; reputation: number
      } } }
      const stats = data.data.attributes.last_analysis_stats
      return {
        output: `VirusTotal · ${url}\nMalicious: ${stats.malicious} · Suspicious: ${stats.suspicious} · Harmless: ${stats.harmless} · Undetected: ${stats.undetected}\nReputation: ${data.data.attributes.reputation}\nLast analysed: ${new Date(data.data.attributes.last_analysis_date * 1000).toISOString()}`,
        data
      }
    } catch (err) {
      return { output: `VirusTotal error: ${(err as Error).message}`, error: 'VT_ERROR' }
    }
  })

  // ── VirusTotal: file hash lookup ───────────────────────────────────
  toolRegistry.register({
    name: 'virustotal_hash',
    description: 'Look up a file hash (MD5/SHA1/SHA256) in VirusTotal. Requires a VirusTotal API key.',
    parameters: { type: 'object', properties: {
      hash: { type: 'string', description: 'MD5, SHA1, or SHA256 hash' }
    }, required: ['hash'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().virustotal
    if (!key) return noKeyResult('VirusTotal', 'https://www.virustotal.com/gui/join-us')
    try {
      const resp = await fetch(`https://www.virustotal.com/api/v3/files/${params.hash}`, {
        headers: { 'x-apikey': key }
      })
      if (resp.status === 404) return { output: `File hash not in VirusTotal corpus.` }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as { data: { attributes: {
        meaningful_name?: string; type_description?: string; size?: number;
        last_analysis_stats: { harmless: number; malicious: number; suspicious: number; undetected: number };
        first_submission_date?: number; reputation: number;
        popular_threat_classification?: { suggested_threat_label?: string }
      } } }
      const a = data.data.attributes
      const stats = a.last_analysis_stats
      return {
        output: `VirusTotal · ${params.hash}\nName: ${a.meaningful_name || '—'} · Type: ${a.type_description || '—'} · Size: ${a.size || '?'}b\nMalicious: ${stats.malicious} · Suspicious: ${stats.suspicious} · Undetected: ${stats.undetected}\nThreat label: ${a.popular_threat_classification?.suggested_threat_label || '—'}\nFirst seen: ${a.first_submission_date ? new Date(a.first_submission_date * 1000).toISOString() : '—'}`,
        data
      }
    } catch (err) {
      return { output: `VirusTotal error: ${(err as Error).message}`, error: 'VT_ERROR' }
    }
  })

  // ── GreyNoise: IP context ──────────────────────────────────────────
  toolRegistry.register({
    name: 'greynoise_ip',
    description: 'Check if an IP is part of internet background noise (mass scanners, benign crawlers, malicious actors). Free tier via the Community API. Returns classification: malicious | benign | unknown.',
    parameters: { type: 'object', properties: {
      ip: { type: 'string', description: 'IPv4 address' }
    }, required: ['ip'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().greynoise
    try {
      const resp = await fetch(`https://api.greynoise.io/v3/community/${params.ip}`, {
        headers: key ? { 'key': key } : {}
      })
      if (!resp.ok) {
        if (resp.status === 404) return { output: `${params.ip}: not seen in GreyNoise (no scan/probe activity observed).` }
        throw new Error(`HTTP ${resp.status}`)
      }
      const data = await resp.json() as {
        ip: string; noise: boolean; riot: boolean; classification?: string;
        name?: string; link?: string; last_seen?: string; message?: string
      }
      return {
        output: `GreyNoise · ${data.ip}\nClassification: ${data.classification || 'unknown'}\nNoise (mass scanner): ${data.noise ? 'YES' : 'no'} · RIOT (known business): ${data.riot ? 'YES' : 'no'}\nName: ${data.name || '—'} · Last seen: ${data.last_seen || '—'}\n${data.link || ''}`,
        data
      }
    } catch (err) {
      return { output: `GreyNoise error: ${(err as Error).message}`, error: 'GN_ERROR' }
    }
  })

  // ── AbuseIPDB: IP reputation ───────────────────────────────────────
  toolRegistry.register({
    name: 'abuseipdb_ip',
    description: 'Check an IP against AbuseIPDB community blocklist: confidence-of-abuse score, total reports, country. Requires an AbuseIPDB API key (free tier: 1000 lookups/day).',
    parameters: { type: 'object', properties: {
      ip: { type: 'string', description: 'IPv4 or IPv6 address' },
      maxAgeDays: { type: 'number', description: 'Look-back window (default 90)' }
    }, required: ['ip'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().abuseipdb
    if (!key) return noKeyResult('AbuseIPDB', 'https://www.abuseipdb.com/register')
    try {
      const maxAge = (params.maxAgeDays as number) || 90
      const resp = await fetch(`https://api.abuseipdb.com/api/v2/check?ipAddress=${params.ip}&maxAgeInDays=${maxAge}&verbose=true`, {
        headers: { 'Key': key, 'Accept': 'application/json' }
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as { data: {
        ipAddress: string; abuseConfidenceScore: number; totalReports: number;
        numDistinctUsers: number; lastReportedAt?: string;
        countryCode?: string; isp?: string; domain?: string;
        reports?: Array<{ comment: string; categories: number[]; reportedAt: string }>
      } }
      const d = data.data
      const sample = (d.reports || []).slice(0, 3).map((r) => `  · ${r.reportedAt.slice(0, 10)}: ${r.comment.slice(0, 100)}`).join('\n')
      return {
        output: `AbuseIPDB · ${d.ipAddress}\nAbuse confidence: ${d.abuseConfidenceScore}% · Reports: ${d.totalReports} (from ${d.numDistinctUsers} reporters)\nCountry: ${d.countryCode || '—'} · ISP: ${d.isp || '—'} · Domain: ${d.domain || '—'}\nLast reported: ${d.lastReportedAt || '—'}\n${sample ? '\nRecent reports:\n' + sample : ''}`,
        data
      }
    } catch (err) {
      return { output: `AbuseIPDB error: ${(err as Error).message}`, error: 'ABUSEIPDB_ERROR' }
    }
  })

  // ── HIBP: email pwned check ────────────────────────────────────────
  toolRegistry.register({
    name: 'hibp_email',
    description: 'Check whether an email address has appeared in known data breaches via Have I Been Pwned. Requires a HIBP API key (paid: $3.95/mo).',
    parameters: { type: 'object', properties: {
      email: { type: 'string', description: 'Email address' }
    }, required: ['email'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().hibp
    if (!key) return noKeyResult('Have I Been Pwned', 'https://haveibeenpwned.com/API/Key')
    try {
      const email = encodeURIComponent(params.email as string)
      const resp = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${email}?truncateResponse=false`, {
        headers: { 'hibp-api-key': key, 'user-agent': 'Heimdall-Intelligence-Platform' }
      })
      if (resp.status === 404) return { output: `${params.email}: not in any known breach.` }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const breaches = await resp.json() as Array<{
        Name: string; Domain: string; BreachDate: string; PwnCount: number;
        Description: string; DataClasses: string[]; IsVerified: boolean
      }>
      const summary = [
        `${params.email} appears in ${breaches.length} breach${breaches.length === 1 ? '' : 'es'}:`,
        ...breaches.slice(0, 10).map((b) =>
          `  · ${b.BreachDate} — ${b.Name} (${b.Domain || '?'}) — ${b.PwnCount.toLocaleString()} accounts; data: ${b.DataClasses.slice(0, 5).join(', ')}`
        )
      ].join('\n')
      return { output: summary, data: breaches }
    } catch (err) {
      return { output: `HIBP error: ${(err as Error).message}`, error: 'HIBP_ERROR' }
    }
  })

  // ── urlscan.io: submit a URL for analysis ──────────────────────────
  toolRegistry.register({
    name: 'urlscan_search',
    description: 'Search urlscan.io for previously-analysed scans of a URL or domain. Returns recent scans with screenshots and verdicts. Free tier: 100/day.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'urlscan search query (URL, domain, hash, IP, ASN…)' }
    }, required: ['query'] },
    requiresApproval: false
  }, async (params) => {
    const key = getKeys().urlscan
    try {
      const q = encodeURIComponent(params.query as string)
      const resp = await fetch(`https://urlscan.io/api/v1/search/?q=${q}&size=10`, {
        headers: key ? { 'API-Key': key } : {}
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json() as { results: Array<{
        task: { url: string; time: string; uuid: string };
        page?: { url: string; ip?: string; country?: string; server?: string };
        verdicts?: { overall?: { malicious?: boolean; score?: number } };
        result?: string
      }> }
      const summary = [
        `urlscan: ${data.results.length} result(s) for "${params.query}"`,
        ...data.results.slice(0, 10).map((r) =>
          `  · ${r.task.time.slice(0, 10)} — ${r.task.url.slice(0, 80)} → ${r.page?.ip || '?'} (${r.page?.country || '?'}) ${r.verdicts?.overall?.malicious ? '⚠ malicious' : ''} ${r.result ? '\n    ' + r.result : ''}`
        )
      ].join('\n')
      return { output: summary, data }
    } catch (err) {
      return { output: `urlscan error: ${(err as Error).message}`, error: 'URLSCAN_ERROR' }
    }
  })

  log.info('Premium OSINT tools registered (shodan, virustotal_url/hash, greynoise, abuseipdb, hibp, urlscan)')
}
