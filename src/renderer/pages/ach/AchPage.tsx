import { useEffect, useState, useCallback } from 'react'
import {
  GitCompare, Plus, Trash2, Sparkles, ChevronRight, ArrowLeft,
  Award, AlertTriangle, Loader2, X, FileText
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@renderer/components/ui/card'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@renderer/components/ui/dialog'
import { ClassificationBadge, CLASSIFICATION_LEVELS, type Classification } from '@renderer/components/ClassificationBanner'
import { cn, formatRelativeTime } from '@renderer/lib/utils'

/**
 * ACH Workbench (Themes 2.1–2.6 of the agency roadmap).
 *
 * Two-level UI:
 *   - Sessions list (left) — every ACH analysis the user has open
 *   - Matrix (right) — hypotheses across columns, evidence rows, score
 *     cells. Click a cell to toggle through CC / C / N / I / II.
 *     The Heuer-leading hypothesis is highlighted in green.
 *     Diagnostic evidence (high score variance) is flagged in amber.
 */

type Score = 'CC' | 'C' | 'N' | 'I' | 'II'

interface AchHypothesis { id: string; session_id: string; ordinal: number; label: string; description: string | null; source: 'analyst' | 'agent'; created_at: number }
interface AchEvidence { id: string; session_id: string; ordinal: number; claim: string; source_intel_id: string | null; source_humint_id: string | null; source_label: string | null; weight: number; credibility: number | null; notes: string | null; created_at: number }
interface AchScore { hypothesis_id: string; evidence_id: string; score: Score; rationale: string | null }
interface HypothesisScorecard { hypothesis_id: string; consistent_weight: number; inconsistent_weight: number; scored_count: number; is_leading: boolean }
interface EvidenceDiagnostic { evidence_id: string; diagnostic_value: number; is_diagnostic: boolean }
interface AchAnalysis {
  scorecard: HypothesisScorecard[]
  diagnostics: EvidenceDiagnostic[]
  leading_hypothesis_id: string | null
  unscored_count: number
  total_evidence: number
  total_hypotheses: number
}
interface AchSession {
  id: string; title: string; question: string | null
  classification: Classification; status: 'open' | 'closed'
  created_at: number; updated_at: number
  hypotheses?: AchHypothesis[]; evidence?: AchEvidence[]; scores?: AchScore[]
  analysis?: AchAnalysis
}

const SCORE_CYCLE: Score[] = ['CC', 'C', 'N', 'I', 'II']
const SCORE_NULL_CYCLE: Array<Score | null> = [null, 'CC', 'C', 'N', 'I', 'II']

const SCORE_COLORS: Record<Score, string> = {
  CC: 'bg-emerald-500/30 text-emerald-200 border-emerald-500/50',
  C:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  N:  'bg-slate-500/15 text-slate-400 border-slate-500/30',
  I:  'bg-red-500/15 text-red-300 border-red-500/30',
  II: 'bg-red-500/30 text-red-200 border-red-500/50'
}

const SCORE_TOOLTIPS: Record<Score, string> = {
  CC: 'Strongly consistent (++): the evidence strongly supports this hypothesis',
  C:  'Consistent (+): the evidence supports this hypothesis',
  N:  'Neutral / Not applicable: no bearing on this hypothesis',
  I:  'Inconsistent (-): the evidence weighs against this hypothesis',
  II: 'Strongly inconsistent (--): the evidence strongly contradicts this hypothesis'
}

export function AchPage() {
  const [sessions, setSessions] = useState<AchSession[]>([])
  const [activeSession, setActiveSession] = useState<AchSession | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const loadSessions = useCallback(async () => {
    const result = await window.heimdall.invoke('ach:sessions:list') as AchSession[]
    setSessions(result || [])
  }, [])

  const loadActive = useCallback(async () => {
    if (!activeId) { setActiveSession(null); return }
    setLoading(true)
    try {
      const session = await window.heimdall.invoke('ach:sessions:get', { id: activeId }) as AchSession | null
      setActiveSession(session)
    } finally {
      setLoading(false)
    }
  }, [activeId])

  useEffect(() => { void loadSessions() }, [loadSessions])
  useEffect(() => { void loadActive() }, [loadActive])

  const reload = async () => {
    await loadSessions()
    await loadActive()
  }

  return (
    <div className="flex h-full">
      {/* Sessions list */}
      <div className="w-72 shrink-0 border-r border-border bg-card/30 flex flex-col">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-bold flex-1">ACH Sessions</span>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="h-7 px-2">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto">
          {sessions.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">
              No sessions. Click <strong>+</strong> to start.
            </div>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  'w-full text-left p-3 border-b border-border/50 hover:bg-accent/30',
                  activeId === s.id && 'bg-accent/50'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    s.status === 'closed' ? 'bg-emerald-500' : 'bg-blue-500'
                  )} />
                  <span className="text-sm font-medium truncate flex-1">{s.title}</span>
                  <ClassificationBadge level={s.classification} />
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {formatRelativeTime(s.updated_at)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Active session */}
      <div className="flex-1 overflow-auto">
        {activeSession ? (
          <SessionView session={activeSession} onChanged={reload} loading={loading} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <GitCompare className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">Select a session or create a new one.</p>
          </div>
        )}
      </div>

      <CreateSessionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => { void loadSessions(); setActiveId(id); setCreateOpen(false) }}
      />
    </div>
  )
}

