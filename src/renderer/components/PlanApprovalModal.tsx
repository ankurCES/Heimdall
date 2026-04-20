import { useEffect, useMemo, useState } from 'react'
import { ListChecks, Send, RefreshCw, X, AlertTriangle, Loader2, Sparkles, Database, Globe, Shield, Network, Bug } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { cn } from '@renderer/lib/utils'

/** Same shape as the backend's ProposedToolCall — duplicated here so the
 *  component is self-contained. */
export interface ProposedToolCall {
  id: string
  tool: string
  group: 'internal' | 'web' | 'darkweb' | 'mcp' | 'cve' | 'domain'
  label: string
  reason: string
  query: string
  params?: Record<string, unknown>
  enabled: boolean
}

export interface PlanPreview {
  planId: string
  sessionId: string
  query: string
  steps: Array<{ task: string; searchTerms: string[]; discipline: string }>
  proposedCalls: ProposedToolCall[]
  reworkHistory: Array<{ feedback: string; at: number }>
  createdAt: number
}

export interface PlanEdits {
  disabledCallIds: string[]
  editedQueries: Record<string, string>
  approvalComments?: string
}

/** Preliminary research findings from the auto-research phase
 *  (deep mode only — null in lite mode). */
export interface PreliminaryFindings {
  internalHits: number
  webPagesCrawled: number
  darkwebPagesCrawled: number
  filesDownloaded: number
  filesIngested: number
  cvesResolved: number
  domainsResolved: number
  actorsDetected: string[]
  downloadedFiles: Array<{ filename: string; extension: string; sizeBytes: number; textLength: number; error: string | null }>
  topFindings: Array<{ source: string; title: string; snippet: string; relevance: number }>
}

interface Props {
  preview: PlanPreview | null
  findings?: PreliminaryFindings | null
  busy?: boolean
  /** "planning" while we're regenerating after rework. */
  reworking?: boolean
  /** 'deep' | 'lite' — affects what sections are shown. */
  mode?: 'deep' | 'lite'
  onApprove: (edits: PlanEdits) => void
  /** Mandatory feedback string. */
  onRework: (feedback: string) => void
  onCancel: () => void
}

const GROUP_META: Record<ProposedToolCall['group'], { label: string; icon: typeof Database; tint: string }> = {
  internal: { label: 'Internal database', icon: Database, tint: 'border-blue-400/30 bg-blue-400/5 text-blue-200' },
  web:      { label: 'Public web',         icon: Globe,    tint: 'border-cyan-400/30 bg-cyan-400/5 text-cyan-200' },
  darkweb:  { label: 'Dark web (.onion)',  icon: Shield,   tint: 'border-fuchsia-400/30 bg-fuchsia-400/5 text-fuchsia-200' },
  mcp:      { label: 'MCP tools',          icon: Sparkles, tint: 'border-amber-400/30 bg-amber-400/5 text-amber-200' },
  cve:      { label: 'CVE detail',         icon: Bug,      tint: 'border-red-400/30 bg-red-400/5 text-red-200' },
  domain:   { label: 'Domain WHOIS / DNS', icon: Network,  tint: 'border-emerald-400/30 bg-emerald-400/5 text-emerald-200' }
}

/**
 * Plan approval modal — shown before any agentic research runs.
 *
 *   - Displays the planner's research steps (read-only).
 *   - Lists every proposed tool call grouped by category (internal / web /
 *     darkweb / mcp / cve / domain). Each row has an enable checkbox and
 *     an inline-editable query input populated with the LLM-refined query.
 *   - Approve  → optional comments → forwards edits to executePlan.
 *   - Rework   → mandatory comments → asks the planner for a new plan.
 *   - Cancel   → drops the plan, closes the modal.
 */
