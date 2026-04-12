import { useState, useEffect, useRef, useCallback } from 'react'
import {
  MessageSquare, Send, Trash2, Loader2, FileText,
  Calendar, BookOpen
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  useEffect(() => {
    loadHistory()
  }, [])

  // Subscribe to streaming events
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
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Error: ${err}`,
        createdAt: Date.now()
      }])
    })
    return () => { unsubChunk(); unsubDone(); unsubError() }
  }, [])

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, streamingContent])

  const loadHistory = async () => {
    const history = await invoke('chat:getHistory') as Array<{ id: string; role: string; content: string; created_at: number }>
    setMessages((history || []).map((m) => ({
      id: m.id,
      role: m.role as Message['role'],
      content: m.content,
      createdAt: m.created_at
    })))
  }

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || streaming) return

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now()
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setStreamingContent('')

    try {
      const chatHistory = [...messages, userMsg]
        .filter((m) => m.role !== 'system')
        .slice(-20) // Last 20 messages for context
        .map((m) => ({ role: m.role, content: m.content }))

      const response = await invoke('chat:send', {
        messages: chatHistory,
        query: text
      }) as string

      // Add assistant response (streaming already showed it)
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        createdAt: Date.now()
      }])
    } catch {
      // Error handled by chat:error event
    } finally {
      setStreaming(false)
      setStreamingContent('')
    }
  }

  const clearHistory = async () => {
    await invoke('chat:clearHistory')
    setMessages([])
  }

  const generateSummary = async (type: 'daily' | 'weekly') => {
    setStreaming(true)
    try {
      const summary = await invoke(type === 'daily' ? 'chat:generateDailySummary' : 'chat:generateWeeklySummary') as string
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        createdAt: Date.now()
      }])
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Failed to generate summary: ${err}`,
        createdAt: Date.now()
      }])
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Intel Chat</span>
          <Badge variant="outline" className="text-xs">{messages.length} messages</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => generateSummary('daily')}>
            <Calendar className="h-3 w-3 mr-1" /> Daily Summary
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => generateSummary('weekly')}>
            <BookOpen className="h-3 w-3 mr-1" /> Weekly Summary
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearHistory}>
            <Trash2 className="h-3 w-3 mr-1" /> Clear
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <MessageSquare className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm font-medium">Ask Heimdall about your intelligence data</p>
            <p className="text-xs mt-1 max-w-md text-center">
              The AI will search your collected intel reports and provide analysis.
              Try: "What are the latest critical threats?" or "Summarize recent cyber intelligence"
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[75%] rounded-lg px-4 py-3 text-sm',
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-card border border-border'
            )}>
              <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
            </div>
          </div>
        ))}

        {/* Streaming indicator */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[75%] rounded-lg px-4 py-3 text-sm bg-card border border-border">
              {streamingContent ? (
                <div className="whitespace-pre-wrap leading-relaxed">{streamingContent}</div>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Analyzing intelligence data...</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border p-3 bg-card/50">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder="Ask about your intelligence data... (Enter to send, Shift+Enter for new line)"
            className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            rows={2}
            disabled={streaming}
          />
          <Button onClick={sendMessage} disabled={streaming || !input.trim()} className="self-end">
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
