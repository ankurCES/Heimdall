import { useState } from 'react'
import { ChevronDown, ChevronRight, Brain, Search, BarChart3, Wrench, Check, Loader2, ListChecks, Cpu } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'

interface ThinkingStep {
  label: string
  content: string
  type: 'planning' | 'plan' | 'researching' | 'analyzing' | 'tool' | 'searching' | 'model'
  status: 'running' | 'done'
}

const STEP_ICONS = {
  planning: Brain,
  plan: ListChecks,
  researching: Search,
  analyzing: BarChart3,
  searching: Search,
  tool: Wrench,
  model: Cpu
}

const STEP_COLORS = {
  planning: 'text-violet-400 border-violet-400/20 bg-violet-400/5',
  plan: 'text-fuchsia-400 border-fuchsia-400/20 bg-fuchsia-400/5',
  researching: 'text-blue-400 border-blue-400/20 bg-blue-400/5',
  analyzing: 'text-green-400 border-green-400/20 bg-green-400/5',
  searching: 'text-cyan-400 border-cyan-400/20 bg-cyan-400/5',
  tool: 'text-amber-400 border-amber-400/20 bg-amber-400/5',
  model: 'text-indigo-400 border-indigo-400/20 bg-indigo-400/5'
}

// Parse thinking steps from streaming content
export function parseThinkingSteps(content: string): { steps: ThinkingStep[]; finalContent: string } {
  const steps: ThinkingStep[] = []
  const lines = content.split('\n')
  let currentStep: ThinkingStep | null = null
  const finalLines: string[] = []
  let inThinking = false

  for (const line of lines) {
    // Match **[Label]** or **[Label X/Y]** patterns. Recognised labels:
    //   Planning, Plan, Model routing, Researching, Research X/Y, Analyzing,
    //   Searching, Tool: <name>, Executing: <name>, No data found,
    //   Follow-up, Web crawl depth N, File download, File found depth N,
    //   Auto-discovered, Research skip, Research complete.
    const stepMatch = line.match(/^\*\*\[(Planning|Plan|Model routing|Model|Researching|Research|Analyzing|Searching|Tool|Executing|No data found|Follow-up|Web crawl depth|File download|File found depth|Auto-discovered|Research skip|Research complete)[^\]]*\]\*\*\s*(.*)$/i)

    if (stepMatch) {
      // Save previous step
      if (currentStep) steps.push(currentStep)

      const label = stepMatch[0].replace(/\*\*/g, '').trim()
      const kindLower = stepMatch[1].toLowerCase()
      const type: ThinkingStep['type'] =
        kindLower === 'plan' ? 'plan' :
        kindLower === 'model routing' || kindLower === 'model' ? 'model' :
        kindLower.startsWith('research') ? 'researching' :
        kindLower === 'executing' || kindLower.startsWith('web crawl') || kindLower.startsWith('file') || kindLower.startsWith('auto-discover') ? 'tool' :
        kindLower === 'follow-up' ? 'planning' :
        kindLower === 'no data found' || kindLower === 'research skip' ? 'searching' :
        (kindLower as ThinkingStep['type'])

      currentStep = {
        label,
        content: stepMatch[2] || '',
        type,
        status: 'running'
      }
      inThinking = true
      continue
    }

    // Check for separator (---) which means thinking is done, analysis follows
    if (line.trim() === '---' && inThinking) {
      if (currentStep) {
        currentStep.status = 'done'
        steps.push(currentStep)
        currentStep = null
      }
      inThinking = false
      continue
    }

    if (inThinking && currentStep) {
      currentStep.content += (currentStep.content ? '\n' : '') + line
    } else if (!inThinking) {
      finalLines.push(line)
    }
  }

  // Push last step
  if (currentStep) steps.push(currentStep)

  // Mark all but last as done
  for (let i = 0; i < steps.length - 1; i++) steps[i].status = 'done'

  return { steps, finalContent: finalLines.join('\n').trim() }
}

/** Max steps visible during live streaming. Older steps fade out.
 *  In expanded mode (Show Thinking popup) all steps are shown. */
const MAX_VISIBLE_STREAMING = 3

export function ThinkingBlocks({ content, isStreaming, expanded }: { content: string; isStreaming: boolean; expanded?: boolean }) {
  const { steps, finalContent } = parseThinkingSteps(content)

  if (steps.length === 0) {
    return <MarkdownRenderer content={content} className="text-sm" />
  }

  // During streaming: only show the last MAX_VISIBLE_STREAMING steps.
  // The oldest visible step gets a fade-out effect. In expanded mode
  // (popup) or after streaming ends, show everything.
  const showAll = expanded || !isStreaming
  const visibleSteps = showAll
    ? steps
    : steps.slice(-MAX_VISIBLE_STREAMING)
  const hiddenCount = showAll ? 0 : Math.max(0, steps.length - MAX_VISIBLE_STREAMING)

  return (
    <div className="space-y-2">
      {/* Hidden steps counter */}
      {hiddenCount > 0 && (
        <div className="text-[10px] text-muted-foreground/50 text-center py-0.5">
          {hiddenCount} earlier step{hiddenCount === 1 ? '' : 's'} completed
        </div>
      )}

      {/* Visible thinking steps */}
      {visibleSteps.map((step, i) => {
        // During streaming, fade the oldest visible step.
        const isFading = isStreaming && !showAll && i === 0 && visibleSteps.length >= MAX_VISIBLE_STREAMING
        return (
          <div
            key={steps.indexOf(step)}
            className={cn('transition-opacity duration-500', isFading ? 'opacity-40' : 'opacity-100')}
          >
            <CollapsibleStep
              step={step}
              defaultOpen={expanded || (isStreaming && steps.indexOf(step) === steps.length - 1)}
              truncate={!expanded}
            />
          </div>
        )
      })}

      {/* Final analysis content */}
      {finalContent && (
        <div className="mt-3">
          <MarkdownRenderer content={finalContent} className="text-sm" />
        </div>
      )}
    </div>
  )
}

function CollapsibleStep({ step, defaultOpen, truncate = true }: { step: ThinkingStep; defaultOpen: boolean; truncate?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const Icon = STEP_ICONS[step.type] || Brain
  const colors = STEP_COLORS[step.type] || STEP_COLORS.planning

  return (
    <div className={cn('border rounded-md overflow-hidden', colors)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium hover:bg-white/5 transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Icon className="h-3 w-3 shrink-0" />
        <span className="flex-1 text-left truncate">{step.label}</span>
        {step.status === 'running' ? (
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
        ) : (
          <Check className="h-3 w-3 shrink-0 opacity-60" />
        )}
      </button>
      {open && step.content && (
        <div className="px-3 pb-2 pt-2 text-[11px] opacity-80 whitespace-pre-wrap border-t border-current/10 font-mono leading-relaxed">
          {truncate ? step.content.slice(0, 500) : step.content}
        </div>
      )}
    </div>
  )
}
