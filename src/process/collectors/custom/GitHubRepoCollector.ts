import { BaseCollector } from '../BaseCollector'
import type { IntelReport, ThreatLevel, Discipline } from '@common/types/intel'
import log from 'electron-log'

// GitHub Repository Monitor
// Watches a GitHub repo for releases, security advisories, commits, issues, or file content
//
// Example config:
// {
//   owner: 'CriticalPathSecurity',
//   repo: 'Public-Intelligence-Feeds',
//   watchTypes: ['releases', 'commits'],
//   apiToken: 'ghp_...' (optional, for higher rate limits)
// }

interface GhConfig {
  owner: string
  repo: string
  watchTypes?: Array<'releases' | 'security' | 'commits' | 'issues' | 'file'>
  filePath?: string
  branch?: string
  apiToken?: string
  discipline?: Discipline
  maxItems?: number
}

export class GitHubRepoCollector extends BaseCollector {
  readonly discipline: Discipline = 'osint'
  readonly type = 'github-repo'

  async collect(): Promise<IntelReport[]> {
    const cfg = (this.sourceConfig?.config || {}) as GhConfig
    if (!cfg.owner || !cfg.repo) {
      log.warn(`GitHubRepo: missing owner/repo for ${this.sourceConfig?.name}`)
      return []
    }

    const watchTypes = cfg.watchTypes || ['releases']
    const discipline = cfg.discipline || 'osint'
    const reports: IntelReport[] = []

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Heimdall/0.1.0'
    }
    if (cfg.apiToken) headers['Authorization'] = `Bearer ${cfg.apiToken}`

