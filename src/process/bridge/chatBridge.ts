import { ipcMain, BrowserWindow } from 'electron'
import { llmService, type ChatMessage } from '../services/llm/LlmService'
import { agenticChatOrchestrator, type PlanEdits } from '../services/llm/AgenticChatOrchestrator'
import { deepResearchAgent } from '../services/llm/DeepResearchAgent'
import { agenticPlanStore } from '../services/llm/AgenticPlanStore'
import { memoryService } from '../services/memory/MemoryService'
import { vectorDbService } from '../services/vectordb/VectorDbService'
import { syncManager } from '../services/sync/SyncManager'
import { getDatabase } from '../services/database'
import { reportExtractor } from '../services/enrichment/ReportExtractor'
import { auditChainService } from '../services/audit/AuditChainService'
import { analystCouncilService } from '../services/llm/AnalystCouncil'
import { watchTermsService } from '../services/watch/WatchTermsService'
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
    const meta = db.prepare('SELECT title, classification FROM chat_sessions WHERE id = ?').get(params.id) as { title: string; classification: string } | undefined
    const msgCount = (db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(params.id) as { c: number }).c
    db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(params.id)
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(params.id)
    auditChainService.append('chat.deleteSession', {
      entityType: 'chat_session',
      entityId: params.id,
      classification: meta?.classification,
      payload: { title: meta?.title, messageCount: msgCount }
    })
  })

  // ── Chat Messages ──────────────────────────────────────────────────

  // ── Plan-mode (agentic) ────────────────────────────────────────────
  // Two-phase agentic flow:
  //   chat:planRequest → returns a PlanPreview the renderer shows in
  //                      PlanApprovalModal. NO research runs.
  //   chat:executePlan → runs the approved (possibly edited) plan and
  //                      streams the result like chat:send.

  // Classify query as follow-up vs new topic.
  ipcMain.handle('chat:classifyQuery', (_event, params: {
    query: string
    messages: ChatMessage[]
  }) => {
    return deepResearchAgent.classifyQuery(params.query, params.messages)
  })

  // Handle follow-up directly (no plan modal).
  ipcMain.handle('chat:followUp', async (_event, params: {
    messages: ChatMessage[]
    query: string
    sessionId: string
    connectionId?: string
  }) => {
    const { messages, query, sessionId, connectionId } = params
    const windows = BrowserWindow.getAllWindows()
    const safeSendLocal = (channel: string, payload: unknown) => {
      for (const win of windows) {
        if (win.isDestroyed()) continue
        try { win.webContents.send(channel, payload) } catch {}
      }
    }
    const trailChunks: string[] = []
    let trailLen = 0
    const emitChunk = (chunk: string) => {
      if (trailLen < 100_000) {
        trailChunks.push(chunk)
        trailLen += chunk.length
      }
      safeSendLocal('chat:chunk', chunk)
    }
    let fullResponse = ''
    try {
      fullResponse = await deepResearchAgent.handleFollowUp(query, messages, connectionId, emitChunk)
      const thinkingTrail = trailChunks.join('')
      safeSendLocal('chat:done', { response: fullResponse, thinkingTrail })
    } catch (err) {
      log.error('chat:followUp error:', err)
      safeSendLocal('chat:error', String(err))
      throw err
    }
    const db = getDatabase()
    const now = timestamp()
    const assistantMsgId = generateId()
    const thinkingTrail = trailChunks.join('') || null
    const persistChat = db.transaction(() => {
      db.prepare('INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(generateId(), sessionId, 'user', query, now)
      db.prepare('INSERT INTO chat_messages (id, session_id, role, content, thinking_trail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(assistantMsgId, sessionId, 'assistant', fullResponse, thinkingTrail, now)
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
    })
    persistChat()
    return { ok: true, response: fullResponse, thinkingTrail, messageId: assistantMsgId }
  })

  ipcMain.handle('chat:planRequest', async (_event, params: {
    messages: ChatMessage[]
    query: string
    sessionId: string
    connectionId?: string
    /** Mandatory rework feedback from a previously rejected plan. */
    reworkFeedback?: string
    /** The planId that was rejected — its steps inform the regenerated plan. */
    previousPlanId?: string
    /** 'deep' = DeepResearchAgent (auto-research before modal),
     *  'lite' = AgenticChatOrchestrator (plan only, no auto-research). */
    mode?: 'deep' | 'lite'
  }) => {
    const { messages, query, sessionId, connectionId, reworkFeedback, previousPlanId, mode = 'deep' } = params

    // Chunk emitter for streaming auto-research progress to renderer.
    const windows = BrowserWindow.getAllWindows()
    const safeSendLocal = (channel: string, payload: unknown) => {
      for (const win of windows) {
        if (win.isDestroyed()) continue
        try { win.webContents.send(channel, payload) } catch {}
      }
    }
    const emitChunk = (chunk: string) => safeSendLocal('chat:chunk', chunk)

    if (mode === 'deep') {
      const result = await deepResearchAgent.buildPlanWithResearch(
        query, messages, sessionId, connectionId, emitChunk,
        { reworkFeedback, previousPlanId }
      )
      if (!result) {
        return { ok: false, reason: 'planning_failed', message: 'The deep research agent could not produce a plan. Try rephrasing or switch to Lite mode.' }
      }
      return { ok: true, preview: result.preview, preliminaryFindings: result.findings, mode: 'deep' }
    } else {
      // Lite mode — original AgenticChatOrchestrator (plan only, no auto-research).
      const preview = await agenticChatOrchestrator.buildPlan(
        query, messages, sessionId, connectionId,
        { reworkFeedback, previousPlanId }
      )
      if (!preview) {
        return { ok: false, reason: 'planning_failed', message: 'The planner could not produce a structured plan for this query.' }
      }
      return { ok: true, preview, mode: 'lite' }
    }
  })

  ipcMain.handle('chat:executePlan', async (_event, params: {
    planId: string
    sessionId: string
    edits: PlanEdits
    mode?: 'deep' | 'lite'
    outputFormat?: 'auto' | 'nie' | 'pdb' | 'iir' | 'assessment'
    sats?: { ach?: boolean; assumptions?: boolean; redTeam?: boolean; indicators?: boolean }
  }) => {
    const { planId, sessionId, edits, mode = 'deep', outputFormat = 'auto', sats } = params

    // Sanity-check the plan exists before kicking off streaming.
    const stored = agenticPlanStore.get(planId)
    if (!stored) {
      return { ok: false, reason: 'plan_expired', message: 'The plan has expired (30 min TTL). Re-submit your query to build a fresh plan.' }
    }

    // Same chunk-emitting + thinking-trail capture pattern as chat:send.
    const windows = BrowserWindow.getAllWindows()
    const safeSend = (channel: string, payload: unknown) => {
      for (const win of windows) {
        if (win.isDestroyed()) continue
        try { win.webContents.send(channel, payload) } catch {}
      }
    }
    const trailChunks: string[] = []
    const TRAIL_CAP = 100_000
    let trailLen = 0
    const emitChunk = (chunk: string) => {
      if (trailLen < TRAIL_CAP) {
        const room = TRAIL_CAP - trailLen
        trailChunks.push(chunk.length > room ? chunk.slice(0, room) + '\n[…trail truncated…]' : chunk)
        trailLen += chunk.length
      }
      safeSend('chat:chunk', chunk)
    }

    let fullResponse = ''
    try {
      if (mode === 'deep') {
        fullResponse = await deepResearchAgent.executeApproved(planId, edits, emitChunk, outputFormat, sats)
      } else {
        fullResponse = await agenticChatOrchestrator.executeApprovedPlan(planId, edits, emitChunk)
      }
      const thinkingTrail = trailChunks.join('')
      safeSend('chat:done', { response: fullResponse, thinkingTrail })
    } catch (err) {
      log.error('chat:executePlan error:', err)
      safeSend('chat:error', String(err))
      throw err
    }

    // Persist user + assistant messages with the captured trail (mirrors chat:send).
    const db = getDatabase()
    const now = timestamp()
    const assistantMsgId = generateId()
    const thinkingTrail = trailChunks.join('') || null
    const persistChat = db.transaction(() => {
      db.prepare('INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(generateId(), sessionId, 'user', stored.query, now)
      db.prepare('INSERT INTO chat_messages (id, session_id, role, content, thinking_trail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(assistantMsgId, sessionId, 'assistant', fullResponse, thinkingTrail, now)
      const msgCount = (db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?').get(sessionId) as { count: number }).count
      if (msgCount <= 2) {
        const title = stored.query.slice(0, 60) + (stored.query.length > 60 ? '...' : '')
        db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now, sessionId)
      } else {
        db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
      }
    })
    persistChat()

    return { ok: true, response: fullResponse, thinkingTrail, messageId: assistantMsgId }
  })

  /** Drop a pending plan when the user cancels the modal. */
  ipcMain.handle('chat:cancelPlan', (_event, params: { planId: string }) => {
    agenticPlanStore.remove(params.planId)
    return { ok: true }
  })

  ipcMain.handle('chat:send', async (_event, params: {
    messages: ChatMessage[]
    query: string
    sessionId: string
    connectionId?: string
    useAgentic?: boolean
    mode?: 'agentic' | 'direct' | 'caveman' | 'agent'
  }) => {
    const { messages, query, sessionId, connectionId, useAgentic = true, mode = 'direct' } = params

    // Cache windows once for this request — avoid per-chunk lookup. The
    // isDestroyed() guard is required: the user can close a window mid-stream
    // and webContents.send() throws if the window is gone, killing the
    // current chat turn (and historically crashed the whole IPC handler).
    const windows = BrowserWindow.getAllWindows()
    const safeSend = (channel: string, payload: unknown) => {
      for (const win of windows) {
        if (win.isDestroyed()) continue
        try { win.webContents.send(channel, payload) } catch {}
      }
    }

    // Capture the FULL stream (planning, tool calls, dark-web search
    // progress, intermediate analyses, final tokens) so we can persist
    // it as the message's thinking trail. The final assistant text often
    // omits these intermediate steps; without this buffer they're lost
    // the moment the progress card disappears.
    const trailChunks: string[] = []
    const TRAIL_CAP = 100_000 // hard cap to keep DB rows sane (~100 KB)
    let trailLen = 0
    const emitChunk = (chunk: string) => {
      if (trailLen < TRAIL_CAP) {
        const room = TRAIL_CAP - trailLen
        trailChunks.push(chunk.length > room ? chunk.slice(0, room) + '\n[…trail truncated…]' : chunk)
        trailLen += chunk.length
      }
      safeSend('chat:chunk', chunk)
    }

    let fullResponse = ''
    try {
      if (mode === 'agent') {
        // Tool-calling agent mode
        const { toolCallingAgent } = await import('../services/llm/ToolCallingAgent')
        fullResponse = await toolCallingAgent.run(
          query, messages.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
          connectionId, emitChunk,
          (toolName, params, result) => {
            // Log tool calls for HUMINT trail + persist to DB
            log.info(`Agent tool: ${toolName}(${JSON.stringify(params).slice(0, 60)})`)
            try {
              const tcDb = getDatabase()
              tcDb.prepare(
                'INSERT INTO tool_call_logs (id, session_id, tool_name, params, result, created_at) VALUES (?, ?, ?, ?, ?, ?)'
              ).run(generateId(), sessionId, toolName, JSON.stringify(params).slice(0, 2000), String(result).slice(0, 5000), timestamp())
            } catch {}
          },
          sessionId
        )
      } else if (useAgentic) {
        fullResponse = await agenticChatOrchestrator.process(
          query, messages, connectionId, emitChunk
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

        fullResponse = await llmService.chat(fullMessages, connectionId, emitChunk, mode)
      }

      // Build the trail and ship it alongside the final response so the
      // client can attach it to the assistant message it's about to render.
      const thinkingTrail = trailChunks.join('')
      safeSend('chat:done', { response: fullResponse, thinkingTrail })
    } catch (err) {
      log.error('Chat error:', err)
      safeSend('chat:error', String(err))
      throw err
    }

    // Persist messages to session — including the captured thinking trail
    // on the assistant row. Batch all DB writes in a single transaction.
    const db = getDatabase()
    const now = timestamp()
    const assistantMsgId = generateId()
    const thinkingTrail = trailChunks.join('') || null
    const persistChat = db.transaction(() => {
      db.prepare('INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(generateId(), sessionId, 'user', query, now)
      db.prepare('INSERT INTO chat_messages (id, session_id, role, content, thinking_trail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(assistantMsgId, sessionId, 'assistant', fullResponse, thinkingTrail, now)
      const msgCount = (db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?').get(sessionId) as { count: number }).count
      if (msgCount <= 2) {
        const title = query.slice(0, 60) + (query.length > 60 ? '...' : '')
        db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now, sessionId)
      } else {
        db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
      }
    })
    persistChat()

    return { response: fullResponse, thinkingTrail, messageId: assistantMsgId }
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

  // ── HUMINT ─────────────────────────────────────────────────────────

  ipcMain.handle('chat:recordHumint', async (_event, params: { sessionId: string; confidence?: string }) => {
    const { humintService } = await import('../services/humint/HumintService')
    const report = humintService.createFromSession(params.sessionId, params.confidence || 'medium')
    if (!report) return { error: 'No messages in session' }

    // Sync to Obsidian if enabled
    try {
      const { obsidianService } = await import('../services/obsidian/ObsidianService')
      const md = humintService.exportAsMarkdown(report.id)
      if (md) {
        const date = new Date().toISOString().split('T')[0]
        await obsidianService.syncReport(`humint/${date}/${report.id.slice(0, 8)}.md`, md)
      }
    } catch {}

    return report
  })

  ipcMain.handle('chat:getHumintReports', async () => {
    const { humintService } = await import('../services/humint/HumintService')
    return humintService.getAll()
  })

  // ── Preliminary Reports ─────────────────────────────────────────

  ipcMain.handle('chat:savePreliminaryReport', async (_event, params: { sessionId: string; messageId: string; content: string }) => {
    const db = getDatabase()
    const now = timestamp()
    const { sessionId, messageId, content } = params

    // Extract structured data from LLM response
    const extracted = reportExtractor.extract(content)
    const reportId = generateId()

    // Find source intel reports by matching keywords from the briefing
    const keywords = content.toLowerCase()
      .match(/\b[a-z]{5,}\b/g)?.filter((w) => !['about','which','their','would','could','should','these','those','based','using','other','there','after','before','between'].includes(w)) || []
    const topKeywords = [...new Set(keywords)].slice(0, 5)

    const sourceIds: string[] = []
    if (topKeywords.length > 0) {
      const clauses = topKeywords.map(() => 'LOWER(title) LIKE ?').join(' OR ')
      const vals = topKeywords.map((k) => `%${k}%`)
      const matches = db.prepare(
        `SELECT id FROM intel_reports WHERE ${clauses} ORDER BY created_at DESC LIMIT 20`
      ).all(...vals) as Array<{ id: string }>
      sourceIds.push(...matches.map((m) => m.id))
    }

    // Also check session chat messages for referenced UUIDs
    // Full UUIDv4 pattern (8-4-4-4-12). The previous pattern only matched the
    // first 16 chars of a UUID and produced truncated ids that did not match
    // any row in intel_reports, so preliminary→intel links pointed at ghost
    // ids and silently dropped in the graph.
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

    // Scan assistant messages for cited report ids.
    const sessionMsgs = db.prepare(
      "SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at"
    ).all(sessionId) as Array<{ content: string }>
    for (const msg of sessionMsgs) {
      const uuidMatches = msg.content.match(UUID_RE) || []
      sourceIds.push(...uuidMatches)
    }

    // ALSO scan tool_call_logs — vector_search / intel_search / entity_lookup
    // now emit trailing [id:<uuid>] markers for each returned report. The LLM
    // text alone often omits explicit ids, so this is the primary signal.
    const toolLogs = db.prepare(
      "SELECT result FROM tool_call_logs WHERE session_id = ? AND tool_name IN ('vector_search', 'intel_search', 'entity_lookup', 'graph_query') AND result IS NOT NULL"
    ).all(sessionId) as Array<{ result: string }>
    for (const log of toolLogs) {
      const ids = (log.result || '').match(UUID_RE) || []
      sourceIds.push(...ids)
    }
    // Dedupe + keep only ids that actually exist in intel_reports so the
    // link target is a live node. Without this check, citations that refer
    // to ids the assistant hallucinated would create dangling links.
    const uniqueSourceIds = Array.from(new Set(sourceIds))
    const verifiedSourceIds: string[] = uniqueSourceIds.length > 0
      ? (db.prepare(
          `SELECT id FROM intel_reports WHERE id IN (${uniqueSourceIds.map(() => '?').join(',')})`
        ).all(...uniqueSourceIds) as Array<{ id: string }>).map((r) => r.id)
      : []

    // Insert preliminary report
    db.prepare(`
      INSERT INTO preliminary_reports (id, session_id, chat_message_id, title, content, status, source_report_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'preliminary', ?, ?, ?)
    `).run(reportId, sessionId, messageId, extracted.title, content, JSON.stringify(verifiedSourceIds.slice(0, 200)), now, now)

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

    // Create links from preliminary report to EVERY cited source intel.
    // Previous code capped this at 10 — if the assistant cited 25 intel
    // reports only the first 10 appeared in the relationship graph. Cap is
    // now 200 (same as the source_report_ids store) so graph completeness
    // matches what's listed in the report's citations.
    const linkStmt = db.prepare('INSERT OR IGNORE INTO intel_links (id, source_report_id, target_report_id, link_type, strength, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const insertLinksTx = db.transaction((ids: string[]) => {
      for (const srcId of ids) {
        linkStmt.run(generateId(), reportId, srcId, 'preliminary_reference', 0.8, 'Source intel for preliminary report', now)
      }
    })
    insertLinksTx(verifiedSourceIds.slice(0, 200))

    // Tag the preliminary report
    const tags = ['preliminary-report', `status:preliminary`]
    for (const action of extracted.actions) { tags.push(`action:${action.priority}`) }
    for (const gap of extracted.gaps) { tags.push(`gap:${gap.category}`) }
    for (const tag of [...new Set(tags)]) {
      db.prepare('INSERT OR IGNORE INTO intel_tags (report_id, tag, confidence, source, created_at) VALUES (?, ?, ?, ?, ?)').run(
        reportId, tag, 1.0, 'preliminary', now
      )
    }

    // Auto-extract watch terms from actions and gaps. Uses LLM refinement
    // (when an LLM connection is configured) to drop generic verbs like
    // "increase monitoring" and add scoped phrases like "Iran nuclear weapons
    // program" instead of bare "Iran".
    let watchTermsAdded = 0
    try {
      watchTermsAdded = await watchTermsService.extractFromActionsRefined(reportId)
    } catch (err) {
      // LLM unavailable — fall back to regex-only.
      try { watchTermsAdded = watchTermsService.extractFromActions(reportId) } catch {}
      log.warn(`watchTerms: LLM-refined extraction failed, fell back to regex (${err})`)
    }

    log.info(`Preliminary report saved: ${extracted.title} (${extracted.actions.length} actions, ${extracted.gaps.length} gaps, ${watchTermsAdded} watch terms)`)

    return {
      reportId,
      title: extracted.title,
      actionsCount: extracted.actions.length,
      gapsCount: extracted.gaps.length,
      watchTermsAdded,
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

    // Safe notify — skips destroyed windows and never throws
    const notify = (msg: string, severity: 'info' | 'success' | 'error' = 'info') => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        try { win.webContents.send('app:notification', { title: 'Learnings', body: msg, severity }) } catch {}
      }
    }

    // Per-operation timeout helper — rejects after ms elapses
    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
      ])
    }

    let localFiles = 0
    let obsidianFiles = 0
    let obsidianSkipped = 0
    let obsidianRemaining = 0
    let errorMsg: string | undefined

    // Yields control back to the event loop between batches so IPC handlers
    // (chat sends, UI clicks) get serviced. The main process becomes
    // unresponsive without this when ingesting hundreds of files.
    const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r))

    // Per-run cap so a "Generate Learnings" click is bounded — remaining
    // files get picked up on the next click or the */20m cron run. Keeps
    // any single run under ~5-10 min of embedding time on typical models.
    const MAX_FILES_PER_RUN = 500
    // Concurrency cap. The previous value was 10, which fired 10 simultaneous
    // embedding API calls per batch — that's what made the app feel frozen.
    // 3 keeps the pipeline saturated without monopolising the event loop.
    const BATCH_SIZE = 3

    /** Build the differential signature for a file. Two files with the same
     *  (mtime, size) tuple are assumed identical — Obsidian + local FS both
     *  honor mtime updates on write. Falls back to size-only when mtime is 0. */
    const fileSig = (path: string, mtime: number, size: number): string =>
      mtime > 0 ? `${path}|${mtime}|${size}` : `${path}|0|${size}`

    try {
      // 1. Ingest from DB (has its own try/catch internally)
      notify('Processing intel reports...')
      try {
        const { intelPipeline } = await import('../services/vectordb/IntelPipeline')
        await withTimeout(intelPipeline.runIngestion(), 120_000, 'intelPipeline.runIngestion')
      } catch (err) {
        log.warn(`Learnings: intelPipeline.runIngestion failed (non-fatal): ${err}`)
      }

      // 2. Ingest local ~/.heimdall/memory files (fast — direct filesystem read).
      //    Differential: signature = path|mtime|size. A file's content changing
      //    bumps mtime, so the previous sig becomes stale and we re-embed.
      try {
        const { app: electronApp } = await import('electron')
        const { join } = await import('path')
        const { readdirSync, readFileSync, statSync } = await import('fs')
        const memoryDir = join(electronApp.getPath('home'), '.heimdall', 'memory')

        // Walk → collect candidate paths + stats. Embedding happens AFTER walk
        // so we can yield between embeddings.
        const candidates: Array<{ fullPath: string; entry: string; mtime: number; size: number; sig: string }> = []
        const walkDir = (dir: string): void => {
          let entries: string[]
          try { entries = readdirSync(dir) } catch { return }
          for (const entry of entries) {
            const fullPath = join(dir, entry)
            try {
              const stat = statSync(fullPath)
              if (stat.isDirectory()) { walkDir(fullPath); continue }
              if (!entry.endsWith('.md')) continue
              const sig = fileSig(fullPath, stat.mtimeMs, stat.size)
              if (syncManager.isSynced('vector-local', sig)) continue
              candidates.push({ fullPath, entry, mtime: stat.mtimeMs, size: stat.size, sig })
            } catch { /* unreadable file */ }
          }
        }
        walkDir(memoryDir)

        // Process serially with a yield each — local FS reads are fast but
        // vectorDbService.addReport hits the embeddings API.
        let processed = 0
        for (const c of candidates) {
          if (processed >= MAX_FILES_PER_RUN) break
          try {
            const content = readFileSync(c.fullPath, 'utf-8')
            if (content.length < 50) {
              syncManager.markSynced('vector-local', c.sig) // mark short files done so we don't re-stat them
              continue
            }
            await vectorDbService.addReport({
              id: `local_${c.fullPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}`,
              discipline: 'osint', title: c.entry.replace('.md', ''),
              content: content.slice(0, 3000), summary: null, severity: 'info',
              sourceId: 'local-memory', sourceUrl: null, sourceName: `Local: ${c.entry}`,
              contentHash: c.fullPath, latitude: null, longitude: null,
              verificationScore: 50, reviewed: false, createdAt: Date.now(), updatedAt: Date.now()
            } as any)
            syncManager.markSynced('vector-local', c.sig)
            localFiles++
            processed++
            if (processed % 5 === 0) await yieldToEventLoop()
          } catch (err) {
            log.debug(`Learnings: local file ${c.fullPath} failed: ${err}`)
          }
        }
        log.info(`Learnings: ingested ${localFiles} local memory files (of ${candidates.length} changed)`)
        notify(`${localFiles} local files processed${candidates.length > processed ? ` (${candidates.length - processed} deferred to next run)` : ''}`)
      } catch (err) {
        log.warn(`Learnings: local memory walk failed (non-fatal): ${err}`)
      }

      // 3. Ingest Obsidian vault — DIFFERENTIAL: skip files whose
      //    (path, mtime, size) signature matches the last sync. We use the
      //    `vnd.olrapi.note+json` endpoint which returns content + stat in
      //    one round-trip, so unchanged files cost us 1 HTTP call each
      //    (cheap) but skip the EXPENSIVE embedding step entirely.
      try {
        const { obsidianService } = await import('../services/obsidian/ObsidianService')
        const testConn = await withTimeout(obsidianService.testConnection(), 10_000, 'obsidian.testConnection')
          .catch((err) => {
            log.debug(`Obsidian testConnection failed: ${err}`)
            return { success: false, message: String(err) }
          })

        if (testConn.success) {
          // listFilesCached: 5-min cache so back-to-back clicks don't re-walk
          // the vault (recursive folder API was the bulk of the slowdown).
          const files = await withTimeout(obsidianService.listFilesCached(), 60_000, 'obsidian.listFilesCached')
            .catch((err) => {
              log.warn(`Obsidian listFilesCached failed: ${err}`)
              return [] as string[]
            })
          const allMd = files.filter((f: string) => f.endsWith('.md'))
          log.info(`Learnings: found ${allMd.length} Obsidian files; running differential sync (cap ${MAX_FILES_PER_RUN}/run)`)
          notify(`Checking ${allMd.length} Obsidian files for changes…`)

          // Walk in concurrency-3 batches with a yield between batches.
          let scanned = 0
          for (let i = 0; i < allMd.length; i += BATCH_SIZE) {
            if (obsidianFiles >= MAX_FILES_PER_RUN) {
              obsidianRemaining = allMd.length - i
              log.info(`Learnings: hit per-run cap (${MAX_FILES_PER_RUN}); ${obsidianRemaining} files deferred`)
              break
            }
            const batch = allMd.slice(i, i + BATCH_SIZE)
            const results = await Promise.allSettled(
              batch.map(async (filePath: string) => {
                // Read with stat — single round-trip via note+json.
                const file = await withTimeout(
                  obsidianService.readFileWithStat(filePath),
                  30_000,
                  `obsidian.readFileWithStat:${filePath}`
                )
                const sig = fileSig(filePath, file.mtime, file.size)
                if (syncManager.isSynced('vector-obsidian', sig)) {
                  return { skipped: true } as const
                }
                if (!file.content || file.content.length < 50) {
                  syncManager.markSynced('vector-obsidian', sig)
                  return { skipped: true } as const
                }
                await vectorDbService.addReport({
                  id: `obs_${filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}`,
                  discipline: 'osint',
                  title: filePath.split('/').pop()?.replace('.md', '') || filePath,
                  content: file.content.slice(0, 3000), summary: null, severity: 'info',
                  sourceId: 'obsidian', sourceUrl: null, sourceName: `Obsidian: ${filePath}`,
                  contentHash: filePath, latitude: null, longitude: null,
                  verificationScore: 60, reviewed: false, createdAt: Date.now(), updatedAt: Date.now()
                } as any)
                syncManager.markSynced('vector-obsidian', sig)
                return { ingested: true } as const
              })
            )
            for (const r of results) {
              if (r.status === 'fulfilled') {
                if ('ingested' in r.value && r.value.ingested) obsidianFiles++
                else if ('skipped' in r.value && r.value.skipped) obsidianSkipped++
              }
            }
            scanned += batch.length

            // YIELD: critical — give the event loop a chance to service IPC
            // (chat sends, UI clicks) between batches. Without this, the main
            // process is monopolised for the duration of the sync.
            await yieldToEventLoop()

            if (i > 0 && i % 30 === 0) {
              log.info(`Learnings: Obsidian progress ${scanned}/${allMd.length} (ingested ${obsidianFiles}, unchanged ${obsidianSkipped})`)
              notify(`Obsidian: ${scanned}/${allMd.length} (${obsidianFiles} new/changed, ${obsidianSkipped} unchanged)`)
            }
          }

          log.info(`Learnings: Obsidian sync complete — ${obsidianFiles} ingested, ${obsidianSkipped} unchanged${obsidianRemaining > 0 ? `, ${obsidianRemaining} deferred to next run` : ''}`)
          notify(`Obsidian: ${obsidianFiles} new/changed, ${obsidianSkipped} unchanged${obsidianRemaining > 0 ? ` (${obsidianRemaining} deferred)` : ''}`, 'success')
        }
      } catch (err) {
        log.warn(`Learnings: Obsidian ingestion failed (non-fatal): ${err}`)
      }
    } catch (err) {
      // Catch-all — should rarely be hit since each stage is wrapped, but protects the main process
      errorMsg = err instanceof Error ? `${err.message}` : String(err)
      log.error(`Learnings: top-level failure: ${errorMsg}\n${err instanceof Error ? err.stack : ''}`)
      notify(`Learnings failed: ${errorMsg}`, 'error')
    }

    // Final stats — also wrapped so a bad DB query can't take down the handler
    let stats = { initialized: false }
    let totalReports = 0, totalTags = 0, totalEntities = 0, totalLinks = 0
    try {
      stats = vectorDbService.getStats()
      const db = getDatabase()
      totalReports = (db.prepare('SELECT COUNT(*) as count FROM intel_reports').get() as { count: number }).count
      totalTags = (db.prepare('SELECT COUNT(DISTINCT tag) as count FROM intel_tags').get() as { count: number }).count
      totalEntities = (db.prepare('SELECT COUNT(*) as count FROM intel_entities').get() as { count: number }).count
      totalLinks = (db.prepare('SELECT COUNT(*) as count FROM intel_links').get() as { count: number }).count
    } catch (err) {
      log.warn(`Learnings: final stats query failed: ${err}`)
    }

    return {
      totalReports, totalTags, totalEntities, totalLinks,
      obsidianFiles, localFiles,
      vectorDbInitialized: stats.initialized,
      error: errorMsg
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

  // Multi-Agent Analyst Council (Cross-cutting A)
  ipcMain.handle('council:run', async (_event, params: {
    topic: string
    inputContent: string
    sessionId?: string
    preliminaryReportId?: string
    classification?: string
    connectionId?: string
  }) => {
    return analystCouncilService.run(params)
  })

  ipcMain.handle('council:get', (_event, params: { id: string }) => {
    return analystCouncilService.get(params.id)
  })

  ipcMain.handle('council:list', (_event, params: { sessionId?: string; preliminaryReportId?: string; limit?: number } = {}) => {
    return analystCouncilService.list(params)
  })

  log.info('Chat bridge registered')
}
