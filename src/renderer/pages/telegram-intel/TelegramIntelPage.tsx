import { useEffect, useState, useCallback } from 'react'
import {
  Send, Loader2, Check, X, Search, Image, FileText, MessageSquare,
  Forward, RefreshCw, Power, PowerOff, AlertTriangle, ExternalLink,
  Globe, Moon, ChevronDown, ChevronRight, Settings, ShieldCheck
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import { formatRelativeTime } from '@renderer/lib/utils'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'

interface QueueItem {
  id: string
  telegram_message_id: number
  telegram_chat_id: number
  sender_id: number | null
  sender_username: string | null
  sender_name: string | null
  message_date: number
  message_type: string
  text_preview?: string
  text_content?: string
  media_file_id: string | null
  media_local_path: string | null
  media_mime_type: string | null
  urls: string | null
  onion_urls: string | null
  forward_from_name: string | null
  forward_from_chat_title: string | null
  raw_json?: string
  status: string
  rejection_reason: string | null
  analyst_notes: string | null
  ingested_report_ids: string | null
  reviewed_at: number | null
  created_at: number
}

interface ReceiverStatus {
  running: boolean
  botUsername: string | null
  lastPollAt: number | null
  totalReceived: number
  pendingCount: number
  lastError: string | null
  pollInterval: number
}

const TYPE_ICONS: Record<string, typeof MessageSquare> = {
  text: MessageSquare, photo: Image, document: FileText, forward: Forward
}
const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  processing: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  approved: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  ingested: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  rejected: 'bg-red-500/20 text-red-300 border-red-500/40',
  failed: 'bg-red-500/20 text-red-300 border-red-500/40'
}

const PAGE_SIZE = 50