    const baseUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}`

    for (const watchType of watchTypes) {
      try {
        switch (watchType) {
          case 'releases':
            await this.collectReleases(reports, baseUrl, headers, discipline)
            break
          case 'security':
            await this.collectSecurity(reports, baseUrl, headers, discipline)
            break
          case 'commits':
            await this.collectCommits(reports, baseUrl, headers, discipline, cfg.branch)
            break
          case 'issues':
            await this.collectIssues(reports, baseUrl, headers, discipline)
            break
          case 'file':
            if (cfg.filePath) await this.collectFile(reports, baseUrl, headers, discipline, cfg.filePath, cfg.branch)
            break
        }
      } catch (err) {
        log.warn(`GitHubRepo [${cfg.owner}/${cfg.repo}] ${watchType} failed: ${err}`)
      }
    }

    log.info(`GitHubRepo [${cfg.owner}/${cfg.repo}]: ${reports.length} reports from ${watchTypes.join(',')}`)
    return reports
  }

  private async fetchGh<T>(url: string, headers: Record<string, string>): Promise<T> {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json() as Promise<T>
  }

  private async collectReleases(reports: IntelReport[], baseUrl: string, headers: Record<string, string>, discipline: Discipline): Promise<void> {
    const releases = await this.fetchGh<Array<{
      name: string; tag_name: string; published_at: string; html_url: string
      body: string; prerelease: boolean; author: { login: string }
    }>>(`${baseUrl}/releases?per_page=10`, headers)

    for (const r of releases.slice(0, 10)) {
      reports.push({
        ...this.createReport({
          title: `GitHub Release: ${r.name || r.tag_name}`,
          content: `**Repository**: ${baseUrl.split('/').slice(-2).join('/')}\n**Tag**: ${r.tag_name}\n**Published**: ${r.published_at}\n**Author**: @${r.author?.login || 'unknown'}\n${r.prerelease ? '**Pre-release**\n' : ''}\n${(r.body || '').slice(0, 2000)}`,
          severity: r.prerelease ? 'low' : 'info',
          sourceUrl: r.html_url,
          sourceName: 'GitHub Releases',
          verificationScore: 95
        }),
        discipline
      })
    }
  }

  private async collectSecurity(reports: IntelReport[], baseUrl: string, headers: Record<string, string>, discipline: Discipline): Promise<void> {
    const advisories = await this.fetchGh<Array<{
      ghsa_id: string; summary: string; description: string; severity: string
      published_at: string; html_url: string; cve_id: string | null
      vulnerabilities: Array<{ package: { name: string }; vulnerable_version_range: string }>
    }>>(`${baseUrl}/security-advisories?per_page=10`, headers).catch(() => [])

    for (const a of advisories.slice(0, 10)) {
      const sev = (a.severity || 'medium').toLowerCase() as ThreatLevel
      const vulnLines = (a.vulnerabilities || []).map((v) => `- ${v.package?.name}: ${v.vulnerable_version_range}`).join('\n')
      reports.push({
        ...this.createReport({
          title: `GHSA: ${a.summary || a.ghsa_id}`,
          content: `**ID**: ${a.ghsa_id}${a.cve_id ? `\n**CVE**: ${a.cve_id}` : ''}\n**Severity**: ${a.severity}\n**Published**: ${a.published_at}\n\n${a.description || ''}\n\n**Affected**:\n${vulnLines}`,
          severity: sev === 'critical' ? 'critical' : sev === 'high' ? 'high' : sev === 'medium' ? 'medium' : 'low',
          sourceUrl: a.html_url,
          sourceName: 'GitHub Security Advisory',
          verificationScore: 95
        }),
        discipline: 'cybint'
      })
    }
  }

  private async collectCommits(reports: IntelReport[], baseUrl: string, headers: Record<string, string>, discipline: Discipline, branch?: string): Promise<void> {
    const url = branch ? `${baseUrl}/commits?per_page=10&sha=${branch}` : `${baseUrl}/commits?per_page=10`
    const commits = await this.fetchGh<Array<{
      sha: string; html_url: string
      commit: { message: string; author: { name: string; date: string } }
      author: { login: string } | null
    }>>(url, headers)

    for (const c of commits.slice(0, 10)) {
      const msg = c.commit.message.split('\n')[0]
      reports.push({
        ...this.createReport({
          title: `GitHub Commit: ${msg.slice(0, 80)}`,
          content: `**Repository**: ${baseUrl.split('/').slice(-2).join('/')}\n**SHA**: ${c.sha.slice(0, 8)}\n**Author**: ${c.commit.author.name}${c.author ? ` (@${c.author.login})` : ''}\n**Date**: ${c.commit.author.date}\n\n${c.commit.message}`,
          severity: 'info',
          sourceUrl: c.html_url,
          sourceName: 'GitHub Commits',
          verificationScore: 90
        }),
        discipline
      })
    }
  }

  private async collectIssues(reports: IntelReport[], baseUrl: string, headers: Record<string, string>, discipline: Discipline): Promise<void> {
    const issues = await this.fetchGh<Array<{
      number: number; title: string; body: string; html_url: string
      state: string; created_at: string; user: { login: string }
      labels: Array<{ name: string }>
    }>>(`${baseUrl}/issues?state=open&per_page=10`, headers)

    for (const i of issues.slice(0, 10)) {
      // Skip pull requests (GitHub API returns PRs as issues)
      if (!i.title || (i as unknown as { pull_request?: unknown }).pull_request) continue
      const labels = (i.labels || []).map((l) => l.name).join(', ')
      const isSecurity = /security|vulnerability|cve/i.test(i.title) || /security|cve/i.test(labels)
      reports.push({
        ...this.createReport({
          title: `GitHub Issue #${i.number}: ${i.title.slice(0, 80)}`,
          content: `**Repository**: ${baseUrl.split('/').slice(-2).join('/')}\n**Author**: @${i.user.login}\n**State**: ${i.state}\n**Labels**: ${labels || 'none'}\n**Created**: ${i.created_at}\n\n${(i.body || '').slice(0, 1500)}`,
          severity: isSecurity ? 'high' : 'info',
          sourceUrl: i.html_url,
          sourceName: 'GitHub Issues',
          verificationScore: 80
        }),
        discipline
      })
    }
  }

  private async collectFile(reports: IntelReport[], baseUrl: string, headers: Record<string, string>, discipline: Discipline, filePath: string, branch?: string): Promise<void> {
    const url = `${baseUrl}/contents/${filePath}${branch ? `?ref=${branch}` : ''}`
    const fileData = await this.fetchGh<{
      name: string; path: string; sha: string; size: number
      html_url: string; content?: string; encoding?: string
    }>(url, headers)

    if (!fileData.content || fileData.encoding !== 'base64') return
    const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8')

    // Try to parse as JSON; if array, emit each item
    try {
      const json = JSON.parse(decoded)
      const items = Array.isArray(json) ? json : [json]
      for (const item of items.slice(0, 20)) {
        const title = (typeof item === 'object' && item)
          ? (item.title || item.name || item.id || 'Item')
          : String(item)
        reports.push({
          ...this.createReport({
            title: `GitHub File: ${fileData.name} — ${String(title).slice(0, 60)}`,
            content: typeof item === 'object' ? JSON.stringify(item, null, 2).slice(0, 2000) : String(item),
            severity: 'info',
            sourceUrl: fileData.html_url,
            sourceName: `GitHub File: ${fileData.path}`,
            verificationScore: 85
          }),
          discipline
        })
      }
    } catch {
      // Not JSON — treat as single text file
      reports.push({
        ...this.createReport({
          title: `GitHub File: ${fileData.name}`,
          content: `**Path**: ${fileData.path}\n**Size**: ${fileData.size} bytes\n**SHA**: ${fileData.sha.slice(0, 8)}\n\n\`\`\`\n${decoded.slice(0, 3000)}\n\`\`\``,
          severity: 'info',
          sourceUrl: fileData.html_url,
          sourceName: `GitHub File: ${fileData.path}`,
          verificationScore: 85
        }),
        discipline
      })
    }
  }
}
