import { useEffect, useMemo, useState } from 'react'
import { Loader2, Users, ShieldAlert, Search, Eye, FileSearch2, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ClassificationBadge } from '@renderer/components/ClassificationBanner'
import { cn } from '@renderer/lib/utils'

/**
 * Multi-Agent Analyst Council panel (Cross-cutting A in the agency roadmap).
 *
 * Five specialized agents independently reason over an assistant message
 * before the analyst commits to publishing it as a preliminary report:
 *   • Skeptic — finds weaknesses + single-source claims
 *   • Red Team — argues the adversary's case
 *   • Counter-Intel — flags coordinated narratives + deception heuristics
 *   • Citation Audit — verifies every claim back to a primary source
 *   • Synthesis — reconciles all four into ICD 203 estimative-probability language
 *
 * Each role's output is structured (conclusion / key_findings / concerns /
 * confidence / citations) and the full transcript is itself an analytical
 * product — defensible in cross-examination. Every council run is logged
 * to the tamper-evident audit chain via auditChainService.
 */

type Role = 'skeptic' | 'red_team' | 'counter_intel' | 'citation_audit' | 'synthesis'

interface CouncilOutput {
  id: string
  role: Role
  conclusion: string | null
  key_findings: string[]
  concerns: string[]
  confidence: string | null
  citations: string[]
  duration_ms: number | null
  status: 'pending' | 'success' | 'error'
  error: string | null
  created_at: number
}

interface CouncilRun {
  id: string
  topic: string
  classification: string
  status: 'pending' | 'running' | 'completed' | 'error'
  started_at: number
  completed_at: number | null
  outputs: CouncilOutput[]
}

const ROLE_META: Record<Role, { label: string; icon: typeof Search; color: string; description: string }> = {
  skeptic: {
    label: 'Skeptic',
    icon: Search,
    color: 'text-amber-300 border-amber-500/30 bg-amber-500/5',
    description: 'Finds single-source claims, hedge words, unsupported assumptions'
  },
  red_team: {
    label: 'Red Team',
    icon: ShieldAlert,
    color: 'text-red-300 border-red-500/30 bg-red-500/5',
    description: 'Adopts adversary perspective; argues against the prevailing hypothesis'
  },
  counter_intel: {
    label: 'Counter-Intelligence',
    icon: Eye,
    color: 'text-purple-300 border-purple-500/30 bg-purple-500/5',
    description: 'Detects coordinated narratives, deception heuristics, suspicious source overlap'
  },
  citation_audit: {
    label: 'Citation Auditor',
    icon: FileSearch2,
    color: 'text-blue-300 border-blue-500/30 bg-blue-500/5',
    description: 'Verifies every claim back to a primary source; flags hallucinations'
  },
  synthesis: {
    label: 'Synthesis',
    icon: Sparkles,
    color: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/5',
    description: 'Reconciles the four critiques into the analyst-ready final assessment'
  }
}

const ROLE_ORDER: Role[] = ['skeptic', 'red_team', 'counter_intel', 'citation_audit', 'synthesis']

const CONFIDENCE_PILL: Record<string, string> = {
  high: 'bg-emerald-500/20 text-emerald-300',
  moderate: 'bg-amber-500/20 text-amber-300',
  low: 'bg-red-500/20 text-red-300'
}

interface Props {
  /** The assistant message text to be reviewed by the council. */
  content: string
  /** Optional topic — defaults to the first 80 chars of content. */
  topic?: string
  /** Active session — passed through for the run record. */
  sessionId?: string
  /** Classification of the input artifact (defaults UNCLASSIFIED). */
  classification?: string
}

