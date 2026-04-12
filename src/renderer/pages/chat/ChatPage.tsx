import { MessageSquare } from 'lucide-react'

export function ChatPage() {
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Intel Chat</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Chat with an LLM to analyze and make sense of collected intelligence data.
      </p>
      <div className="mt-8 rounded-lg border border-dashed border-border p-12 text-center">
        <MessageSquare className="mx-auto h-12 w-12 text-muted-foreground/30" />
        <p className="mt-4 text-muted-foreground">LLM chat coming soon</p>
        <p className="text-sm text-muted-foreground/70">Chat will be available in Phase 7</p>
      </div>
    </div>
  )
}
