import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import {
  MessageSquare, Send, Trash2, Loader2, Plus, FileText, Check, Wrench, Shield,
  Calendar, BookOpen, Brain, Zap, Bot, Edit2, X, Sparkles
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Label } from '@renderer/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { PlanApprovalModal, type PlanPreview, type PlanEdits } from '@renderer/components/PlanApprovalModal'
import { IcdProbabilityHints } from '@renderer/components/IcdProbabilityHints'
import { AnalystCouncilPanel } from '@renderer/components/AnalystCouncilPanel'
import { ThinkingBlocks } from '@renderer/components/ThinkingBlock'
import { TagEntityPicker } from '@renderer/components/TagEntityPicker'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** Full streamed thinking trail (planning, tool calls, dark-web search,
   *  intermediate analyses) captured during the response. Available via
   *  the "Show thinking" button on the assistant card. */
  thinkingTrail?: string | null
}

interface ChatSession {
  id: string
  title: string
  messageCount: number
  lastMessage: string
  createdAt: number
  updatedAt: number
}

interface LlmConn {
  id: string
  name: string
  model: string
  enabled: boolean
}

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [connections, setConnections] = useState<LlmConn[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string>('')
  const [chatMode, setChatMode] = useState<'agentic' | 'direct' | 'caveman' | 'agent'>('agentic')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [selectedFilters, setSelectedFilters] = useState<Array<{ type: 'tag' | 'entity'; value: string }>>([])
  const [showExplore, setShowExplore] = useState(false)
  // Plan-approval flow state — only active in agentic mode.
  const [pendingPlan, setPendingPlan] = useState<PlanPreview | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planReworking, setPlanReworking] = useState(false)
  // Cached user query + history for re-planning on rework without re-typing.
  const pendingQueryRef = useRef<{ text: string; enriched: string; sessionId: string; history: Array<{ role: string; content: string }> } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  // Load sessions on mount + check ingestion status
  useEffect(() => {
    loadSessions()
    loadConnections()
    // Poll ingestion status
    const checkIngesting = async () => {
      try {
        const ingesting = await invoke('chat:isIngesting') as boolean
        setLearningsLoading(ingesting)
      } catch {}
    }
    checkIngesting()
    const interval = setInterval(checkIngesting, 5000)
    return () => clearInterval(interval)
  }, [])

  // Stream events — array buffer (O(1) push) instead of string concat (O(n))
  const streamChunksRef = useRef<string[]>([])
  const updateTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    const unsubChunk = window.heimdall.on('chat:chunk', (chunk: unknown) => {
      streamChunksRef.current.push(chunk as string)

      // Debounce: batch state updates to max 20/sec (50ms interval)
      if (!updateTimerRef.current) {
        updateTimerRef.current = setTimeout(() => {
          setStreamingContent(streamChunksRef.current.join(''))
          updateTimerRef.current = undefined
        }, 50)
      }
    })
    const unsubDone = window.heimdall.on('chat:done', () => {
      // Flush any remaining buffer. The trail is captured inside sendMessage()
      // via streamChunksRef so it can be attached to the assistant message
      // we're about to render — clearing here would lose it.
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
      setStreamingContent(streamChunksRef.current.join(''))
      setStreaming(false)
      // Note: streamChunksRef + streamingContent are cleared in sendMessage()
      // AFTER the assistant message is committed with the trail attached.
    })
    const unsubError = window.heimdall.on('chat:error', (err: unknown) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
      streamChunksRef.current = []
      setStreaming(false)
      setStreamingContent('')
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: `Error: ${err}`, createdAt: Date.now()
      }])
    })
    // Background refinement push — merge refined queries into the open
    // modal's plan WITHOUT overriding any edits the analyst already made.
    const unsubRefined = window.heimdall.on('chat:planRefined', (payload: unknown) => {
      const p = payload as { planId: string; refinedQueries: Record<string, string> }
      setPendingPlan((prev) => {
        if (!prev || prev.planId !== p.planId) return prev
        return {
          ...prev,
          proposedCalls: prev.proposedCalls.map((c) => {
            const refined = p.refinedQueries[c.id]
            return refined && refined !== c.query ? { ...c, query: refined } : c
          })
        }
      })
    })
    return () => {
      unsubChunk(); unsubDone(); unsubError(); unsubRefined()
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
    }
  }, [])

  // Auto-scroll — throttled to once per 100ms, no smooth during streaming
  useEffect(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = setTimeout(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: streaming ? 'auto' : 'smooth'
      })
    }, 100)
    return () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current) }
  }, [messages, streamingContent, streaming])

  const loadSessions = async () => {
    const s = await invoke('chat:getSessions') as ChatSession[]
    setSessions(s || [])
    // Select most recent or create new
    if (s && s.length > 0 && !activeSessionId) {
      setActiveSessionId(s[0].id)
      loadMessages(s[0].id)
    }
  }

  const loadMessages = async (sessionId: string) => {
    const msgs = await invoke('chat:getHistory', { sessionId }) as Array<{ id: string; role: string; content: string; created_at: number; thinking_trail?: string | null }>
    setMessages((msgs || []).map((m) => ({
      id: m.id, role: m.role as Message['role'], content: m.content, createdAt: m.created_at,
      thinkingTrail: m.thinking_trail || null
    })))
  }

  const loadConnections = async () => {
    try {
      const conns = await invoke('chat:getConnections') as LlmConn[]
      setConnections(conns || [])
      if (conns?.length > 0 && !selectedConnection) setSelectedConnection(conns[0].id)
    } catch {}
  }

  const selectSession = (id: string) => {
    setActiveSessionId(id)
    loadMessages(id)
  }

  const createSession = async () => {
    const session = await invoke('chat:createSession') as ChatSession
    setSessions((prev) => [session, ...prev])
    setActiveSessionId(session.id)
    setMessages([])
  }

  const deleteSession = async (id: string) => {
    await invoke('chat:deleteSession', { id })
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (activeSessionId === id) {
      const remaining = sessions.filter((s) => s.id !== id)
      if (remaining.length > 0) {
        selectSession(remaining[0].id)
      } else {
        setActiveSessionId('')
        setMessages([])
      }
    }
  }

  const renameSession = async (id: string, title: string) => {
    await invoke('chat:renameSession', { id, title })
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title } : s))
    setEditingTitle(null)
  }

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || streaming || planBusy || pendingPlan) return

    // Create session if none active
    let sessionId = activeSessionId
    if (!sessionId) {
      const session = await invoke('chat:createSession') as ChatSession
      setSessions((prev) => [session, ...prev])
      sessionId = session.id
      setActiveSessionId(sessionId)
    }

    // Prepend filter context to query
    let enrichedText = text
    if (selectedFilters.length > 0) {
      const filterCtx = selectedFilters.map((f) => `[${f.type}:${f.value}]`).join(' ')
      enrichedText = `Context filters: ${filterCtx}\n\nQuery: ${text}`
    }

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: Date.now() }
    setMessages((prev) => [...prev, userMsg])
    setInput('')

    const chatHistory = [...messages, userMsg]
      .filter((m) => m.role !== 'system').slice(-20)
      .map((m) => ({ role: m.role, content: m.content }))

    // ─── Agentic mode: gate through plan-approval modal ────────────
    if (chatMode === 'agentic') {
      pendingQueryRef.current = { text, enriched: enrichedText, sessionId, history: chatHistory }
      await requestPlan({ reworkFeedback: undefined, previousPlanId: undefined })
      return
    }

    // ─── All other modes: streaming send as before ─────────────────
    setStreaming(true)
    setStreamingContent('')
    try {
      const result = await invoke('chat:send', {
        messages: chatHistory, query: enrichedText, sessionId,
        connectionId: selectedConnection || undefined,
        useAgentic: false,
        mode: chatMode
      }) as { response: string; thinkingTrail?: string | null; messageId?: string } | string

      const response = typeof result === 'string' ? result : result.response
      const thinkingTrail = typeof result === 'string'
        ? streamChunksRef.current.join('') || null
        : (result.thinkingTrail || streamChunksRef.current.join('') || null)
      const assistantId = (typeof result === 'object' && result.messageId) || crypto.randomUUID()

      setMessages((prev) => [...prev, {
        id: assistantId, role: 'assistant', content: response, createdAt: Date.now(),
        thinkingTrail
      }])
      loadSessions()
    } catch {} finally {
      setStreaming(false)
      setStreamingContent('')
      streamChunksRef.current = []
    }
  }

  /**
   * Build (or rebuild after rework) a plan for the cached pending query and
   * open the modal. If the planner can't produce a structured plan we fall
   * back to the streaming hybridRag path so the analyst still gets an answer.
   */
  const requestPlan = async (opts: { reworkFeedback?: string; previousPlanId?: string }) => {
    const cached = pendingQueryRef.current
    if (!cached) return
    setPlanBusy(true)
    setPlanReworking(!!opts.reworkFeedback)
    try {
      const r = await invoke('chat:planRequest', {
        messages: cached.history,
        query: cached.enriched,
        sessionId: cached.sessionId,
        connectionId: selectedConnection || undefined,
        reworkFeedback: opts.reworkFeedback,
        previousPlanId: opts.previousPlanId
      }) as { ok: boolean; preview?: PlanPreview; reason?: string; message?: string }

      if (!r.ok || !r.preview) {
        toast.error('Planning failed', { description: r.message || 'Falling back to direct hybrid RAG' })
        setPendingPlan(null)
        // Fall back: just stream a direct send so the analyst still gets an answer.
        await directSendFallback(cached)
        pendingQueryRef.current = null
      } else {
        setPendingPlan(r.preview)
      }
    } catch (err) {
      toast.error('Planning error', { description: String(err) })
      setPendingPlan(null)
    } finally {
      setPlanBusy(false)
      setPlanReworking(false)
    }
  }

  /** Used when planning fails — stream a direct, non-agentic answer so the
   *  analyst's question doesn't disappear into the void. */
  const directSendFallback = async (cached: NonNullable<typeof pendingQueryRef.current>) => {
    setStreaming(true)
    setStreamingContent('')
    try {
      const result = await invoke('chat:send', {
        messages: cached.history, query: cached.enriched, sessionId: cached.sessionId,
        connectionId: selectedConnection || undefined,
        useAgentic: false, mode: 'direct'
      }) as { response: string; thinkingTrail?: string | null; messageId?: string } | string
      const response = typeof result === 'string' ? result : result.response
      const thinkingTrail = typeof result === 'string'
        ? streamChunksRef.current.join('') || null
        : (result.thinkingTrail || streamChunksRef.current.join('') || null)
      const assistantId = (typeof result === 'object' && result.messageId) || crypto.randomUUID()
      setMessages((prev) => [...prev, {
        id: assistantId, role: 'assistant', content: response, createdAt: Date.now(), thinkingTrail
      }])
      loadSessions()
    } finally {
      setStreaming(false); setStreamingContent(''); streamChunksRef.current = []
    }
  }

  const handlePlanApprove = async (edits: PlanEdits) => {
    if (!pendingPlan || !pendingQueryRef.current) return
    const planId = pendingPlan.planId
    const cached = pendingQueryRef.current
    // Close modal, switch to streaming mode.
    setPendingPlan(null)
    setStreaming(true)
    setStreamingContent('')
    try {
      const result = await invoke('chat:executePlan', {
        planId, sessionId: cached.sessionId, edits
      }) as { ok: boolean; response?: string; thinkingTrail?: string | null; messageId?: string; reason?: string; message?: string }

      if (!result.ok) {
        toast.error('Execution failed', { description: result.message || 'Plan could not be executed' })
        return
      }
      const thinkingTrail = result.thinkingTrail || streamChunksRef.current.join('') || null
      const assistantId = result.messageId || crypto.randomUUID()
      setMessages((prev) => [...prev, {
        id: assistantId, role: 'assistant', content: result.response || '', createdAt: Date.now(), thinkingTrail
      }])
      loadSessions()
    } catch (err) {
      toast.error('Execution error', { description: String(err) })
    } finally {
      setStreaming(false)
      setStreamingContent('')
      streamChunksRef.current = []
      pendingQueryRef.current = null
    }
  }

  const handlePlanRework = async (feedback: string) => {
    if (!pendingPlan) return
    const previousPlanId = pendingPlan.planId
    // Cancel the old plan on the server (frees memory) and request a new one.
    try { await invoke('chat:cancelPlan', { planId: previousPlanId }) } catch {}
    await requestPlan({ reworkFeedback: feedback, previousPlanId })
  }

  const handlePlanCancel = async () => {
    if (pendingPlan) {
      try { await invoke('chat:cancelPlan', { planId: pendingPlan.planId }) } catch {}
    }
    setPendingPlan(null)
    pendingQueryRef.current = null
    // Remove the user message we optimistically rendered, since the analyst chose not to proceed.
    setMessages((prev) => prev.slice(0, -1))
    setInput((prev) => prev || pendingQueryRef.current?.text || '')
  }

  const generateSummary = async (type: 'daily' | 'weekly') => {
    setStreaming(true)
    try {
      const summary = await invoke(type === 'daily' ? 'chat:generateDailySummary' : 'chat:generateWeeklySummary') as string
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: summary, createdAt: Date.now() }])
    } catch (err) {
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `Failed: ${err}`, createdAt: Date.now() }])
    } finally { setStreaming(false) }
  }

  const [learningsLoading, setLearningsLoading] = useState(false)

  const generateLearnings = async () => {
    setLearningsLoading(true)
    try {
      const result = await invoke('chat:generateLearnings') as {
        totalReports: number; totalTags: number; totalEntities: number; totalLinks: number;
        obsidianFiles?: number; localFiles?: number; vectorDbInitialized: boolean
      }
      toast.success('Knowledge Ingestion Complete', {
        description: `${result.totalReports} reports, ${result.obsidianFiles || 0} Obsidian files, ${result.localFiles || 0} local files`
      })
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant', createdAt: Date.now(),
        content: `## Knowledge Ingestion Complete\n\n` +
          `| Metric | Count |\n|--------|-------|\n` +
          `| Reports Processed | ${result.totalReports} |\n` +
          `| Obsidian Vault Files | ${result.obsidianFiles || 0} |\n` +
          `| Local Memory Files | ${result.localFiles || 0} |\n` +
          `| Tags Generated | ${result.totalTags} |\n` +
          `| Entities Extracted | ${result.totalEntities} |\n` +
          `| Links Discovered | ${result.totalLinks} |\n` +
          `| Vector DB | ${result.vectorDbInitialized ? 'Active' : 'Inactive'} |\n\n` +
          `All intelligence data including Obsidian vault and local memory files has been processed and ingested into the vector database.`
      }])
    } catch (err) {
      toast.error('Learnings generation failed', { description: String(err) })
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `Learnings generation failed: ${err}`, createdAt: Date.now() }])
    } finally { setLearningsLoading(false) }
  }

  const activeConn = connections.find((c) => c.id === selectedConnection)
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  return (
    <div className="flex h-full">
      {/* Sessions sidebar */}
      <div className="w-56 border-r border-border bg-card/50 flex flex-col">
        <div className="p-3 border-b border-border">
          <Button variant="outline" size="sm" className="w-full text-xs" onClick={createSession}>
            <Plus className="h-3 w-3 mr-1.5" /> New Chat
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'group flex items-start gap-1 px-2 py-2 rounded-md cursor-pointer text-xs transition-colors',
                activeSessionId === session.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
              )}
              onClick={() => selectSession(session.id)}
            >
              {editingTitle === session.id ? (
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') renameSession(session.id, editTitle); if (e.key === 'Escape') setEditingTitle(null) }}
                  onBlur={() => renameSession(session.id, editTitle)}
                  className="h-5 text-xs px-1"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <MessageSquare className="h-3 w-3 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{session.title}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {session.messageCount} msgs · {formatRelativeTime(session.updatedAt)}
                    </div>
                  </div>
                  <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); setEditingTitle(session.id); setEditTitle(session.title) }}
                      className="p-0.5 hover:text-foreground"><Edit2 className="h-2.5 w-2.5" /></button>
                    <button onClick={(e) => { e.stopPropagation(); deleteSession(session.id) }}
                      className="p-0.5 hover:text-destructive"><Trash2 className="h-2.5 w-2.5" /></button>
                  </div>
                </>
              )}
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-[10px] text-muted-foreground text-center py-4">No chat sessions yet</p>
          )}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold truncate max-w-48">{activeSession?.title || 'Intel Chat'}</span>
            {connections.length > 0 ? (
              <Select value={selectedConnection} onValueChange={setSelectedConnection}>
                <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Provider..." /></SelectTrigger>
                <SelectContent>
                  {connections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name} ({c.model})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : <Badge variant="warning" className="text-[9px]">No LLM</Badge>}
            <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
              {([
                { mode: 'agent' as const, icon: Wrench, label: 'Tools' },
                { mode: 'agentic' as const, icon: Bot, label: 'Agentic' },
                { mode: 'direct' as const, icon: Zap, label: 'Direct' },
                { mode: 'caveman' as const, icon: MessageSquare, label: 'Caveman' }
              ]).map(({ mode, icon: Icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setChatMode(mode)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors',
                    chatMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="h-3 w-3" />{label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 text-xs border-amber-500/30 text-amber-500 hover:bg-amber-500/10" onClick={async () => {
              if (!activeSessionId) return
              try {
                const result = await invoke('chat:recordHumint', { sessionId: activeSessionId }) as any
                if (result.error) { toast.error(result.error); return }
                toast.success('HUMINT Recorded', { description: `${result.sourceReportIds?.length || 0} sources, ${result.toolCallsUsed?.length || 0} tools` })
              } catch (err) { toast.error('Failed', { description: String(err) }) }
            }} disabled={!activeSessionId || messages.length === 0}>
              <Shield className="h-3 w-3 mr-1" />Record HUMINT
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={generateLearnings} disabled={learningsLoading}>
              {learningsLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Brain className="h-3 w-3 mr-1" />}
              {learningsLoading ? 'Processing...' : 'Generate Learnings'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => generateSummary('daily')}>
              <Calendar className="h-3 w-3 mr-1" />Daily
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => generateSummary('weekly')}>
              <BookOpen className="h-3 w-3 mr-1" />Weekly
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
          {messages.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Bot className="h-12 w-12 mb-3 opacity-30" />
              <p className="text-sm font-medium">Ask Heimdall about your intelligence data</p>
              <p className="text-xs mt-1">{chatMode === 'agentic' ? 'Agentic: Plan → Research → Analyze' : 'Direct: Quick RAG + Vector search'}</p>
              <div className="flex flex-wrap gap-2 mt-4 max-w-lg justify-center">
                {['What are the latest critical threats?', 'Analyze recent cyber intelligence',
                  'Find connections between recent events', 'Summarize geopolitical situation'
                ].map((q) => (
                  <button key={q} onClick={() => setInput(q)}
                    className="text-xs px-3 py-1.5 rounded-full border border-border hover:border-primary hover:text-primary transition-colors">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[80%] rounded-lg text-sm',
                msg.role === 'user' ? 'bg-primary text-primary-foreground px-4 py-3' : 'bg-card border border-border'
              )}>
                {msg.role === 'user' ? (
                  <div className="whitespace-pre-wrap px-4 py-3">{msg.content}</div>
                ) : (<>
                  <div className="px-4 py-3">
                    <ThinkingBlocks content={msg.content} isStreaming={false} />
                    {/* ICD 203 lint — surfaces ambiguous probability words
                        (likely / could / possibly) with the canonical
                        estimative-probability alternatives. Renders nothing
                        if the message is clean. */}
                    <IcdProbabilityHints content={msg.content} />
                    {/* Multi-Agent Analyst Council — only offered for
                        substantive messages (avoid running on short
                        clarifications / one-liners). */}
                    {msg.content.length > 400 && (
                      <AnalystCouncilPanel
                        content={msg.content}
                        sessionId={activeSessionId}
                      />
                    )}
                  </div>
                  {(msg.content.length > 200 || msg.thinkingTrail) && (
                    <div className="border-t border-border/50 px-4 py-2 flex items-center justify-between gap-2">
                      <SaveReportButton
                        sessionId={activeSessionId}
                        messageId={msg.id}
                        content={msg.content}
                      />
                      {msg.thinkingTrail && msg.thinkingTrail.trim().length > 0 && (
                        <ShowThinkingButton trail={msg.thinkingTrail} />
                      )}
                    </div>
                  )}
                </>)}
              </div>
            </div>
          ))}

          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-4 py-3 text-sm bg-card border border-border">
                {streamingContent
                  ? <ThinkingBlocks content={streamingContent} isStreaming={true} />
                  : <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{chatMode === 'agentic' ? 'Planning...' : 'Thinking...'}</div>
                }
              </div>
            </div>
          )}

          {/* Planning indicator — shown while the planner LLM is producing
              a plan in agentic mode (the modal opens once it returns). On
              local Ollama models this can take 60-120s so the user needs
              feedback that something is happening. */}
          {planBusy && !pendingPlan && !streaming && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-lg px-4 py-3 text-sm bg-card border border-fuchsia-400/30 bg-fuchsia-400/5">
                <div className="flex items-center gap-2 text-fuchsia-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="font-semibold">{planReworking ? 'Reworking plan based on your feedback…' : 'Planner LLM is building a research plan…'}</span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  This can take 60-120 seconds on local models. The plan-approval modal will open as soon as the planner returns.
                  Refined per-tool queries will continue arriving in the background after the modal opens.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border p-3 bg-card/50">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <TagEntityPicker selected={selectedFilters} onSelectionChange={setSelectedFilters} />
              <textarea value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                placeholder={chatMode === 'agentic' ? 'Complex query — Plan → Research → Analyze...' : 'Quick question — Vector + RAG...'}
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                rows={2} disabled={streaming} />
            </div>
            <Button onClick={sendMessage} disabled={streaming || planBusy || !!pendingPlan || !input.trim() || connections.length === 0}>
              {(streaming || planBusy) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          {activeConn && <p className="text-[10px] text-muted-foreground mt-1">
            {activeConn.name} ({activeConn.model}) | {chatMode === 'agentic' ? 'Agentic (plan-approved)' : chatMode === 'caveman' ? 'Caveman' : 'Direct + Vector'}
            {selectedFilters.length > 0 && ` | ${selectedFilters.length} filter${selectedFilters.length > 1 ? 's' : ''} active`}
          </p>}
        </div>
      </div>

      {/* Plan-approval modal — only mounted when there's a pending plan in agentic mode */}
      <PlanApprovalModal
        preview={pendingPlan}
        busy={planBusy}
        reworking={planReworking}
        onApprove={handlePlanApprove}
        onRework={handlePlanRework}
        onCancel={handlePlanCancel}
      />
    </div>
  )
}