export function AnalystCouncilPanel({ content, topic, sessionId, classification = 'UNCLASSIFIED' }: Props) {
  const [run, setRun] = useState<CouncilRun | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const inferredTopic = useMemo(() => {
    if (topic) return topic
    return content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Analyst council review'
  }, [topic, content])

  const start = async () => {
    setRunning(true)
    setError(null)
    try {
      const result = await window.heimdall.invoke('council:run', {
        topic: inferredTopic,
        inputContent: content,
        sessionId,
        classification
      }) as CouncilRun
      setRun(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setRunning(false)
    }
  }

  if (!run && !running && !error) {
    return (
      <div className="mt-2 border border-blue-500/30 bg-blue-500/5 rounded-md text-[11px]">
        <button
          onClick={start}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-blue-300 hover:bg-blue-500/10 rounded-md"
        >
          <Users className="h-3 w-3 shrink-0" />
          <span className="font-medium">Run Analyst Council</span>
          <span className="text-blue-300/70">— Skeptic + Red Team + Counter-Intel + Citation Audit + Synthesis</span>
        </button>
      </div>
    )
  }

  if (running) {
    return (
      <div className="mt-2 border border-blue-500/30 bg-blue-500/5 rounded-md text-[11px] px-2.5 py-2">
        <div className="flex items-center gap-2 text-blue-300">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Running Analyst Council… 5 specialized agents reasoning in parallel.</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mt-2 border border-red-500/30 bg-red-500/5 rounded-md text-[11px] px-2.5 py-2 text-red-300">
        Council error: {error}
        <Button size="sm" variant="outline" className="ml-2 h-6" onClick={start}>Retry</Button>
      </div>
    )
  }

  if (!run) return null

  const synthesis = run.outputs.find((o) => o.role === 'synthesis')
  const duration = run.completed_at ? Math.round((run.completed_at - run.started_at) / 100) / 10 : null

  return (
    <div className="mt-2 border border-blue-500/30 bg-blue-500/5 rounded-md text-[11px]">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-blue-300 hover:bg-blue-500/10 rounded-t-md"
      >
        <Users className="h-3 w-3 shrink-0" />
        <span className="font-medium">Analyst Council</span>
        {synthesis?.confidence && (
          <span className={cn('px-1.5 rounded text-[10px] font-mono', CONFIDENCE_PILL[synthesis.confidence] || '')}>
            {synthesis.confidence} confidence
          </span>
        )}
        <ClassificationBadge level={run.classification as 'UNCLASSIFIED' | 'CONFIDENTIAL' | 'SECRET' | 'TOP SECRET'} />
        {duration !== null && <span className="text-blue-300/60 text-[10px]">{duration}s</span>}
        {collapsed ? <ChevronRight className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t border-blue-500/20 pt-2">
          {synthesis && synthesis.conclusion && (
            <div className="border border-emerald-500/30 bg-emerald-500/5 rounded p-2">
              <div className="flex items-center gap-1.5 mb-1 text-emerald-300 font-medium">
                <Sparkles className="h-3 w-3" />
                Synthesis
              </div>
              <p className="text-foreground/90">{synthesis.conclusion}</p>
              {synthesis.key_findings.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-[10px] list-disc list-inside text-foreground/80">
                  {synthesis.key_findings.map((k, i) => <li key={i}>{k}</li>)}
                </ul>
              )}
            </div>
          )}

          {ROLE_ORDER.filter((r) => r !== 'synthesis').map((role) => {
            const out = run.outputs.find((o) => o.role === role)
            if (!out) return null
            const meta = ROLE_META[role]
            const Icon = meta.icon
            return (
              <details key={role} className={cn('border rounded p-2', meta.color)} open={out.concerns.length > 0}>
                <summary className="cursor-pointer flex items-center gap-1.5 font-medium select-none">
                  <Icon className="h-3 w-3" />
                  <span>{meta.label}</span>
                  {out.confidence && (
                    <span className={cn('px-1.5 rounded text-[9px] font-mono ml-1', CONFIDENCE_PILL[out.confidence] || '')}>
                      {out.confidence}
                    </span>
                  )}
                  {out.status === 'error' && <span className="text-red-400 text-[9px] ml-1">error</span>}
                </summary>
                {out.status === 'error' ? (
                  <p className="mt-1 text-red-300 text-[10px]">{out.error}</p>
                ) : (
                  <div className="mt-1.5 space-y-1.5">
                    {out.conclusion && <p className="text-foreground/90">{out.conclusion}</p>}
                    {out.key_findings.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground/70 mb-0.5">Findings</p>
                        <ul className="text-[10px] list-disc list-inside text-foreground/80 space-y-0.5">
                          {out.key_findings.map((k, i) => <li key={i}>{k}</li>)}
                        </ul>
                      </div>
                    )}
                    {out.concerns.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground/70 mb-0.5">Concerns</p>
                        <ul className="text-[10px] list-disc list-inside text-foreground/80 space-y-0.5">
                          {out.concerns.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                      </div>
                    )}
                    {out.citations.length > 0 && (
                      <div className="text-[9px] text-muted-foreground/70 font-mono truncate">
                        Citations: {out.citations.slice(0, 3).join(', ')}
                        {out.citations.length > 3 ? ` +${out.citations.length - 3}` : ''}
                      </div>
                    )}
                  </div>
                )}
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}
