// WhatsNewModal — v2.0.0 first-launch release-notes splash.
//
// Pops up once per major version when the user first opens the app
// after upgrading. The "seen" version is recorded in localStorage so
// the modal only fires when the actual app version is newer.
//
// Listing only the user-facing additions of v1.9.0–v2.0.0 (Phase 10:
// the analytical workspace stack).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Sparkles, Brain, ListChecks, Scale, History as HistoryIcon, ShieldOff,
  ListTodo, Gauge, ArrowRight
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'

const STORAGE_KEY = 'whatsnew.seenVersion'
const TRIGGER_VERSION = '2.0.0'

interface FeatureRow {
  icon: typeof Brain
  label: string
  desc: string
  to: string
}

const FEATURES: FeatureRow[] = [
  { icon: Brain,       label: 'Analyst Workspace',      desc: 'One-glance home for every analytical surface — open hypotheses, recent critiques, vulnerable assumptions, due-soon estimates.', to: '/workspace' },
  { icon: ListChecks,  label: 'Hypothesis Tracker',     desc: 'Operationalised ACH. Every 15 min, the system scores incoming intel against your active hypotheses.', to: '/hypotheses' },
  { icon: Scale,       label: 'Comparative Analysis',   desc: 'Side-by-side LLM-generated comparisons of two entities or two time windows.', to: '/comparisons' },
  { icon: HistoryIcon, label: 'Chronology Builder',     desc: 'Curate timelines from raw events — pick what matters, annotate, reorder, export.', to: '/chronologies' },
  { icon: ShieldOff,   label: 'Red-Team Critiques',     desc: 'LLM argues against your conclusions. Surfaces weak assumptions and cognitive biases.', to: '/critiques' },
  { icon: ListTodo,    label: 'Key Assumptions Check',  desc: 'List & grade the assumptions your analysis depends on — extract them via LLM from any artifact.', to: '/assumptions' },
  { icon: Gauge,       label: 'Estimative Tracker',     desc: 'Log forecasts with WEP probability, deadline, resolution criteria. Tracks your Brier-score calibration over time.', to: '/estimates' }
]

export function WhatsNewModal() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current = await window.heimdall.invoke('app:getVersion') as string
        if (!current) return
        const seen = localStorage.getItem(STORAGE_KEY) || ''
        // Show only if current >= TRIGGER and seen < TRIGGER (prevent
        // re-show after acknowledgement).
        if (cmpVersion(current, TRIGGER_VERSION) >= 0 && cmpVersion(seen, TRIGGER_VERSION) < 0) {
          if (!cancelled) setOpen(true)
        }
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [])

  const dismiss = () => {
    try {
      // Persist the trigger version so the modal won't fire again
      // until a future release bumps TRIGGER_VERSION.
      localStorage.setItem(STORAGE_KEY, TRIGGER_VERSION)
    } catch { /* ignore */ }
    setOpen(false)
  }

  const goTo = (to: string) => {
    dismiss()
    navigate(to)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) dismiss() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Welcome to Heimdall 2.0
          </DialogTitle>
          <DialogDescription>
            Phase 10 ships the analytical-workspace stack — the analyst-facing layer on top of
            the ingest, enrichment, and entity-resolution work of earlier phases. Every artifact
            below is a first-class persisted object you can drill into, link, and stress-test.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-1 max-h-[60vh] overflow-y-auto">
          {FEATURES.map((f) => {
            const Icon = f.icon
            return (
              <button
                key={f.to}
                onClick={() => goTo(f.to)}
                className="w-full text-left p-3 rounded-md border border-border hover:border-primary/40 hover:bg-accent/40 transition-colors flex items-start gap-3"
              >
                <Icon className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium flex items-center gap-1">
                    {f.label}
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{f.desc}</div>
                </div>
              </button>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>Skip tour</Button>
          <Button onClick={() => goTo('/workspace')}>Open Workspace</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Compare two semver-ish strings. Returns negative / 0 / positive. */
function cmpVersion(a: string, b: string): number {
  const ap = a.split('.').map((n) => parseInt(n, 10))
  const bp = b.split('.').map((n) => parseInt(n, 10))
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = Number.isFinite(ap[i]) ? ap[i] : 0
    const bv = Number.isFinite(bp[i]) ? bp[i] : 0
    if (av !== bv) return av - bv
  }
  return 0
}