function SessionView({ session, onChanged, loading }: { session: AchSession; onChanged: () => Promise<void> | void; loading: boolean }) {
  const [hypothesisInput, setHypothesisInput] = useState('')
  const [evidenceInput, setEvidenceInput] = useState('')
  const [generating, setGenerating] = useState(false)

  const hypotheses = session.hypotheses || []
  const evidence = session.evidence || []
  const scores = session.scores || []
  const analysis = session.analysis

  const scoreMap = new Map<string, Score>()
  for (const s of scores) scoreMap.set(`${s.hypothesis_id}:${s.evidence_id}`, s.score)

  const diagnosticMap = new Map<string, EvidenceDiagnostic>()
  for (const d of analysis?.diagnostics || []) diagnosticMap.set(d.evidence_id, d)

  const cardMap = new Map<string, HypothesisScorecard>()
  for (const c of analysis?.scorecard || []) cardMap.set(c.hypothesis_id, c)

  const cycleScore = async (hypothesis_id: string, evidence_id: string) => {
    const current = scoreMap.get(`${hypothesis_id}:${evidence_id}`) ?? null
    const idx = SCORE_NULL_CYCLE.indexOf(current)
    const next = SCORE_NULL_CYCLE[(idx + 1) % SCORE_NULL_CYCLE.length]
    if (next === null) {
      await window.heimdall.invoke('ach:scores:clear', { hypothesis_id, evidence_id })
    } else {
      await window.heimdall.invoke('ach:scores:set', {
        session_id: session.id, hypothesis_id, evidence_id, score: next
      })
    }
    await onChanged()
  }

  const addHypothesis = async () => {
    if (!hypothesisInput.trim()) return
    await window.heimdall.invoke('ach:hypotheses:add', {
      session_id: session.id, label: hypothesisInput.trim()
    })
    setHypothesisInput('')
    await onChanged()
  }

  const addEvidence = async () => {
    if (!evidenceInput.trim()) return
    await window.heimdall.invoke('ach:evidence:add', {
      session_id: session.id, claim: evidenceInput.trim()
    })
    setEvidenceInput('')
    await onChanged()
  }

  const generateAlternatives = async () => {
    setGenerating(true)
    try {
      await window.heimdall.invoke('ach:agent:generateHypotheses', {
        session_id: session.id, count: 3
      })
      await onChanged()
    } finally {
      setGenerating(false)
    }
  }

  const deleteHypothesis = async (id: string) => {
    if (!confirm('Delete hypothesis and all its scores?')) return
    await window.heimdall.invoke('ach:hypotheses:delete', { id })
    await onChanged()
  }

  const deleteEvidence = async (id: string) => {
    if (!confirm('Delete evidence card and all its scores?')) return
    await window.heimdall.invoke('ach:evidence:delete', { id })
    await onChanged()
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold">{session.title}</h1>
            <ClassificationBadge level={session.classification} />
            {session.status === 'closed' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono">CLOSED</span>
            )}
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {session.question && (
            <p className="text-xs text-muted-foreground mt-1">{session.question}</p>
          )}
        </div>
      </div>

      {/* Analysis summary */}
      {analysis && (analysis.total_hypotheses > 0 || analysis.total_evidence > 0) && (
        <Card>
          <CardContent className="p-3 flex items-center gap-4 flex-wrap text-xs">
            <div>
              <span className="text-muted-foreground">Hypotheses:</span> <span className="font-mono font-semibold">{analysis.total_hypotheses}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Evidence:</span> <span className="font-mono font-semibold">{analysis.total_evidence}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Scored:</span> <span className="font-mono font-semibold">{analysis.total_hypotheses * analysis.total_evidence - analysis.unscored_count}/{analysis.total_hypotheses * analysis.total_evidence}</span>
            </div>
            {analysis.leading_hypothesis_id && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                <Award className="h-3 w-3" />
                <span className="font-medium">Leading:</span>
                <span className="font-mono">{hypotheses.find((h) => h.id === analysis.leading_hypothesis_id)?.label.slice(0, 40)}</span>
              </div>
            )}
            {analysis.diagnostics.filter((d) => d.is_diagnostic).length > 0 && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <AlertTriangle className="h-3 w-3" />
                {analysis.diagnostics.filter((d) => d.is_diagnostic).length} diagnostic
              </div>
            )}
            <div className="ml-auto text-muted-foreground italic">
              Heuer principle: leading hypothesis = least disconfirming evidence (not most confirming)
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hypotheses input */}
      <div className="flex items-center gap-2">
        <Input
          value={hypothesisInput}
          onChange={(e) => setHypothesisInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addHypothesis()}
          placeholder="Add a hypothesis (e.g. 'PRC is staging an exercise, not preparing invasion')"
          className="text-xs"
        />
        <Button size="sm" onClick={addHypothesis} disabled={!hypothesisInput.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" />Hypothesis
        </Button>
        <Button
          size="sm" variant="outline" onClick={generateAlternatives}
          disabled={generating || hypotheses.length >= 5}
          title="Use AI to generate 3 alternative competing hypotheses"
        >
          {generating ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
          Suggest 3
        </Button>
      </div>

      {/* Evidence input */}
      <div className="flex items-center gap-2">
        <Input
          value={evidenceInput}
          onChange={(e) => setEvidenceInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addEvidence()}
          placeholder="Add an evidence claim (e.g. 'Satellite imagery shows landing-craft assembly at Pingtan Island')"
          className="text-xs"
        />
        <Button size="sm" onClick={addEvidence} disabled={!evidenceInput.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" />Evidence
        </Button>
      </div>

      {/* Matrix */}
      {hypotheses.length === 0 || evidence.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm">
            {hypotheses.length === 0 && evidence.length === 0 ? (
              <>Add at least one hypothesis and one evidence card to begin.</>
            ) : hypotheses.length === 0 ? (
              <>Add hypotheses to start scoring evidence against them.</>
            ) : (
              <>Add evidence cards to score against your hypotheses.</>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky left-0 bg-card/70 backdrop-blur p-2 text-left border-b border-border min-w-[280px] max-w-[420px]">Evidence</th>
                {hypotheses.map((h) => {
                  const card = cardMap.get(h.id)
                  const isLeading = card?.is_leading
                  return (
                    <th key={h.id} className={cn(
                      'p-2 text-left border-b border-border min-w-[160px] max-w-[260px] align-top',
                      isLeading && 'bg-emerald-500/10'
                    )}>
                      <div className="flex items-start gap-1.5">
                        <span className="text-muted-foreground/70 font-mono text-[10px] mt-0.5">H{h.ordinal}</span>
                        <div className="flex-1">
                          <div className="font-semibold leading-tight" title={h.description || ''}>{h.label}</div>
                          {h.source === 'agent' && (
                            <span className="inline-flex items-center gap-0.5 mt-0.5 text-[9px] text-purple-300">
                              <Sparkles className="h-2.5 w-2.5" />ai
                            </span>
                          )}
                          {card && card.scored_count > 0 && (
                            <div className="text-[10px] text-muted-foreground mt-1 font-mono">
                              <span className="text-emerald-400">+{card.consistent_weight}</span>
                              {' / '}
                              <span className="text-red-400">-{card.inconsistent_weight}</span>
                              {isLeading && <Award className="inline h-3 w-3 ml-1 text-emerald-400" />}
                            </div>
                          )}
                        </div>
                        <button onClick={() => deleteHypothesis(h.id)} className="text-muted-foreground hover:text-destructive opacity-50 hover:opacity-100">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {evidence.map((ev) => {
                const diag = diagnosticMap.get(ev.id)
                return (
                  <tr key={ev.id}>
                    <td className={cn(
                      'sticky left-0 bg-card/70 backdrop-blur p-2 border-b border-border align-top',
                      diag?.is_diagnostic && 'border-l-2 border-l-amber-500/60'
                    )}>
                      <div className="flex items-start gap-1.5">
                        <span className="text-muted-foreground/70 font-mono text-[10px] mt-0.5">E{ev.ordinal}</span>
                        <div className="flex-1 min-w-0">
                          <div className="leading-snug">{ev.claim}</div>
                          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground/80">
                            {ev.credibility != null && (
                              <span className="font-mono">cred: {ev.credibility}</span>
                            )}
                            {ev.weight !== 1 && (
                              <span className="font-mono">w: {ev.weight}</span>
                            )}
                            {ev.source_label && <span>via {ev.source_label}</span>}
                            {diag?.is_diagnostic && (
                              <span className="inline-flex items-center gap-0.5 px-1 rounded bg-amber-500/15 text-amber-300" title={`Diagnostic value: ${diag.diagnostic_value}`}>
                                <AlertTriangle className="h-2.5 w-2.5" /> diagnostic
                              </span>
                            )}
                          </div>
                        </div>
                        <button onClick={() => deleteEvidence(ev.id)} className="text-muted-foreground hover:text-destructive opacity-50 hover:opacity-100">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                    {hypotheses.map((h) => {
                      const score = scoreMap.get(`${h.id}:${ev.id}`)
                      return (
                        <td key={h.id} className="p-1.5 border-b border-border text-center align-middle">
                          <button
                            onClick={() => cycleScore(h.id, ev.id)}
                            className={cn(
                              'w-12 h-7 rounded border font-mono font-bold text-xs hover:opacity-100 transition-opacity',
                              score ? SCORE_COLORS[score] : 'border-border/40 text-muted-foreground/40 hover:border-border'
                            )}
                            title={score ? SCORE_TOOLTIPS[score] : 'Click to score'}
                          >
                            {score || '—'}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="mt-3 text-[10px] text-muted-foreground italic">
            Click a cell to cycle: <span className="font-mono">— → CC → C → N → I → II → —</span>.
            Score sums weight evidence by credibility (1=high, 6=cannot judge). Diagnostic evidence (high score variance) is flagged with the amber rail.
          </div>
        </div>
      )}
    </div>
  )
}

function CreateSessionDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [classification, setClassification] = useState<Classification>('UNCLASSIFIED')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) { setTitle(''); setQuestion(''); setClassification('UNCLASSIFIED') }
  }, [open])

  const submit = async () => {
    if (!title.trim()) return
    setSubmitting(true)
    try {
      const session = await window.heimdall.invoke('ach:sessions:create', {
        title: title.trim(),
        question: question.trim() || undefined,
        classification
      }) as { id: string }
      onCreated(session.id)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />New ACH Session
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Session Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='e.g. "What explains PLA Eastern Theater activity?"' />
          </div>
          <div>
            <Label>Detail Question (optional)</Label>
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Elaborate the analytic question" />
          </div>
          <div>
            <Label>Classification</Label>
            <Select value={classification} onValueChange={(v) => setClassification(v as Classification)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CLASSIFICATION_LEVELS.map((lvl) => <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !title.trim()}>
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
