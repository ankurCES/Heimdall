// BriefingsPage — v1.6.0 viewer for the automated daily intel briefing.
//
// Master/detail layout. Left pane lists every briefing the cron has
// produced (and any manual "Generate now" runs). Right pane renders
// the LLM-synthesised markdown body with the existing
// MarkdownRenderer; status/error states surface inline so a failed
// generation doesn't disappear silently.

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  FileText, RefreshCw, Loader2, AlertCircle, CheckCircle2, Clock as ClockIcon,
  ScrollText, Trash2, Settings as SettingsIcon, Play, Download, ChevronDown, Mail,
  GitCompare, TrendingUp, TrendingDown, Minus
} from 'lucide-react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator
} from '@renderer/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Badge } from '@renderer/components/ui/badge'
import { useSetting } from '@renderer/hooks/useSettings'
import { MarkdownRenderer } from '@renderer/components/MarkdownRenderer'
import { cn, formatRelativeTime } from '@renderer/lib/utils'

interface DailyBriefing {
  id: string
  period_start: number
  period_end: number
  generated_at: number
  status: 'generating' | 'ready' | 'error'
  classification: string
  model: string | null
  intel_count: number
  transcript_count: number
  high_severity_count: number
  body_md: string | null
  sources_json: string | null
  error_text: string | null
}