// Save as Preliminary Report button component
function SaveReportButton({ sessionId, messageId, content }: { sessionId: string; messageId: string; content: string }) {
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ actionsCount: number; gapsCount: number } | null>(null)

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await window.heimdall.invoke('chat:savePreliminaryReport', { sessionId, messageId, content }) as {
        reportId: string; title: string; actionsCount: number; gapsCount: number
      }
      setSaved(true)
      setResult(res)
      toast.success('Preliminary Report Saved', {
        description: `${res.actionsCount} actions, ${res.gapsCount} gaps extracted`
      })
    } catch (err) {
      toast.error('Failed to save report', { description: String(err) })
    }
    setSaving(false)
  }

  if (saved && result) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-green-500">
        <Check className="h-3 w-3" />
        <span>Saved — {result.actionsCount} actions, {result.gapsCount} gaps</span>
      </div>
    )
  }

  return (
    <button
      onClick={handleSave}
      disabled={saving}
      className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors"
    >
      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
      {saving ? 'Saving...' : 'Save as Preliminary Report'}
    </button>
  )
}

/**
 * "Show thinking" button — opens a popup that replays the full streamed
 * trail captured during the response (planning steps, tool calls, dark-web
 * search progress, intermediate analyses, fenced tool results). Renders the
 * trail with the same ThinkingBlocks parser used in the live progress card,
 * so steps appear as collapsible color-coded sections.
 */
