import { useMemo, useState } from 'react'
import { Lightbulb, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * ICD 203 (Intelligence Community Directive 203) prescribes a precise vocabulary
 * for expressing analytic confidence in estimative judgments. Loose words like
 * "likely", "could", "may", "possible" are ambiguous and analyst products
 * outside the ICD scale are routinely rejected by senior reviewers.
 *
 * This component scans assistant chat output for ambiguous probability words
 * and surfaces a small, dismissible hint card below the message with the
 * canonical ICD 203 alternative. It does NOT rewrite the message — the
 * reviewer/analyst chooses whether to revise.
 *
 * Reference: https://www.dni.gov/files/documents/ICD/ICD%20203%20Analytic%20Standards.pdf
 */

interface IcdMapping {
  /** Regex matching an ambiguous word/phrase in chat output. */
  pattern: RegExp
  /** ICD 203 canonical alternatives the analyst should pick from. */
  alternatives: string[]
  /** Plain-language explanation of why the original is ambiguous. */
  rationale: string
}

// Order matters — earlier patterns match first to avoid double-flagging.
const ICD_MAPPINGS: IcdMapping[] = [
  {
    pattern: /\b(possibly|might|may)\b/gi,
    alternatives: ['unlikely', 'roughly even chance', 'likely'],
    rationale: 'ICD 203 reserves "possibly" for the lower-probability range; specify which one you mean.'
  },
  {
    pattern: /\b(probably|likely)\b/gi,
    alternatives: ['very likely', 'likely', 'roughly even chance'],
    rationale: 'ICD 203 distinguishes "very likely" (~80–95%) from "likely" (~55–80%). Pick the band you mean.'
  },
  {
    pattern: /\b(could|may be)\b/gi,
    alternatives: ['unlikely', 'roughly even chance', 'likely'],
    rationale: '"Could" / "may be" carries no probability. ICD 203 requires a band.'
  },
  {
    pattern: /\b(certainly|definitely|undoubtedly)\b/gi,
    alternatives: ['almost certainly'],
    rationale: 'ICD 203 caps the ceiling at "almost certainly" (~95–99%); reserve "certain" for confirmed fact.'
  },
  {
    pattern: /\b(impossible|never)\b/gi,
    alternatives: ['almost no chance'],
    rationale: 'ICD 203 caps the floor at "almost no chance" (~01–05%); analytic judgments should not claim impossibility.'
  },
  {
    pattern: /\b(seems?|appears? to)\b/gi,
    alternatives: ['judged to be likely', 'judged to be unlikely', 'analyst assesses that'],
    rationale: '"Seems" / "appears" reads as analyst opinion not analytic judgment. Use the standard estimative scale or attribute the assessment.'
  }
]

const ICD_SCALE = [
  { label: 'almost no chance', range: '~01–05%' },
  { label: 'very unlikely', range: '~05–20%' },
  { label: 'unlikely', range: '~20–45%' },
  { label: 'roughly even chance', range: '~45–55%' },
  { label: 'likely', range: '~55–80%' },
  { label: 'very likely', range: '~80–95%' },
  { label: 'almost certainly', range: '~95–99%' }
]

interface Hit {
  match: string
  alternatives: string[]
  rationale: string
}

function findIcdViolations(text: string): Hit[] {
  const hits: Hit[] = []
  const seen = new Set<string>()
  for (const mapping of ICD_MAPPINGS) {
    // Reset regex (global flag has stateful lastIndex)
    mapping.pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = mapping.pattern.exec(text)) !== null) {
      const word = m[1].toLowerCase()
      if (seen.has(word)) continue
      seen.add(word)
      hits.push({
        match: m[1],
        alternatives: mapping.alternatives,
        rationale: mapping.rationale
      })
      // Cap so we don't flag every occurrence of common words like "may"
      if (hits.length >= 5) return hits
    }
  }
  return hits
}

interface Props {
  /** Full assistant message text — markdown allowed; we strip code fences before scanning. */
  content: string
}

/**
 * Compact, dismissible hint card. Renders nothing if no violations found.
 */
export function IcdProbabilityHints({ content }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const hits = useMemo(() => {
    if (!content) return []
    // Strip fenced code blocks and inline code so we don't flag words inside them
    const stripped = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
    return findIcdViolations(stripped)
  }, [content])

  if (dismissed || hits.length === 0) return null

  return (
    <div className="mt-2 border border-amber-500/30 bg-amber-500/5 rounded-md text-[11px]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-amber-300 hover:bg-amber-500/10 rounded-md"
      >
        <Lightbulb className="h-3 w-3 shrink-0" />
        <span className="font-medium">ICD 203:</span>
        <span className="text-amber-300/80">
          {hits.length} ambiguous probability word{hits.length === 1 ? '' : 's'} detected
        </span>
        {expanded ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t border-amber-500/20 pt-2">
          {hits.map((h, i) => (
            <div key={i} className="space-y-0.5">
              <div className="flex items-baseline gap-2">
                <code className="font-mono px-1 rounded bg-red-500/15 text-red-300">{h.match}</code>
                <span className="text-muted-foreground/70">→</span>
                <span className="text-foreground/90">
                  {h.alternatives.map((alt, ai) => (
                    <span key={ai}>
                      <code className="font-mono px-1 rounded bg-emerald-500/15 text-emerald-300">{alt}</code>
                      {ai < h.alternatives.length - 1 ? ' / ' : ''}
                    </span>
                  ))}
                </span>
              </div>
              <p className="text-muted-foreground/70 italic pl-1">{h.rationale}</p>
            </div>
          ))}

          <details className="pt-1.5 border-t border-amber-500/15">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
              ICD 203 estimative probability scale
            </summary>
            <ul className="mt-1.5 space-y-0.5 text-[10px] font-mono">
              {ICD_SCALE.map((s) => (
                <li key={s.label} className={cn('flex items-baseline gap-2')}>
                  <span className="text-emerald-400">{s.label}</span>
                  <span className="text-muted-foreground/70">{s.range}</span>
                </li>
              ))}
            </ul>
          </details>

          <div className="flex justify-end pt-1">
            <button
              onClick={() => setDismissed(true)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
