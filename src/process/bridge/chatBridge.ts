import { ipcMain, BrowserWindow } from 'electron'
import { llmService, type ChatMessage } from '../services/llm/LlmService'
import { agenticChatOrchestrator } from '../services/llm/AgenticChatOrchestrator'
import { memoryService } from '../services/memory/MemoryService'
import { vectorDbService } from '../services/vectordb/VectorDbService'
import { syncManager } from '../services/sync/SyncManager'
import { getDatabase } from '../services/database'
import { reportExtractor } from '../services/enrichment/ReportExtractor'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export function registerChatBridge(): void {
  // ── Chat Sessions ──────────────────────────────────────────────────

  ipcMain.handle('chat:createSession', (_event, params?: { title?: string }) => {
    const db = getDatabase()
    const now = timestamp()
    const id = generateId()
    const title = params?.title || 'New Chat'
    db.prepare('INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now)
    return { id, title, createdAt: now, updatedAt: now }
  })

  ipcMain.handle('chat:getSessions', () => {
    const db = getDatabase()
    const sessions = db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>

    // Get message count per session
    return sessions.map((s) => {
      const count = (db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?').get(s.id) as { count: number }).count
      // Get last message preview
      const lastMsg = db.prepare('SELECT content FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(s.id) as { content: string } | undefined
      return {
        id: s.id,
        title: s.title,
        messageCount: count,
        lastMessage: lastMsg?.content?.slice(0, 80) || '',
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }
    })
  })

  ipcMain.handle('chat:renameSession', (_event, params: { id: string; title: string }) => {
    const db = getDatabase()
    db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(params.title, timestamp(), params.id)
  })

  ipcMain.handle('chat:deleteSession', (_event, params: { id: string }) => {
    const db = getDatabase()
    db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(params.id)
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(params.id)
  })

  // ── Chat Messages ──────────────────────────────────────────────────

  ipcMain.handle('chat:send', async (_event, params: {
    messages: ChatMessage[]
    query: string
    sessionId: string
    connectionId?: string
    useAgentic?: boolean
    mode?: 'agentic' | 'direct' | 'caveman'
  }) => {
    const { messages, query, sessionId, connectionId, useAgentic = true, mode = 'direct' } = params

    let fullResponse = ''
    try {
      if (useAgentic) {
        fullResponse = await agenticChatOrchestrator.process(
          query, messages, connectionId,
          (chunk) => {
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('chat:chunk', chunk)
            }
          }
        )
      } else {
        // Use vector search for context
        const vectorResults = await vectorDbService.search(query, 8)
        const vectorContext = vectorResults.length > 0
          ? vectorResults.map((r, i) =>
            `[${i + 1}] ${r.title} (${r.discipline}/${r.severity}, score: ${r.score.toFixed(2)})\n${r.snippet}`
          ).join('\n\n')
          : ''

        const { intelRagService } = await import('../services/llm/IntelRagService')
        const contextMessages = intelRagService.buildContextMessages(query)
        const summary = intelRagService.getRecentSummary(24)

        const fullMessages: ChatMessage[] = [
          { role: 'system', content: summary },
          ...contextMessages,
          ...(vectorContext ? [{ role: 'system' as const, content: `Vector search results:\n\n${vectorContext}` }] : []),
          ...messages
        ]

        fullResponse = await llmService.chat(fullMessages, connectionId, (chunk) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('chat:chunk', chunk)
          }
        }, mode)
      }

      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('chat:done', fullResponse)
      }
    } catch (err) {
      log.error('Chat error:', err)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('chat:error', String(err))
      }
      throw err
    }

    // Persist messages to session
    const db = getDatabase()
    const now = timestamp()
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(generateId(), sessionId, 'user', query, now)
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(generateId(), sessionId, 'assistant', fullResponse, now)

    // Update session timestamp and auto-title
    const msgCount = (db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?').get(sessionId) as { count: number }).count
    if (msgCount <= 2) {
      // Auto-title from first user query
      const title = query.slice(0, 60) + (query.length > 60 ? '...' : '')
      db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now, sessionId)
    } else {
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
    }

    return fullResponse
  })

  ipcMain.handle('chat:getHistory', (_event, params?: { sessionId?: string }) => {
    const db = getDatabase()
    const sessionId = params?.sessionId || 'default'
    return db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 200').all(sessionId)
  })

  ipcMain.handle('chat:clearHistory', (_event, params?: { sessionId?: string }) => {
    const db = getDatabase()
    if (params?.sessionId) {
      db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(params.sessionId)
    } else {
      db.prepare('DELETE FROM chat_messages').run()
    }
  })

  // ── Preliminary Reports ─────────────────────────────────────────

  ipcMain.handle('chat:savePreliminaryReport', (_event, params: { sessionId: string; messageId: string; content: string }) => {
    const db = getDatabase()
    const now = timestamp()
    const { sessionId, messageId, content } = params

    // Extract structured data from LLM response
    const extracted = reportExtractor.extract(content)
    const reportId = generateId()

    // Find source intel IDs from session context
    const sessionMessages = db.prepare(
      "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'system' ORDER BY created_at"
    ).all(sessionId) as Array<{ content: string }>

    // Extract report IDs mentioned in system context
    const sourceIds: string[] = []
    for (const msg of sessionMessages) {
      const idMatches = msg.content.match(/[0-9a-f]{8}-[0-9a-f]{4}/g) || []
      sourceIds.push(...idMatches.slice(0, 20))
    }

    // Insert preliminary report
    db.prepare(`
      INSERT INTO preliminary_reports (id, session_id, chat_message_id, title, content, status, source_report_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'preliminary', ?, ?, ?)
    `).run(reportId, sessionId, messageId, extracted.title, content, JSON.stringify(sourceIds.slice(0, 50)), now, now)

    // Insert recommended actions
    for (const action of extracted.actions) {
      db.prepare('INSERT INTO recommended_actions (id, preliminary_report_id, action, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        generateId(), reportId, action.action, action.priority, 'pending', now
      )
    }

    // Insert information gaps
    for (const gap of extracted.gaps) {
      db.prepare('INSERT INTO intel_gaps (id, preliminary_report_id, description, category, severity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        generateId(), reportId, gap.description, gap.category, gap.severity, 'open', now
      )
    }

    // Create links from preliminary report to source intel
    for (const srcId of sourceIds.slice(0, 10)) {
      db.prepare('INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        generateId(), reportId, srcId, 'preliminary_reference', 0.8, 'Source intel for preliminary report', now
      )
    }

    // Tag the preliminary report
    const tags = ['preliminary-report', `status:preliminary`]
    for (const action of extracted.actions) { tags.push(`action:${action.priority}`) }
    for (const gap of extracted.gaps) { tags.push(`gap:${gap.category}`) }
    for (const tag of [...new Set(tags)]) {
      db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        reportId, tag, 1.0, 'preliminary', now
      )
    }

    log.info(`Preliminary report saved: ${extracted.title} (${extracted.actions.length} actions, ${extracted.gaps.length} gaps)`)

    return {
      reportId,
      title: extracted.title,
      actionsCount: extracted.actions.length,
      gapsCount: extracted.gaps.length,
      actions: extracted.actions,
      gaps: extracted.gaps
    }
  })

  ipcMain.handle('chat:getPreliminaryReports', () => {
    const db = getDatabase()
    const reports = db.prepare('SELECT * FROM preliminary_reports ORDER BY created_at DESC LIMIT 50').all() as Array<Record<string, unknown>>
    return reports.map((r) => {
      const actions = db.prepare('SELECT * FROM recommended_actions WHERE preliminary_report_id = ?').all(r.id) as Array<Record<string, unknown>>
      const gaps = db.prepare('SELECT * FROM intel_gaps WHERE preliminary_report_id = ?').all(r.id) as Array<Record<string, unknown>>
      return { ...r, actions, gaps }
    })
  })

  ipcMain.handle('chat:getGaps', () => {
    const db = getDatabase()
    return db.prepare("SELECT g.*, p.title as report_title FROM intel_gaps g JOIN preliminary_reports p ON g.preliminary_report_id = p.id WHERE g.status = 'open' ORDER BY g.created_at DESC").all()
  })

  ipcMain.handle('chat:generateDailySummary', () => memoryService.generateDailySummary())
  ipcMain.handle('chat:generateWeeklySummary', () => memoryService.generateWeeklySummary())

  ipcMain.handle('chat:getConnections', () => {
    return llmService.getConnections().map((c) => ({
      id: c.id, name: c.name, model: c.model || c.customModel, enabled: c.enabled
    }))
  })

  // Manual vector DB ingestion — DB records + local files + Obsidian vault (batched)
  ipcMain.handle('chat:generateLearnings', async () => {
    log.info('Manual vector DB ingestion triggered')
    const notify = (msg: string) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('app:notification', { title: 'Learnings', body: msg, severity: 'info' })
      }
    }

    // 1. Ingest from DB
    notify('Processing intel reports...')
    const { intelPipeline } = await import('../services/vectordb/IntelPipeline')
    await intelPipeline.runIngestion()

    // 2. Ingest local ~/.heimdall/memory files (fast — direct filesystem read)
    let localFiles = 0
    try {
      const { app: electronApp } = await import('electron')
      const { join } = await import('path')
      const { readdirSync, readFileSync, statSync } = await import('fs')
      const memoryDir = join(electronApp.getPath('home'), '.heimdall', 'memory')

      const walkDir = (dir: string): void => {
        let entries: string[]
        try { entries = readdirSync(dir) } catch { return }
        for (const entry of entries) {
          const fullPath = join(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) { walkDir(fullPath); continue }
            if (!entry.endsWith('.md')) continue
            // Skip already synced
            if (syncManager.isSynced('vector-local', fullPath)) continue
            const content = readFileSync(fullPath, 'utf-8')
            if (content.length < 50) continue
            vectorDbService.addReport({
              id: `local_${fullPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}`,
              discipline: 'osint', title: entry.replace('.md', ''),
              content: content.slice(0, 3000), summary: null, severity: 'info',
              sourceId: 'local-memory', sourceUrl: null, sourceName: `Local: ${entry}`,
              contentHash: fullPath, latitude: null, longitude: null,
              verificationScore: 50, reviewed: false, createdAt: Date.now(), updatedAt: Date.now()
            } as any)
            syncManager.markSynced('vector-local', fullPath)
            localFiles++
          } catch {}
        }
      }
      walkDir(memoryDir)
      log.info(`Learnings: ingested ${localFiles} local memory files`)
      notify(`${localFiles} local files processed`)
    } catch {}

    // 3. Ingest Obsidian vault — parallel batches of 10 concurrent reads
    let obsidianFiles = 0
    try {
      const { obsidianService } = await import('../services/obsidian/ObsidianService')
      const testConn = await obsidianService.testConnection()
      if (testConn.success) {
        const files = await obsidianService.listFiles()
        const allMd = files.filter((f: string) => f.endsWith('.md'))
        const mdFiles = allMd.filter((f: string) => !syncManager.isSynced('vector-obsidian', f))
        const skipped = allMd.length - mdFiles.length
        log.info(`Learnings: found ${allMd.length} Obsidian files, ${skipped} already synced, ${mdFiles.length} new`)
        notify(`Processing ${mdFiles.length} new Obsidian files (${skipped} already synced)...`)

        // Process in parallel batches of 10
        const BATCH_SIZE = 10
        for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
          const batch = mdFiles.slice(i, i + BATCH_SIZE)
          const results = await Promise.allSettled(
            batch.map(async (filePath: string) => {
              const content = await obsidianService.readFile(filePath)
              if (!content || content.length < 50) return null
              await vectorDbService.addReport({
                id: `obs_${filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}`,
                discipline: 'osint',
                title: filePath.split('/').pop()?.replace('.md', '') || filePath,
                content: content.slice(0, 3000), summary: null, severity: 'info',
                sourceId: 'obsidian', sourceUrl: null, sourceName: `Obsidian: ${filePath}`,
                contentHash: filePath, latitude: null, longitude: null,
                verificationScore: 60, reviewed: false, createdAt: Date.now(), updatedAt: Date.now()
              } as any)
              syncManager.markSynced('vector-obsidian', filePath)
              return filePath
            })
          )
          obsidianFiles += results.filter((r) => r.status === 'fulfilled' && r.value).length

          // Progress update every 100 files
          if (i % 100 === 0 && i > 0) {
            log.info(`Learnings: Obsidian progress ${i}/${mdFiles.length}`)
            notify(`Obsidian: ${i}/${mdFiles.length} files...`)
          }
        }
        log.info(`Learnings: ingested ${obsidianFiles} Obsidian files`)
        notify(`${obsidianFiles} Obsidian files ingested`)
      }
    } catch (err) {
      log.debug(`Obsidian ingestion: ${err}`)
    }

    const stats = vectorDbService.getStats()
    const db = getDatabase()
    const totalReports = (db.prepare('SELECT COUNT(*) as count FROM intel_reports').get() as { count: number }).count
    const totalTags = (db.prepare('SELECT COUNT(DISTINCT tag) as count FROM intel_tags').get() as { count: number }).count
    const totalEntities = (db.prepare('SELECT COUNT(*) as count FROM intel_entities').get() as { count: number }).count
    const totalLinks = (db.prepare('SELECT COUNT(*) as count FROM intel_links').get() as { count: number }).count

    return { totalReports, totalTags, totalEntities, totalLinks, obsidianFiles, localFiles, vectorDbInitialized: stats.initialized }
  })

  ipcMain.handle('chat:getVectorStats', () => {
    const stats = vectorDbService.getStats()
    const db = getDatabase()
    const totalReports = (db.prepare('SELECT COUNT(*) as count FROM intel_reports').get() as { count: number }).count
    return { ...stats, totalReports }
  })

  ipcMain.handle('chat:getTokenStats', () => {
    return llmService.getUsageStats()
  })

  ipcMain.handle('chat:isIngesting', async () => {
    const { intelPipeline } = await import('../services/vectordb/IntelPipeline')
    return intelPipeline.isProcessing()
  })

  // Session semantic data for Explore tab
  ipcMain.handle('chat:getSessionData', (_event, params: { sessionId: string }) => {
    const db = getDatabase()
    const messages = db.prepare(
      "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at"
    ).all(params.sessionId) as Array<{ content: string }>

    // Collect mentioned disciplines, severities, and keywords from assistant messages
    const disciplines = new Set<string>()
    const severities = new Set<string>()
    const kw: Record<string, number> = {}
    const stopWords = new Set(['that','this','with','from','have','been','were','which','their','about','would','could','should','these','those','based','using','other','more','also','into','some','such','most','than','very','only','just','they','will','each','many'])

    for (const msg of messages) {
      const text = msg.content.toLowerCase()
      for (const d of ['osint','cybint','finint','socmint','geoint','sigint','rumint','ci','agency']) {
        if (text.includes(d)) disciplines.add(d)
      }
      for (const s of ['critical','high','medium','low']) {
        if (text.includes(s)) severities.add(s)
      }
      for (const w of (text.match(/\b[a-z]{4,}\b/g) || [])) {
        if (!stopWords.has(w)) kw[w] = (kw[w] || 0) + 1
      }
    }

    const topKeywords = Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k)

    // Get reports matching the session context
    let reports: Array<Record<string, unknown>> = []
    if (topKeywords.length > 0) {
      const clauses = topKeywords.slice(0, 5).map(() => 'LOWER(title) LIKE ?').join(' OR ')
      const vals = topKeywords.slice(0, 5).map((k) => `%${k}%`)
      reports = db.prepare(
        `SELECT id, discipline, title, severity, source_name, verification_score, latitude, longitude, created_at FROM intel_reports WHERE ${clauses} ORDER BY created_at DESC LIMIT 200`
      ).all(...vals) as Array<Record<string, unknown>>
    }

    // Aggregate data for charts
    const bySeverity: Record<string, number> = {}
    const byDiscipline: Record<string, number> = {}
    const bySource: Record<string, number> = {}
    const timeMap: Record<string, number> = {}

    for (const r of reports) {
      bySeverity[r.severity as string] = (bySeverity[r.severity as string] || 0) + 1
      byDiscipline[r.discipline as string] = (byDiscipline[r.discipline as string] || 0) + 1
      bySource[r.source_name as string] = (bySource[r.source_name as string] || 0) + 1
      const date = new Date(r.created_at as number).toISOString().split('T')[0]
      timeMap[date] = (timeMap[date] || 0) + 1
    }

    return {
      disciplines: Array.from(disciplines),
      severities: Array.from(severities),
      topKeywords,
      reportCount: reports.length,
      bySeverity, byDiscipline, bySource,
      timeline: Object.entries(timeMap).sort().map(([date, count]) => ({ date, count })),
      reports: reports.slice(0, 100).map((r) => ({
        id: r.id, discipline: r.discipline, title: r.title, severity: r.severity,
        source: r.source_name, verification: r.verification_score,
        lat: r.latitude, lon: r.longitude, createdAt: r.created_at
      }))
    }
  })

  // Explore data — aggregate across all intel
  // Explore — safe groupBy whitelist
  const GROUP_BY_SQL: Record<string, string> = {
    discipline: 'discipline',
    severity: 'severity',
    source: 'source_name',
    date: "strftime('%Y-%m-%d', created_at/1000, 'unixepoch')",
    hour: "strftime('%H', created_at/1000, 'unixepoch')"
  }

  ipcMain.handle('explore:getData', (_event, params: {
    groupBy: string; metric: string; filters?: Record<string, string>
    timeRange?: string; limit?: number
  }) => {
    const db = getDatabase()
    const { groupBy, metric, filters, timeRange, limit = 50 } = params

    const groupBySql = GROUP_BY_SQL[groupBy] || 'discipline'
    const metricSql = metric === 'avg_verification' ? 'ROUND(AVG(verification_score),1)' : 'COUNT(*)'

    const conditions: string[] = []
    const vals: unknown[] = []

    if (filters?.discipline) { conditions.push('discipline = ?'); vals.push(filters.discipline) }
    if (filters?.severity) { conditions.push('severity = ?'); vals.push(filters.severity) }
    if (filters?.source) { conditions.push('source_name = ?'); vals.push(filters.source) }
    if (timeRange && timeRange !== '' && timeRange !== 'all') {
      const hours = parseInt(timeRange) || 24
      conditions.push('created_at >= ?')
      vals.push(Date.now() - hours * 3600000)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const data = db.prepare(
      `SELECT ${groupBySql} as label, ${metricSql} as value FROM intel_reports ${where} GROUP BY ${groupBySql} ORDER BY value DESC LIMIT ?`
    ).all(...vals, limit) as Array<{ label: string; value: number }>

    const timeData = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as date, COUNT(*) as count FROM intel_reports ${where} GROUP BY date ORDER BY date`
    ).all(...vals) as Array<{ date: string; count: number }>

    return { data, timeline: timeData }
  })

  log.info('Chat bridge registered')
}