function fmtRange(start: number, end: number): string {
  const s = new Date(start), e = new Date(end)
  if (s.toDateString() === e.toDateString()) {
    return `${s.toLocaleDateString()} ${s.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${e.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return `${s.toLocaleDateString()} → ${e.toLocaleDateString()}`
}

function StatusPill({ status }: { status: DailyBriefing['status'] }) {
  if (status === 'ready') {
    return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Ready</span>
  }
  if (status === 'generating') {
    return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Generating</span>
  }
  return <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-600 dark:text-red-400 inline-flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Error</span>
}

interface BriefingDiffResult {
  from: { id: string; period_end: number; intel_count: number; high_severity_count: number }
  to: { id: string; period_end: number; intel_count: number; high_severity_count: number }
  new_intel_ids: string[]
  carried_intel_ids: string[]
  new_transcript_ids: string[]
  carried_transcript_ids: string[]
  high_severity_delta: number
  intel_count_delta: number
  summary_md: string
  generated_at: number
}

function DiffDeltaIcon({ delta }: { delta: number }) {
  if (delta > 0) return <TrendingUp className="h-3 w-3 text-red-600 dark:text-red-400" />
  if (delta < 0) return <TrendingDown className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
  return <Minus className="h-3 w-3 text-muted-foreground" />
}

function DiffPanel({ diff, onClose }: { diff: BriefingDiffResult; onClose: () => void }) {
  const fmtDate = (ts: number) => new Date(ts).toLocaleString()
  const noChange =
    diff.new_intel_ids.length === 0 &&
    diff.new_transcript_ids.length === 0 &&
    diff.high_severity_delta === 0 &&
    diff.intel_count_delta === 0
  return (
    <div className="border border-primary/30 bg-primary/5 rounded-md p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-primary" /> Delta vs previous briefing
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
            {fmtDate(diff.from.period_end)} → {fmtDate(diff.to.period_end)}
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-0.5" title="Close">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 text-[11px]">
        <div className="border border-border rounded p-2 bg-card">
          <div className="text-muted-foreground">Intel volume</div>
          <div className="text-base font-semibold flex items-center gap-1.5 mt-0.5">
            <DiffDeltaIcon delta={diff.intel_count_delta} />
            {diff.intel_count_delta > 0 ? '+' : ''}{diff.intel_count_delta}
          </div>
          <div className="text-[10px] text-muted-foreground">{diff.from.intel_count} → {diff.to.intel_count}</div>
        </div>
        <div className="border border-border rounded p-2 bg-card">
          <div className="text-muted-foreground">High-severity</div>
          <div className={cn(
            'text-base font-semibold flex items-center gap-1.5 mt-0.5',
            diff.high_severity_delta > 0 && 'text-red-600 dark:text-red-400'
          )}>
            <DiffDeltaIcon delta={diff.high_severity_delta} />
            {diff.high_severity_delta > 0 ? '+' : ''}{diff.high_severity_delta}
          </div>
          <div className="text-[10px] text-muted-foreground">{diff.from.high_severity_count} → {diff.to.high_severity_count}</div>
        </div>
        <div className="border border-border rounded p-2 bg-card">
          <div className="text-muted-foreground">New material</div>
          <div className="text-base font-semibold mt-0.5">
            {diff.new_intel_ids.length} intel
          </div>
          <div className="text-[10px] text-muted-foreground">+ {diff.new_transcript_ids.length} transcripts</div>
        </div>
      </div>

      {noChange ? (
        <div className="text-xs text-muted-foreground italic">No material change since the previous briefing.</div>
      ) : diff.summary_md ? (
        <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
          <MarkdownRenderer content={diff.summary_md} />
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">
          (LLM delta synthesis unavailable — set counts shown above are still accurate.)
        </div>
      )}
    </div>
  )
}

function BriefingDetail({ briefing, onDelete, onRegenerate, onExport, onEmail, onCompare, diff, diffLoading, onCloseDiff, busy }: {
  briefing: DailyBriefing
  onDelete: () => void
  onRegenerate: () => void
  onExport: (format: 'pdf' | 'docx') => void
  onEmail: () => void
  onCompare: () => void
  diff: BriefingDiffResult | null
  diffLoading: boolean
  onCloseDiff: () => void
  busy: boolean
}) {
  const sources = useMemo(() => {
    if (!briefing.sources_json) return null
    try { return JSON.parse(briefing.sources_json) as { intel_ids?: string[]; transcript_ids?: string[]; indicator_count?: number } } catch { return null }
  }, [briefing.sources_json])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b border-border px-6 py-4 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold flex items-center gap-2 flex-wrap">
              <ScrollText className="h-4 w-4 text-primary" />
              Daily Briefing
              <StatusPill status={briefing.status} />
              <Badge variant="outline" className="text-[10px]">{briefing.classification}</Badge>
            </h2>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1"><ClockIcon className="h-3 w-3" /> {fmtRange(briefing.period_start, briefing.period_end)}</span>
              <span>· generated {formatRelativeTime(briefing.generated_at)}</span>
              {briefing.model && <span>· {briefing.model}</span>}
            </div>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
              <span><strong className="text-foreground">{briefing.intel_count}</strong> intel</span>
              <span><strong className="text-foreground">{briefing.transcript_count}</strong> transcripts</span>
              <span className={cn(briefing.high_severity_count > 0 && 'text-red-600 dark:text-red-400')}>
                <strong className={cn(briefing.high_severity_count > 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
                  {briefing.high_severity_count}
                </strong> high-severity
              </span>
              {sources?.indicator_count != null && sources.indicator_count > 0 && (
                <span><strong className="text-foreground">{sources.indicator_count}</strong> indicator hits</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {briefing.status === 'ready' && (
              <Button size="sm" variant="outline" onClick={onCompare} disabled={diffLoading} className="h-8" title="Diff vs the previous briefing">
                {diffLoading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <GitCompare className="h-3.5 w-3.5 mr-1" />}
                Compare
              </Button>
            )}
            {briefing.status === 'ready' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8">
                    <Download className="h-3.5 w-3.5 mr-1" /> Export
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">
                    With letterhead applied
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onExport('pdf')}>
                    <FileText className="h-3.5 w-3.5 mr-2" /> PDF
                    <span className="ml-auto text-[10px] text-muted-foreground">letterhead</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onExport('docx')}>
                    <FileText className="h-3.5 w-3.5 mr-2" /> Word (.docx)
                    <span className="ml-auto text-[10px] text-muted-foreground">editable</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onEmail}>
                    <Mail className="h-3.5 w-3.5 mr-2" /> Email PDF…
                    <span className="ml-auto text-[10px] text-muted-foreground">SMTP</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button size="sm" variant="ghost" onClick={onRegenerate} disabled={busy} className="h-8">
              <RefreshCw className={cn('h-3.5 w-3.5 mr-1', busy && 'animate-spin')} /> Regenerate
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete} className="h-8 text-red-600 dark:text-red-400 hover:bg-red-500/10">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {diff && <DiffPanel diff={diff} onClose={onCloseDiff} />}
        {briefing.status === 'generating' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> LLM synthesizing the briefing… this may take 30-60 seconds.
          </div>
        )}
        {briefing.status === 'error' && (
          <div className="border border-red-500/30 bg-red-500/5 rounded-md p-3 space-y-1">
            <div className="text-sm font-medium text-red-700 dark:text-red-400 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> Generation failed
            </div>
            <div className="text-xs text-red-600 dark:text-red-400 font-mono">{briefing.error_text}</div>
          </div>
        )}
        {briefing.status === 'ready' && briefing.body_md && (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownRenderer content={briefing.body_md} />
          </div>
        )}
      </div>
    </div>
  )
}

export function BriefingsPage() {
  const [list, setList] = useState<DailyBriefing[]>([])
  const [selected, setSelected] = useState<DailyBriefing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diff, setDiff] = useState<BriefingDiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const { value: enabled, save: saveEnabled } = useSetting<boolean>('briefing.dailyEnabled', false)
  const { value: lookback, save: saveLookback } = useSetting<number>('briefing.lookbackHours', 24)
  const { value: classification, save: saveClassification } = useSetting<string>('briefing.classification', 'UNCLASSIFIED')
  const { value: autoEmail, save: saveAutoEmail } = useSetting<boolean>('briefing.autoEmail', false)
  const { value: emailFormat, save: saveEmailFormat } = useSetting<string>('briefing.emailFormat', 'pdf')
  const { value: emailRecipients, save: saveEmailRecipients } = useSetting<string[]>('briefing.emailRecipients', [])
  const [recipientsInput, setRecipientsInput] = useState('')
  const [recipientsInited, setRecipientsInited] = useState(false)
  if (!recipientsInited && Array.isArray(emailRecipients)) {
    setRecipientsInput((emailRecipients ?? []).join(', '))
    setRecipientsInited(true)
  }

  const load = useCallback(async () => {
    try {
      const rows = await window.heimdall.invoke('briefing:daily_list', { limit: 50 }) as DailyBriefing[]
      setList(rows)
      setSelected((cur) => cur ? rows.find((r) => r.id === cur.id) ?? null : cur)
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }, [])

  useEffect(() => {
    void load()
    // Poll every 5s while there's a generating briefing — cheap, only
    // active during LLM calls.
    const id = setInterval(() => {
      if (list.some((b) => b.status === 'generating')) void load()
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, list.length])

  const generateNow = async () => {
    setBusy(true); setError(null)
    try {
      const r = await window.heimdall.invoke('briefing:daily_generate_now', {
        lookbackHours: lookback,
        classification
      }) as DailyBriefing
      await load()
      setSelected(r)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    } finally { setBusy(false) }
  }

  const removeOne = async () => {
    if (!selected) return
    if (!confirm('Delete this briefing?')) return
    try {
      await window.heimdall.invoke('briefing:daily_delete', selected.id)
      setSelected(null)
      await load()
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
  }

  const compareWithPrevious = async () => {
    if (!selected) return
    setDiff(null)
    setDiffLoading(true)
    setError(null)
    try {
      const r = await window.heimdall.invoke('briefing:daily_diff', { toId: selected.id }) as
        { ok: true; diff: BriefingDiffResult } | { ok: false; reason: string }
      if (r.ok) setDiff(r.diff)
      else toast.message('Nothing to compare', { description: r.reason })
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      toast.error('Compare failed', { description: msg })
    } finally { setDiffLoading(false) }
  }

  // Clear the open diff whenever the analyst flips to a different
  // briefing — the panel was anchored to the previous selection.
  useEffect(() => { setDiff(null) }, [selected?.id])

  const exportBriefingAs = async (format: 'pdf' | 'docx') => {
    if (!selected) return
    setError(null)
    try {
      const r = await window.heimdall.invoke('briefing:daily_export', {
        id: selected.id,
        format,
        save: true
      }) as { ok: boolean; cancelled?: boolean; path?: string; bytes?: number; filename?: string }
      if (r.cancelled) return
      if (r.ok && r.path) {
        toast.success(`${format.toUpperCase()} saved`, {
          description: r.path,
          duration: 5000
        })
      }
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
    }
  }

  const emailBriefing = async () => {
    if (!selected) return
    setError(null)
    const recipientsRaw = prompt(
      `Email this briefing as PDF.\n\n` +
      `Recipients (comma-separated). Leave blank to use SMTP defaults.`,
      ''
    )
    if (recipientsRaw === null) return
    const recipients = recipientsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    try {
      const r = await window.heimdall.invoke('briefing:daily_email', {
        id: selected.id,
        recipients,
        format: 'pdf'
      }) as { ok: true; recipients: string[] }
      toast.success(`Sent to ${r.recipients.length} recipient${r.recipients.length !== 1 ? 's' : ''}`, {
        description: r.recipients.join(', '),
        duration: 6000
      })
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/, '')
      setError(msg)
      toast.error('Email failed', { description: msg, duration: 8000 })
    }
  }

  const regenerate = async () => {
    if (!selected) return
    setBusy(true); setError(null)
    try {
      const periodHours = Math.round((selected.period_end - selected.period_start) / 3_600_000)
      const r = await window.heimdall.invoke('briefing:daily_generate_now', {
        lookbackHours: periodHours,
        classification: selected.classification
      }) as DailyBriefing
      await load()
      setSelected(r)
    } catch (err) { setError(String(err).replace(/^Error:\s*/, '')) }
    finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6 pb-3 border-b border-border space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <ScrollText className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Daily Briefings</h1>
          <Badge variant="outline" className="text-[10px] ml-2">v1.6.0</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="default" onClick={generateNow} disabled={busy} className="h-8">
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
              Generate now
            </Button>
            <Button size="sm" variant="ghost" onClick={load} className="h-8" title="Refresh list">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          End-of-day intel synthesis. The cron runs at 17:00 server time and gathers the last
          {' '}<strong>{lookback ?? 24}h</strong> of intel + transcripts + indicator hits, then asks the
          LLM to produce an ICD-203-style briefing. Manual generation works at any time.
        </p>

        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <SettingsIcon className="h-3.5 w-3.5" /> Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label htmlFor="b-enabled" className="text-xs">Enable daily cron</Label>
                <div className="flex items-center gap-2 h-9">
                  <Switch id="b-enabled" checked={!!enabled} onCheckedChange={(v) => void saveEnabled(v)} />
                  <span className="text-xs text-muted-foreground">{enabled ? 'on' : 'off'}</span>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-lookback" className="text-xs">Lookback (hours)</Label>
                <Input
                  id="b-lookback" type="number" min={1} max={168} step={1}
                  value={lookback ?? 24}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n >= 1 && n <= 168) void saveLookback(n)
                  }}
                  className="font-mono text-sm h-9"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="b-class" className="text-xs">Classification line</Label>
                <Input
                  id="b-class" type="text"
                  value={classification ?? 'UNCLASSIFIED'}
                  onChange={(e) => void saveClassification(e.target.value)}
                  placeholder="UNCLASSIFIED"
                  className="font-mono text-sm h-9"
                />
              </div>
            </div>

            {/* v1.6.2 — auto-email on cron */}
            <div className="border-t border-border pt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5 flex-1">
                  <Label htmlFor="b-autoemail" className="text-xs cursor-pointer flex items-center gap-1.5">
                    <Mail className="h-3 w-3" /> Auto-email each generated briefing
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    After the cron synthesises the briefing, send it to the recipients below as a {(emailFormat || 'pdf').toUpperCase()} attachment.
                    Requires SMTP configured in Settings → SMTP. Off by default.
                  </p>
                </div>
                <Switch
                  id="b-autoemail"
                  checked={!!autoEmail}
                  onCheckedChange={(v) => void saveAutoEmail(v)}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1 col-span-2">
                  <Label htmlFor="b-recipients" className="text-xs">Recipients (comma-separated)</Label>
                  <Input
                    id="b-recipients" type="text"
                    value={recipientsInput}
                    onChange={(e) => setRecipientsInput(e.target.value)}
                    onBlur={() => {
                      const list = recipientsInput
                        .split(',')
                        .map((s) => s.trim())
                        .filter((s) => s && /.+@.+\..+/.test(s))
                      void saveEmailRecipients(list)
                    }}
                    placeholder="chief@agency.gov, ops@agency.gov"
                    className="font-mono text-sm h-9"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {(emailRecipients ?? []).length === 0
                      ? 'Falls back to SMTP defaults when blank.'
                      : `${(emailRecipients ?? []).length} recipient${(emailRecipients ?? []).length !== 1 ? 's' : ''} on save.`}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="b-format" className="text-xs">Attachment format</Label>
                  <select
                    id="b-format"
                    value={emailFormat ?? 'pdf'}
                    onChange={(e) => void saveEmailFormat(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="pdf">PDF (with letterhead)</option>
                    <option value="docx">Word (.docx)</option>
                  </select>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {error}
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 border-r border-border flex flex-col overflow-hidden">
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {list.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center px-3">
                No briefings yet. Click <strong>Generate now</strong> to produce the first one.
              </div>
            ) : list.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelected(b)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md transition-colors border',
                  selected?.id === b.id ? 'bg-primary/10 border-primary/40' : 'border-transparent hover:bg-accent'
                )}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{fmtRange(b.period_start, b.period_end)}</span>
                  <StatusPill status={b.status} />
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {b.intel_count} intel · {b.transcript_count} tx
                  {b.high_severity_count > 0 && (
                    <span className="text-red-600 dark:text-red-400"> · {b.high_severity_count} high</span>
                  )}
                  <span> · {formatRelativeTime(b.generated_at)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          {selected ? (
            <BriefingDetail
              key={selected.id}
              briefing={selected}
              onDelete={removeOne}
              onRegenerate={regenerate}
              onExport={exportBriefingAs}
              onEmail={emailBriefing}
              onCompare={compareWithPrevious}
              diff={diff}
              diffLoading={diffLoading}
              onCloseDiff={() => setDiff(null)}
              busy={busy}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 px-6 text-center">
              <FileText className="h-10 w-10 opacity-40" />
              <div className="text-sm">Select a briefing to read its contents.</div>
              <Link to="/feed" className="text-xs text-primary hover:underline">… or jump to today's intel feed</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
