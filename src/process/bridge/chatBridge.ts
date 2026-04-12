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

  log.info('Chat bridge registered')
}