export function TelegramIntelPage() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [receiverStatus, setReceiverStatus] = useState<ReceiverStatus | null>(null)
  const [selected, setSelected] = useState<QueueItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [mediaPreview, setMediaPreview] = useState<string | null>(null)
  const [approveNotes, setApproveNotes] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const invoke = useCallback((ch: string, p?: unknown) => window.heimdall.invoke(ch, p), [])

  const load = useCallback(async () => {
    try {
      const r = await invoke('telegram-intel:list', {
        status: statusFilter === 'all' ? undefined : statusFilter,
        search: search.trim() || undefined,
        limit: PAGE_SIZE, offset
      }) as { total: number; items: QueueItem[] }
      setItems(r.items)
      setTotal(r.total)
    } catch { /* */ }
  }, [invoke, statusFilter, search, offset])

  const loadStatus = useCallback(async () => {
    try {
      const s = await invoke('telegram-intel:status') as ReceiverStatus
      setReceiverStatus(s)
    } catch { /* */ }
  }, [invoke])

  useEffect(() => { void load(); void loadStatus() }, [load, loadStatus])

  // Live events.
  useEffect(() => {
    const unsubStatus = window.heimdall.on('telegram-intel:status_update', (s: unknown) => {
      setReceiverStatus(s as ReceiverStatus)
    })
    const unsubMsg = window.heimdall.on('telegram-intel:new_message', () => {
      void load()
    })
    return () => { unsubStatus(); unsubMsg() }
  }, [load])

  const selectItem = async (item: QueueItem) => {
    setDetailLoading(true)
    setMediaPreview(null)
    setApproveNotes('')
    setRejectReason('')
    setRejectOpen(false)
    try {
      const full = await invoke('telegram-intel:get', { id: item.id }) as QueueItem | null
      setSelected(full)
      // Load media preview if applicable.
      if (full?.media_local_path && full.message_type === 'photo') {
        try {
          const m = await invoke('telegram-intel:media_preview', { path: full.media_local_path }) as { ok: boolean; data?: string }
          if (m.ok && m.data) setMediaPreview(`data:image/jpeg;base64,${m.data}`)
        } catch { /* */ }
      }
    } finally { setDetailLoading(false) }
  }

  const onApprove = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const r = await invoke('telegram-intel:approve', { id: selected.id, notes: approveNotes.trim() || undefined }) as { ok: boolean; reportIds: string[]; errors: string[] }
      if (r.ok) {
        toast.success(`Approved — ${r.reportIds.length} report(s) created`, { description: r.errors.length > 0 ? `${r.errors.length} warnings` : undefined })
        setSelected(null)
        void load()
      } else {
        toast.error('Approval failed', { description: r.errors[0] })
      }
    } finally { setBusy(false) }
  }

  const onReject = async () => {
    if (!selected || !rejectReason.trim()) return
    setBusy(true)
    try {
      const r = await invoke('telegram-intel:reject', { id: selected.id, reason: rejectReason.trim() }) as { ok: boolean; error?: string }
      if (r.ok) {
        toast.message('Message rejected')
        setSelected(null)
        setRejectOpen(false)
        void load()
      } else {
        toast.error('Rejection failed', { description: r.error })
      }
    } finally { setBusy(false) }
  }

  const onBulkApprove = async () => {
    if (selectedIds.size === 0) return
    setBusy(true)
    try {
      const r = await invoke('telegram-intel:bulk_approve', { ids: Array.from(selectedIds) }) as { succeeded: number; failed: number }
      toast.success(`Bulk approved: ${r.succeeded} succeeded, ${r.failed} failed`)
      setSelectedIds(new Set())
      void load()
    } finally { setBusy(false) }
  }

  const onStartStop = async () => {
    if (receiverStatus?.running) {
      await invoke('telegram-intel:stop')
    } else {
      const r = await invoke('telegram-intel:start') as { ok: boolean; error?: string }
      if (!r.ok) toast.error('Failed to start', { description: r.error })
    }
    void loadStatus()
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const pendingItems = items.filter((i) => i.status === 'pending')
  const parsedUrls = (s: string | null): string[] => { try { return s ? JSON.parse(s) : [] } catch { return [] } }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — Queue list */}
      <div className="w-96 border-r border-border flex flex-col bg-card/30">
        {/* Header */}
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Send className="h-4 w-4 text-blue-400" />
              <h2 className="text-sm font-semibold">Telegram Intel</h2>
              {receiverStatus && (
                <Badge className={cn('text-[10px] border', receiverStatus.running
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-muted text-muted-foreground border-border'
                )}>
                  {receiverStatus.running ? `@${receiverStatus.botUsername || 'bot'}` : 'stopped'}
                </Badge>
              )}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={onStartStop}
                title={receiverStatus?.running ? 'Stop receiver' : 'Start receiver'}>
                {receiverStatus?.running ? <PowerOff className="h-3.5 w-3.5 text-red-400" /> : <Power className="h-3.5 w-3.5" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Link to="/settings">
                <Button size="sm" variant="ghost"><Settings className="h-3.5 w-3.5" /></Button>
              </Link>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }}
              placeholder="Search messages…" className="pl-7 h-7 text-xs" />
          </div>

          {/* Status filter tabs */}
          <div className="flex gap-0.5">
            {['all', 'pending', 'ingested', 'rejected'].map((s) => (
              <button key={s} onClick={() => { setStatusFilter(s); setOffset(0) }}
                className={cn('text-[10px] px-2 py-1 rounded transition-colors capitalize',
                  statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}>
                {s}
              </button>
            ))}
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onBulkApprove} disabled={busy} className="text-xs h-6">
                <Check className="h-3 w-3 mr-1" /> Approve {selectedIds.size}
              </Button>
              <button onClick={() => setSelectedIds(new Set())} className="text-[10px] text-muted-foreground">Clear</button>
            </div>
          )}
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-auto">
          {items.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <Send className="h-8 w-8 opacity-30 mb-2" />
              <p className="text-xs">No messages{statusFilter !== 'all' ? ` with status "${statusFilter}"` : ''}</p>
              {!receiverStatus?.running && <p className="text-[10px] mt-1">Start the receiver bot to begin collecting.</p>}
            </div>
          )}
          {items.map((item) => {
            const Icon = TYPE_ICONS[item.message_type] || MessageSquare
            const isSelected = selected?.id === item.id
            const urls = parsedUrls(item.urls)
            const onionUrls = parsedUrls(item.onion_urls)
            return (
              <div key={item.id}
                className={cn('flex items-start gap-2 px-3 py-2 border-b border-border/50 cursor-pointer transition-colors',
                  isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                )}
                onClick={() => selectItem(item)}
              >
                {item.status === 'pending' && (
                  <input type="checkbox" checked={selectedIds.has(item.id)}
                    onChange={() => toggleSelect(item.id)} onClick={(e) => e.stopPropagation()}
                    className="mt-1 shrink-0" />
                )}
                <Icon className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">{item.sender_name || 'Unknown'}</span>
                    {item.sender_username && <span className="text-[10px] text-muted-foreground">@{item.sender_username}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                    {item.text_preview || `[${item.message_type}]`}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge className={cn('text-[9px] py-0 px-1 border', STATUS_COLORS[item.status] || '')}>
                      {item.status}
                    </Badge>
                    {urls.length > 0 && <Badge variant="outline" className="text-[9px] py-0 px-1 gap-0.5"><Globe className="h-2 w-2" />{urls.length}</Badge>}
                    {onionUrls.length > 0 && <Badge variant="outline" className="text-[9px] py-0 px-1 gap-0.5 border-fuchsia-500/40 text-fuchsia-300"><Moon className="h-2 w-2" />{onionUrls.length}</Badge>}
                    <span className="text-[9px] text-muted-foreground ml-auto">{formatRelativeTime(item.message_date)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="px-3 py-2 border-t border-border flex justify-between text-xs">
            <span className="text-muted-foreground">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Prev</Button>
              <Button size="sm" variant="ghost" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
            </div>
          </div>
        )}
      </div>

      {/* Right panel — Detail */}
      <div className="flex-1 overflow-auto">
        {!selected && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <MessageSquare className="h-10 w-10 opacity-30 mb-2" />
            <p className="text-sm">Select a message to view details</p>
          </div>
        )}
        {detailLoading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {selected && !detailLoading && (
          <div className="p-4 space-y-4">
            {/* Sender header */}
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold">{selected.sender_name || 'Unknown'}</h3>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {selected.sender_username && <span>@{selected.sender_username} · </span>}
                  <span>ID: {selected.sender_id} · </span>
                  <span>Chat: {selected.telegram_chat_id} · </span>
                  <span>{new Date(selected.message_date).toLocaleString()}</span>
                </div>
              </div>
              <Badge className={cn('border', STATUS_COLORS[selected.status] || '')}>{selected.status}</Badge>
            </div>

            {/* Forward provenance */}
            {(selected.forward_from_name || selected.forward_from_chat_title) && (
              <div className="rounded border border-blue-500/30 bg-blue-500/5 p-2 text-xs flex items-center gap-2">
                <Forward className="h-3.5 w-3.5 text-blue-300" />
                <span>Forwarded from: <strong>{selected.forward_from_name || selected.forward_from_chat_title}</strong></span>
              </div>
            )}

            {/* Media preview */}
            {mediaPreview && (
              <div className="rounded border border-border overflow-hidden max-w-lg">
                <img src={mediaPreview} alt="Telegram photo" className="w-full" />
              </div>
            )}
            {selected.message_type === 'document' && selected.media_local_path && (
              <div className="rounded border border-border p-3 flex items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="text-xs font-medium">Document</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{selected.media_local_path.split('/').pop()}</div>
                  <div className="text-[10px] text-muted-foreground">{selected.media_mime_type}</div>
                </div>
              </div>
            )}

            {/* Text content */}
            {selected.text_content && (
              <pre className="text-sm whitespace-pre-wrap bg-muted/30 p-3 rounded border border-border font-mono break-words">
                {selected.text_content}
              </pre>
            )}

            {/* Extracted URLs */}
            {(() => {
              const urls = parsedUrls(selected.urls)
              const onionUrls = parsedUrls(selected.onion_urls)
              if (urls.length === 0 && onionUrls.length === 0) return null
              return (
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Extracted URLs</div>
                  {urls.filter((u) => !onionUrls.includes(u)).map((u) => (
                    <div key={u} className="flex items-center gap-2 text-xs">
                      <Globe className="h-3 w-3 text-blue-400 shrink-0" />
                      <span className="font-mono truncate flex-1">{u}</span>
                    </div>
                  ))}
                  {onionUrls.map((u) => (
                    <div key={u} className="flex items-center gap-2 text-xs">
                      <Moon className="h-3 w-3 text-fuchsia-400 shrink-0" />
                      <span className="font-mono truncate flex-1">{u}</span>
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Rejection reason (if rejected) */}
            {selected.status === 'rejected' && selected.rejection_reason && (
              <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-300">
                <span className="font-semibold">Rejection reason:</span> {selected.rejection_reason}
              </div>
            )}

            {/* Ingested reports (if ingested) */}
            {selected.status === 'ingested' && selected.ingested_report_ids && (
              <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-300 space-y-1">
                <div className="font-semibold flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Ingested reports:</div>
                {(JSON.parse(selected.ingested_report_ids) as string[]).map((id) => (
                  <div key={id} className="font-mono text-[10px]">{id}</div>
                ))}
              </div>
            )}

            {/* Action buttons (only for pending) */}
            {selected.status === 'pending' && !rejectOpen && (
              <div className="space-y-3 border-t border-border pt-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Analyst notes (optional)</div>
                  <textarea value={approveNotes} onChange={(e) => setApproveNotes(e.target.value)}
                    placeholder="Context, assessment, priority…"
                    rows={2} className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background resize-y" />
                </div>
                <div className="flex gap-2">
                  <Button onClick={onApprove} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                    Approve & ingest
                  </Button>
                  <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={busy}
                    className="border-red-500/30 text-red-400 hover:bg-red-500/10">
                    <X className="h-4 w-4 mr-1" /> Reject
                  </Button>
                </div>
              </div>
            )}

            {/* Reject form */}
            {selected.status === 'pending' && rejectOpen && (
              <div className="space-y-3 border-t border-border pt-3 rounded border border-red-500/30 bg-red-500/5 p-3">
                <div className="flex items-center gap-2 text-xs text-red-300 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5" /> Rejection reason (required)
                </div>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Why is this message being rejected?"
                  rows={2} autoFocus
                  className="w-full text-xs px-2 py-1.5 rounded border border-red-500/40 bg-background resize-y" />
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => { setRejectOpen(false); setRejectReason('') }}>Back</Button>
                  <Button size="sm" onClick={onReject} disabled={busy || !rejectReason.trim()}
                    className="bg-red-600 hover:bg-red-500 text-red-50">
                    {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <X className="h-3.5 w-3.5 mr-1" />}
                    Confirm reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