export function PlanApprovalModal({ preview, findings, busy = false, reworking = false, mode = 'deep', onApprove, onRework, onCancel }: Props) {
  // Local edit state, reset whenever a new preview arrives.
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [approvalComments, setApprovalComments] = useState('')
  const [reworkOpen, setReworkOpen] = useState(false)
  const [reworkText, setReworkText] = useState('')

  useEffect(() => {
    if (!preview) return
    setDisabled(new Set())
    setEdits({})
    setApprovalComments('')
    setReworkOpen(false)
    setReworkText('')
  }, [preview?.planId])

  const grouped = useMemo(() => {
    if (!preview) return [] as Array<{ group: ProposedToolCall['group']; calls: ProposedToolCall[] }>
    const map = new Map<ProposedToolCall['group'], ProposedToolCall[]>()
    for (const c of preview.proposedCalls) {
      const arr = map.get(c.group) ?? []
      arr.push(c)
      map.set(c.group, arr)
    }
    // Stable group order to match backend execution sequence.
    const order: ProposedToolCall['group'][] = ['internal', 'darkweb', 'web', 'cve', 'domain', 'mcp']
    return order.filter((g) => map.has(g)).map((g) => ({ group: g, calls: map.get(g)! }))
  }, [preview])

  if (!preview) return null

  const totalCalls = preview.proposedCalls.length
  const enabledCount = totalCalls - disabled.size

  const toggleCall = (id: string) => {
    setDisabled((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const editQuery = (id: string, value: string) => setEdits((prev) => ({ ...prev, [id]: value }))

  const handleApprove = () => {
    const editedQueries: Record<string, string> = {}
    for (const c of preview.proposedCalls) {
      const v = edits[c.id]
      if (v !== undefined && v.trim() && v.trim() !== c.query) editedQueries[c.id] = v.trim()
    }
    onApprove({
      disabledCallIds: Array.from(disabled),
      editedQueries,
      approvalComments: approvalComments.trim() || undefined
    })
  }
  const handleSubmitRework = () => {
    if (!reworkText.trim()) return
    onRework(reworkText.trim())
  }

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-primary" />
            {reworking ? 'Building a new plan…' : 'Plan for analyst approval'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Review the research plan and proposed tool calls before any analysis runs.
            Toggle calls off, edit queries inline, or send the planner back for a different approach.
          </DialogDescription>
        </DialogHeader>

        {/* Original query echo */}
        <div className="text-xs px-3 py-2 rounded border border-border bg-muted/30 break-words">
          <span className="text-muted-foreground">Query: </span>
          <span className="font-mono">{preview.query}</span>
        </div>

        {/* Rework history (only if user has rejected before) */}
        {preview.reworkHistory.length > 0 && (
          <div className="text-[11px] p-2 rounded border border-amber-500/30 bg-amber-500/5 text-amber-200 space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <RefreshCw className="h-3 w-3" /> Rework feedback applied to this regeneration:
            </div>
            {preview.reworkHistory.map((r, i) => (
              <div key={i} className="ml-4 italic">"{r.feedback}"</div>
            ))}
          </div>
        )}

        <div className="overflow-auto flex-1 -mx-6 px-6 space-y-4">
          {/* Preliminary findings (deep mode only) */}
          {findings && mode === 'deep' && (
            <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">Preliminary research (completed automatically)</div>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">
                {[
                  { label: 'Internal', value: findings.internalHits, color: 'text-blue-300' },
                  { label: 'Web', value: findings.webPagesCrawled, color: 'text-cyan-300' },
                  { label: 'Dark web', value: findings.darkwebPagesCrawled, color: 'text-fuchsia-300' },
                  { label: 'Files', value: findings.filesDownloaded, color: 'text-amber-300' },
                  { label: 'CVEs', value: findings.cvesResolved, color: 'text-red-300' },
                  { label: 'Actors', value: findings.actorsDetected.length, color: 'text-orange-300' }
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded border border-border/50 p-1.5">
                    <div className={cn('text-lg font-semibold', color)}>{value}</div>
                    <div className="text-[9px] text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              {findings.actorsDetected.length > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  Actors detected: <span className="text-orange-300">{findings.actorsDetected.join(', ')}</span>
                </div>
              )}
              {findings.downloadedFiles.length > 0 && (
                <div className="text-[10px] space-y-0.5">
                  <div className="text-muted-foreground font-semibold">Downloaded files:</div>
                  {findings.downloadedFiles.filter((f) => !f.error).map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-emerald-200">
                      <span className="font-mono">{f.filename}</span>
                      <span className="text-muted-foreground">({(f.sizeBytes / 1024).toFixed(0)} KB, {f.textLength} chars)</span>
                      {f.textLength > 0 && <span className="text-emerald-400">✓ ingested</span>}
                    </div>
                  ))}
                </div>
              )}
              {findings.topFindings.length > 0 && (
                <details className="text-[10px]">
                  <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
                    Top {Math.min(findings.topFindings.length, 10)} findings (click to expand)
                  </summary>
                  <div className="mt-1 space-y-1 max-h-40 overflow-auto">
                    {findings.topFindings.slice(0, 10).map((f, i) => (
                      <div key={i} className="rounded bg-card/50 p-1.5 border border-border/30">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="text-[8px] py-0 px-1">{f.source}</Badge>
                          <span className="font-medium truncate">{f.title}</span>
                        </div>
                        <div className="text-muted-foreground truncate mt-0.5">{f.snippet}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Research steps — read-only */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Research steps</div>
            <ol className="text-sm space-y-1">
              {preview.steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground font-mono text-xs mt-0.5">{i + 1}.</span>
                  <div>
                    <div>{s.task}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">discipline: {s.discipline} | terms: {s.searchTerms.join(', ')}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* Proposed tool calls grouped */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Proposed tool calls ({enabledCount}/{totalCalls} enabled)
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setDisabled(new Set())}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:border-primary text-muted-foreground hover:text-primary">
                  Enable all
                </button>
                <button onClick={() => setDisabled(new Set(preview.proposedCalls.map((c) => c.id)))}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:border-destructive text-muted-foreground hover:text-destructive">
                  Disable all
                </button>
              </div>
            </div>

            {grouped.map(({ group, calls }) => {
              const meta = GROUP_META[group]
              const Icon = meta.icon
              return (
                <div key={group} className={cn('rounded border p-2 mb-2 space-y-1.5', meta.tint)}>
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                    <Icon className="h-3 w-3" /> {meta.label}
                    <Badge variant="outline" className="text-[9px] py-0 px-1 ml-auto">
                      {calls.filter((c) => !disabled.has(c.id)).length}/{calls.length}
                    </Badge>
                  </div>
                  {calls.map((c) => {
                    const isDisabled = disabled.has(c.id)
                    const value = edits[c.id] ?? c.query
                    return (
                      <div key={c.id} className={cn(
                        'flex items-start gap-2 p-1.5 rounded border border-border/50 bg-card/30',
                        isDisabled && 'opacity-40'
                      )}>
                        <input
                          type="checkbox"
                          checked={!isDisabled}
                          onChange={() => toggleCall(c.id)}
                          className="mt-1 shrink-0"
                        />
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className="text-[10px] font-mono px-1 py-0.5 rounded bg-muted">{c.tool}</code>
                            <span className="text-[10px] text-muted-foreground italic">{c.reason}</span>
                          </div>
                          <input
                            value={value}
                            disabled={isDisabled}
                            onChange={(e) => editQuery(c.id, e.target.value)}
                            className="w-full h-7 text-[11px] font-mono px-2 rounded border border-input bg-background/50 disabled:opacity-50"
                            placeholder="Refined query…"
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* Approval comments — optional */}
          {!reworkOpen && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Optional guidance for the analyst LLM
              </div>
              <textarea
                value={approvalComments}
                onChange={(e) => setApprovalComments(e.target.value)}
                placeholder="e.g. Focus on nuclear-tech transfer angle. Cite primary sources. Avoid speculation about specific personnel."
                rows={3}
                className="w-full text-xs px-2 py-1.5 rounded border border-input bg-background resize-y"
              />
              <div className="text-[10px] text-muted-foreground mt-1">
                Forwarded as a system prompt to the analyst LLM during the synthesis phase.
              </div>
            </div>
          )}

          {/* Rework form — mandatory feedback */}
          {reworkOpen && (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="font-semibold">Rework feedback (required)</span>
              </div>
              <textarea
                autoFocus
                value={reworkText}
                onChange={(e) => setReworkText(e.target.value)}
                placeholder="Tell the planner what was wrong and what you want different. e.g. 'Drop dark-web search — focus on official government statements only.'"
                rows={3}
                className="w-full text-xs px-2 py-1.5 rounded border border-amber-500/40 bg-background resize-y"
              />
              <div className="text-[10px] text-amber-200">
                The planner will regenerate a NEW plan that addresses this feedback.
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => { setReworkOpen(false); setReworkText('') }} disabled={busy}>
                  Back to plan
                </Button>
                <Button size="sm" onClick={handleSubmitRework} disabled={busy || !reworkText.trim()}
                  className="bg-amber-600 hover:bg-amber-500 text-amber-50">
                  {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                  Submit rework
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        {!reworkOpen && (
          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              <X className="h-3.5 w-3.5 mr-1.5" /> Cancel
            </Button>
            <Button size="sm" variant="outline" onClick={() => setReworkOpen(true)} disabled={busy}
              className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10">
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Rework plan
            </Button>
            <Button size="sm" onClick={handleApprove} disabled={busy || enabledCount === 0}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
              Approve & run ({enabledCount})
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
