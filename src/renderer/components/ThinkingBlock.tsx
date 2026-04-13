import { useState } from 'react'
import { ChevronDown, ChevronRight, Brain, Search, BarChart3, Wrench, Check, X, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'

interface ThinkingStep {
  label: string
  content: string
  type: 'planning' | 'researching' | 'analyzing' | 'tool' | 'searching'
  status: 'running' | 'done'
}

const STEP_ICONS = {
  planning: Brain,
  researching: Search,
  analyzing: BarChart3,
  searching: Search,
  tool: Wrench
}

const STEP_COLORS = {
  planning: 'text-violet-400 border-violet-400/20 bg-violet-400/5',
  researching: 'text-blue-400 border-blue-400/20 bg-blue-400/5',
  analyzing: 'text-green-400 border-green-400/20 bg-green-400/5',
  searching: 'text-cyan-400 border-cyan-400/20 bg-cyan-400/5',
  tool: 'text-amber-400 border-amber-400/20 bg-amber-400/5'
}

// Parse thinking steps from streaming content
export function parseThinkingSteps(content: string): { steps: ThinkingStep[]; finalContent: string } {
  const steps: ThinkingStep[] = []
  const lines = content.split('\n')
  let currentStep: ThinkingStep | null = null
  const finalLines: string[] = []
  let inThinking = false

  for (const line of lines) {
    // Match **[Label]** or **[Label X/Y]** patterns
    const stepMatch = line.match(/^\*\*\[(Planning|Researching|Research|Analyzing|Searching|Tool)[^\]]*\]\*\*\s*(.*)$/i)

    if (stepMatch) {
      // Save previous step
      if (currentStep) steps.push(currentStep)

      const label = stepMatch[0].replace(/\*\*/g, '').trim()
      const type = stepMatch[1].toLowerCase().startsWith('research') ? 'researching' as const :
        stepMatch[1].toLowerCase() as ThinkingStep['type']

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

export function ThinkingBlocks({ content, isStreaming }: { content: string; isStreaming: boolean }) {
  const { steps, finalContent } = parseThinkingSteps(content)

  if (steps.length === 0) {
    return <MarkdownRenderer content={content} className="text-sm" />
  }

  return (
    <div className="space-y-2">
      {/* Thinking steps — collapsible */}
      {steps.map((step, i) => (
        <CollapsibleStep key={i} step={step} defaultOpen={isStreaming && i === steps.length - 1} />
      ))}

      {/* Final analysis content */}
      {finalContent && (
        <div className="mt-3">
          <MarkdownRenderer content={finalContent} className="text-sm" />
        </div>
      )}
    </div>
  )
}

function CollapsibleStep({ step, defaultOpen }: { step: ThinkingStep; defaultOpen: boolean }) {
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
        <div className="px-3 pb-2 text-[11px] opacity-80 whitespace-pre-wrap border-t border-current/10">
          {step.content.slice(0, 500)}
        </div>
      )}
    </div>
  )
}
