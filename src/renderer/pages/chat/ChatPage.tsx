import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MessageSquare, Send, Trash2, Loader2,
  Calendar, BookOpen, Brain, Zap, Bot
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Label } from '@renderer/components/ui/label'
import { cn } from '@renderer/lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

interface LlmConn {
  id: string
  name: string
  model: string
  enabled: boolean
}

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [connections, setConnections] = useState<LlmConn[]>([])
  const [selectedConnection, setSelectedConnection] = useState<string>('')
  const [agenticMode, setAgenticMode] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    loadHistory()
    loadConnections()
  }, [])

  useEffect(() => {
    const unsubChunk = window.heimdall.on('chat:chunk', (chunk: unknown) => {
      setStreamingContent((prev) => prev + (chunk as string))
    })
    const unsubDone = window.heimdall.on('chat:done', () => {
      setStreaming(false)
      setStreamingContent('')
    })
    const unsubError = window.heimdall.on('chat:error', (err: unknown) => {
      setStreaming(false)
      setStreamingContent('')
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: `Error: ${err}`, createdAt: Date.now()
      }])
    })
    return () => { unsubChunk(); unsubDone(); unsubError() }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streamingContent])

  const loadHistory = async () => {
    const history = await invoke('chat:getHistory') as Array<{ id: string; role: string; content: string; created_at: number }>
    setMessages((history || []).map((m) => ({
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

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || streaming) return

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
        messages: chatHistory, query: text,
        connectionId: selectedConnection || undefined,
        useAgentic: agenticMode
      }) as string

      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'assistant', content: response, createdAt: Date.now()
      }])
    } catch {} finally { setStreaming(false); setStreamingContent('') }
  }

  const clearHistory = async () => { await invoke('chat:clearHistory'); setMessages([]) }

  const generateSummary = async (type: 'daily' | 'weekly') => {
    setStreaming(true)
    try {
      const summary = await invoke(type === 'daily' ? 'chat:generateDailySummary' : 'chat:generateWeeklySummary') as string
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: summary, createdAt: Date.now() }])
    } catch (err) {
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `Failed: ${err}`, createdAt: Date.now() }])
    } finally { setStreaming(false) }
  }

  const activeConn = connections.find((c) => c.id === selectedConnection)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Intel Chat</span>
          {connections.length > 0 ? (
            <Select value={selectedConnection} onValueChange={setSelectedConnection}>
              <SelectTrigger className="w-48 h-7 text-xs"><SelectValue placeholder="Select provider..." /></SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="flex items-center gap-1.5"><Brain className="h-3 w-3" />{c.name} ({c.model})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="warning" className="text-[9px]">No LLM configured</Badge>
          )}
          <div className="flex items-center gap-1.5 ml-2">
            <Switch checked={agenticMode} onCheckedChange={setAgenticMode} />
            <Label className="text-xs text-muted-foreground flex items-center gap-1">
              {agenticMode ? <Bot className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {agenticMode ? 'Agentic' : 'Direct'}
            </Label>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => generateSummary('daily')}><Calendar className="h-3 w-3 mr-1" />Daily</Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => generateSummary('weekly')}><BookOpen className="h-3 w-3 mr-1" />Weekly</Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearHistory}><Trash2 className="h-3 w-3" /></Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Bot className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm font-medium">Ask Heimdall about your intelligence data</p>
            <p className="text-xs mt-1 max-w-md text-center">
              {agenticMode ? 'Agentic mode: Plan → Research → Analyze' : 'Direct mode: Quick RAG responses'}
            </p>
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
            <div className={cn('max-w-[80%] rounded-lg px-4 py-3 text-sm',
              msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border'
            )}>
              <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
            </div>
          </div>
        ))}

        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-4 py-3 text-sm bg-card border border-border">
              {streamingContent
                ? <div className="whitespace-pre-wrap leading-relaxed">{streamingContent}</div>
                : <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{agenticMode ? 'Planning analysis...' : 'Thinking...'}</div>
              }
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3 bg-card/50">
        <div className="flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder={agenticMode ? 'Complex query — Heimdall will plan, research, analyze...' : 'Quick question — direct RAG...'}
            className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            rows={2} disabled={streaming} />
          <Button onClick={sendMessage} disabled={streaming || !input.trim() || connections.length === 0} className="self-end">
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {activeConn && <p className="text-[10px] text-muted-foreground mt-1.5">
          Using: {activeConn.name} ({activeConn.model}) | {agenticMode ? 'Agentic (Plan→Research→Analyze)' : 'Direct RAG'}
        </p>}
      </div>
    </div>
  )
}