function ShowThinkingButton({ trail }: { trail: string }) {
  const [open, setOpen] = useState(false)
  // Quick metric so the button label is informative without parsing twice.
  // Use word-boundary match so "Plan" doesn't double-count with "Planning".
  const stepCount = (trail.match(/\*\*\[(Planning|Plan|Researching|Research|Analyzing|Searching|Tool|Executing)\b[^\]]*\]\*\*/gi) || []).length
  const toolCount = (trail.match(/\*\*\[(Tool|Executing):/gi) || []).length

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors"
        title={`${stepCount} step${stepCount === 1 ? '' : 's'}${toolCount > 0 ? ` · ${toolCount} tool call${toolCount === 1 ? '' : 's'}` : ''}`}
      >
        <Sparkles className="h-3 w-3" />
        Show thinking
        {stepCount > 0 && <span className="text-muted-foreground/70">({stepCount}{toolCount > 0 ? `, ${toolCount} tool${toolCount === 1 ? '' : 's'}` : ''})</span>}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Thinking trail
            </DialogTitle>
            <DialogDescription>
              The full reasoning the agent went through to produce its answer — planning steps,
              tool calls (vector search, web fetch, dark-web lookups, knowledge-graph traversal),
              and intermediate analyses.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto flex-1 -mx-6 px-6">
            <ThinkingBlocks content={trail} isStreaming={false} expanded={true} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
