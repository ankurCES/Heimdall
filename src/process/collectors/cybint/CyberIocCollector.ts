import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel } from '@common/types/intel'
import log from 'electron-log'

// Multi-source Cyber Threat IOC Aggregator
// Sources: Feodo Tracker (abuse.ch), Ransomware.live, C2IntelFeeds
// All free, no auth required

export class CyberIocCollector extends BaseCollector {
  readonly discipline = 'cybint' as const
  readonly type = 'cyber-ioc'

  async collect(): Promise<IntelReport[]> {
    const reports: IntelReport[] = []

    await Promise.allSettled([
      this.collectFeodo(reports),
      this.collectRansomware(reports),
      this.collectC2Intel(reports)
    ])

    log.info(`Cyber IOCs: ${reports.length} threat indicators`)
    return reports
  }

  // Feodo Tracker — C2 botnet infrastructure (abuse.ch)
  // Use direct fetch — abuse.ch blocks via robots.txt
  private async collectFeodo(reports: IntelReport[]): Promise<void> {
    try {
      const resp = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.txt', {
        headers: { 'User-Agent': 'Heimdall/0.1.0' }, signal: AbortSignal.timeout(15000)
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()

      const ips = text.split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .slice(0, 30)

      if (ips.length === 0) return

      // Also get the detailed JSON feed for enrichment
      let detailedMap = new Map<string, { malware: string; port: number; first_seen: string; last_online: string }>()
      try {
        const response = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist.json', {
          headers: { 'User-Agent': 'Heimdall/0.1.0' }, signal: AbortSignal.timeout(15000)
        })
        const jsonData = await response.json() as Array<{
          ip_address: string; port: number; status: string
          hostname: string | null; as_number: number; as_name: string
          country: string; first_seen: string; last_online: string
        }>
        for (const entry of jsonData) {
          detailedMap.set(entry.ip_address, {
            malware: entry.as_name || 'Unknown',
            port: entry.port,
            first_seen: entry.first_seen,
            last_online: entry.last_online
          })
        }
      } catch {}

      // Group IPs into batches for reports (5 per report to avoid flooding)
      for (let i = 0; i < ips.length; i += 5) {
        const batch = ips.slice(i, i + 5)
        const details = batch.map((ip) => {
          const d = detailedMap.get(ip.trim())
          return d
            ? `- \`${ip.trim()}\` (port ${d.port}, ASN: ${d.malware}, last: ${d.last_online})`
            : `- \`${ip.trim()}\``
        }).join('\n')

        reports.push(this.createReport({
          title: `Feodo C2 Servers: ${batch.length} active botnet IPs`,
          content: `**Source**: Feodo Tracker (abuse.ch)\n**Type**: C2 Command & Control Servers\n**Threat**: Botnet infrastructure used for banking trojans (Dridex, Emotet, TrickBot, QakBot)\n\n**Active C2 IPs**:\n${details}\n\n_Block these IPs at network perimeter. Active C2 servers enable credential theft and ransomware deployment._`,
          severity: 'high',
          sourceUrl: 'https://feodotracker.abuse.ch/blocklist/',
          sourceName: 'Feodo Tracker',
          verificationScore: 90
        }))
      }

      log.debug(`Feodo: ${ips.length} C2 IPs`)
    } catch (err) {
      log.debug(`Feodo collection failed: ${err}`)
    }
  }

  // Ransomware.live — Active ransomware victim reporting
  private async collectRansomware(reports: IntelReport[]): Promise<void> {
    try {
      // Try multiple Ransomware.live API endpoints (they change frequently)
      let data: Array<{
        post_title: string; group_name: string; discovered: string
        description: string; website: string; post_url: string
        country: string; activity: string
      }> | null = null

      for (const url of [
        'https://api.ransomware.live/v2/recentvictims',
        'https://api.ransomware.live/recentvictims',
        'https://data.ransomware.live/victims.json'
      ]) {
        try {
          data = await this.fetchJson(url, { timeout: 15000 })
          if (data && Array.isArray(data)) break
        } catch { data = null }
      }

      if (!data || !Array.isArray(data)) return

      // Take latest 20 victims
      for (const victim of data.slice(0, 20)) {
        const severity: ThreatLevel = victim.activity === 'DLS' ? 'critical' : 'high'

        reports.push(this.createReport({
          title: `Ransomware: ${victim.group_name} — ${victim.post_title}`,
          content: `**Ransomware Group**: ${victim.group_name}\n**Victim**: ${victim.post_title}\n**Country**: ${victim.country || 'Unknown'}\n**Discovered**: ${victim.discovered}\n**Website**: ${victim.website || 'N/A'}\n**Activity**: ${victim.activity}\n\n${victim.description || 'No description available'}`,
          severity,
          sourceUrl: victim.post_url || 'https://www.ransomware.live/',
          sourceName: 'Ransomware.live',
          verificationScore: 85
        }))
      }

      log.debug(`Ransomware.live: ${data.length} recent victims`)
    } catch (err) {
      log.debug(`Ransomware.live failed: ${err}`)
    }
  }

  // C2IntelFeeds — Community-sourced C2 indicators
  private async collectC2Intel(reports: IntelReport[]): Promise<void> {
    try {
      const resp = await fetch('https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv', {
        headers: { 'User-Agent': 'Heimdall/0.1.0' }, signal: AbortSignal.timeout(15000)
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()

      const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('ip'))
      if (lines.length === 0) return

      // Take latest 20 C2 IPs
      const entries = lines.slice(0, 20).map((line) => {
        const parts = line.split(',')
        return { ip: parts[0]?.trim(), port: parts[1]?.trim(), family: parts[2]?.trim() || 'Unknown' }
      }).filter((e) => e.ip)

      // Group by malware family
      const families = new Map<string, string[]>()
      for (const e of entries) {
        if (!families.has(e.family)) families.set(e.family, [])
        families.get(e.family)!.push(`${e.ip}:${e.port}`)
      }

      for (const [family, ips] of families) {
        reports.push(this.createReport({
          title: `C2 Intel: ${family} — ${ips.length} servers (30-day)`,
          content: `**Malware Family**: ${family}\n**C2 Servers**: ${ips.length}\n**Source**: C2IntelFeeds (community)\n**Period**: Last 30 days\n\n**IPs**:\n${ips.map((ip) => `- \`${ip}\``).join('\n')}\n\n_C2 infrastructure actively communicating with infected hosts._`,
          severity: 'medium',
          sourceUrl: 'https://github.com/drb-ra/C2IntelFeeds',
          sourceName: 'C2IntelFeeds',
          verificationScore: 75
        }))
      }

      log.debug(`C2IntelFeeds: ${entries.length} IPs across ${families.size} families`)
    } catch (err) {
      log.debug(`C2IntelFeeds failed: ${err}`)
    }
  }
}
