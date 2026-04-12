import { ipcMain, BrowserWindow } from 'electron'
import { llmService, type ChatMessage } from '../services/llm/LlmService'
import { agenticChatOrchestrator } from '../services/llm/AgenticChatOrchestrator'
import { memoryService } from '../services/memory/MemoryService'
import { vectorDbService } from '../services/vectordb/VectorDbService'
import { getDatabase } from '../services/database'
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

  ipcMain.handle('chat:generateDailySummary', () => memoryService.generateDailySummary())
  ipcMain.handle('chat:generateWeeklySummary', () => memoryService.generateWeeklySummary())

  ipcMain.handle('chat:getConnections', () => {
    return llmService.getConnections().map((c) => ({
      id: c.id, name: c.name, model: c.model || c.customModel, enabled: c.enabled
    }))
  })

  // Manual vector DB ingestion trigger
  ipcMain.handle('chat:generateLearnings', async () => {
    log.info('Manual vector DB ingestion triggered')
    const { intelPipeline } = await import('../services/vectordb/IntelPipeline')
    await intelPipeline.runIngestion()

    const stats = vectorDbService.getStats()
    const db = getDatabase()
    const totalReports = (db.prepare('SELECT COUNT(*) as count FROM intel_reports').get() as { count: number }).count
    const totalTags = (db.prepare('SELECT COUNT(DISTINCT tag) as count FROM intel_tags').get() as { count: number }).count
    const totalEntities = (db.prepare('SELECT COUNT(*) as count FROM intel_entities').get() as { count: number }).count
    const totalLinks = (db.prepare('SELECT COUNT(*) as count FROM intel_links').get() as { count: number }).count

    return {
      totalReports,
      totalTags,
      totalEntities,
      totalLinks,
      vectorDbInitialized: stats.initialized
    }
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
    const timeline: Array<{ date: string; count: number }> = {}  as any
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
  ipcMain.handle('explore:getData', (_event, params: {
    groupBy: string; metric: string; filters?: Record<string, string>
    timeRange?: string; limit?: number
  }) => {
    const db = getDatabase()
    const { groupBy, metric, filters, timeRange, limit = 50 } = params

    const conditions: string[] = []
    const vals: unknown[] = []

    if (filters?.discipline) { conditions.push('discipline = ?'); vals.push(filters.discipline) }
    if (filters?.severity) { conditions.push('severity = ?'); vals.push(filters.severity) }
    if (filters?.source) { conditions.push('source_name = ?'); vals.push(filters.source) }
    if (timeRange) {
      const hours = parseInt(timeRange) || 24
      conditions.push('created_at >= ?')
      vals.push(Date.now() - hours * 3600000)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const metricSql = metric === 'count' ? 'COUNT(*)' : metric === 'avg_verification' ? 'AVG(verification_score)' : 'COUNT(*)'

    const data = db.prepare(
      `SELECT ${groupBy} as label, ${metricSql} as value FROM intel_reports ${where} GROUP BY ${groupBy} ORDER BY value DESC LIMIT ?`
    ).all(...vals, limit) as Array<{ label: string; value: number }>

    // Timeline data
    const timeData = db.prepare(
      `SELECT DATE(created_at/1000, 'unixepoch') as date, COUNT(*) as count FROM intel_reports ${where} GROUP BY date ORDER BY date`
    ).all(...vals) as Array<{ date: string; count: number }>

    return { data, timeline: timeData }
  })

  log.info('Chat bridge registered')
}
