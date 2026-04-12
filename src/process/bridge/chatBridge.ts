import { ipcMain, BrowserWindow } from 'electron'
import { llmService, type ChatMessage } from '../services/llm/LlmService'
import { agenticChatOrchestrator } from '../services/llm/AgenticChatOrchestrator'
import { memoryService } from '../services/memory/MemoryService'
import { getDatabase } from '../services/database'
import { generateId, timestamp } from '@common/utils/id'
import log from 'electron-log'

export function registerChatBridge(): void {
  ipcMain.handle('chat:send', async (event, params: {
    messages: ChatMessage[]
    query: string
    connectionId?: string
    useAgentic?: boolean
  }) => {
    const { messages, query, connectionId, useAgentic = true } = params

    let fullResponse = ''
    try {
      if (useAgentic) {
        fullResponse = await agenticChatOrchestrator.process(
          query,
          messages,
          connectionId,
          (chunk) => {
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('chat:chunk', chunk)
            }
          }
        )
      } else {
        // Simple direct chat without agentic decomposition
        const { intelRagService } = await import('../services/llm/IntelRagService')
        const contextMessages = intelRagService.buildContextMessages(query)
        const summary = intelRagService.getRecentSummary(24)

        const fullMessages: ChatMessage[] = [
          { role: 'system', content: summary },
          ...contextMessages,
          ...messages
        ]

        fullResponse = await llmService.chat(fullMessages, connectionId, (chunk) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('chat:chunk', chunk)
          }
        })
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

    // Persist
    const db = getDatabase()
    const now = timestamp()
    db.prepare('INSERT INTO chat_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)').run(generateId(), 'user', query, now)
    db.prepare('INSERT INTO chat_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)').run(generateId(), 'assistant', fullResponse, now)

    return fullResponse
  })

  ipcMain.handle('chat:getHistory', () => {
    const db = getDatabase()
    return db.prepare('SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 100').all()
  })

  ipcMain.handle('chat:clearHistory', () => {
    const db = getDatabase()
    db.prepare('DELETE FROM chat_messages').run()
  })

  ipcMain.handle('chat:generateDailySummary', () => {
    return memoryService.generateDailySummary()
  })

  ipcMain.handle('chat:generateWeeklySummary', () => {
    return memoryService.generateWeeklySummary()
  })

  ipcMain.handle('chat:getConnections', () => {
    return llmService.getConnections().map((c) => ({
      id: c.id,
      name: c.name,
      model: c.model || c.customModel,
      enabled: c.enabled
    }))
  })

  log.info('Chat bridge registered')
}
