import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import {
  MessageSquare, Send, Trash2, Loader2, Plus, FileText, Check,
  Calendar, BookOpen, Brain, Zap, Bot, Edit2, X
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Label } from '@renderer/components/ui/label'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { TagEntityPicker } from '@renderer/components/TagEntityPicker'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
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
  const [chatMode, setChatMode] = useState<'agentic' | 'direct' | 'caveman'>('agentic')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [selectedFilters, setSelectedFilters] = useState<Array<{ type: 'tag' | 'entity'; value: string }>>([])
  const [showExplore, setShowExplore] = useState(false)
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

  // Stream events — debounced state updates for performance
  const streamBufferRef = useRef('')
  const updateTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    const unsubChunk = window.heimdall.on('chat:chunk', (chunk: unknown) => {
      streamBufferRef.current += chunk as string

      // Debounce: batch state updates to max 20/sec (50ms interval)
      if (!updateTimerRef.current) {
        updateTimerRef.current = setTimeout(() => {
          setStreamingContent(streamBufferRef.current)
          updateTimerRef.current = undefined
        }, 50)
      }
    })
    const unsubDone = window.heimdall.on('chat:done', () => {
      // Flush any remaining buffer
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
      setStreamingContent(streamBufferRef.current)
      streamBufferRef.current = ''
      setStreaming(false)
      setStreamingContent('')
    })
    const unsubError = window.heimdall.on('chat:error', (err: unknown) => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
      streamBufferRef.current = ''
      setStreaming(false)
      setStreamingContent('')
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: `Error: ${err}`, createdAt: Date.now()
      }])
    })
    return () => {
      unsubChunk(); unsubDone(); unsubError()
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
    const msgs = await invoke('chat:getHistory', { sessionId }) as Array<{ id: string; role: string; content: string; created_at: number }>
    setMessages((msgs || []).map((m) => ({
      id: m.id, role: m.role as Message['role'], content: m.content, createdAt: m.created_at
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
    if (!text || streaming) return

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
    setStreaming(true)
    setStreamingContent('')

    try {
      const chatHistory = [...messages, userMsg]
        .filter((m) => m.role !== 'system').slice(-20)
        .map((m) => ({ role: m.role, content: m.content }))

      const response = await invoke('chat:send', {
        messages: chatHistory, query: enrichedText, sessionId,
        connectionId: selectedConnection || undefined,
        useAgentic: chatMode === 'agentic',
        mode: chatMode
      }) as string

      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant', content: response, createdAt: Date.now()
      }])
      loadSessions() // Refresh session list to update title/timestamp
    } catch {} finally { setStreaming(false); setStreamingContent('') }
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
                { mode: 'agentic' as const, icon: Bot, label: 'Agent' },
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
                    <MarkdownRenderer content={msg.content} className="text-sm" />
                  </div>
                  {msg.content.length > 200 && (
                    <div className="border-t border-border/50 px-4 py-2 flex items-center justify-between">
                      <SaveReportButton
                        sessionId={activeSessionId}
                        messageId={msg.id}
                        content={msg.content}
                      />
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
                  ? <MarkdownRenderer content={streamingContent} className="text-sm" />
                  : <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{chatMode === 'agentic' ? 'Planning...' : 'Thinking...'}</div>
                }
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
            <Button onClick={sendMessage} disabled={streaming || !input.trim() || connections.length === 0}>
              {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          {activeConn && <p className="text-[10px] text-muted-foreground mt-1">
            {activeConn.name} ({activeConn.model}) | {chatMode === 'agentic' ? 'Agentic' : chatMode === 'caveman' ? 'Caveman' : 'Direct + Vector'}
            {selectedFilters.length > 0 && ` | ${selectedFilters.length} filter${selectedFilters.length > 1 ? 's' : ''} active`}
          </p>}
        </div>
      </div>
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
