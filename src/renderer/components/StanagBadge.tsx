import { cn } from '@renderer/lib/utils'

/**
 * NATO STANAG 2511 / Admiralty Code two-axis intelligence rating.
 * Renders a compact badge of the form "B2" — source reliability +
 * information credibility — with a tooltip explaining each axis.
 *
 * This is the agency-grade replacement for the old 0–100 verification
 * score. The verification score is still computed (used internally for
 * legacy widgets) but every analyst-facing surface should display the
 * STANAG rating.
 */

export type AdmiraltyReliability = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
export type Credibility = 1 | 2 | 3 | 4 | 5 | 6

export const RELIABILITY_LABELS: Record<AdmiraltyReliability, string> = {
  A: 'Completely reliable',
  B: 'Usually reliable',
  C: 'Fairly reliable',
  D: 'Not usually reliable',
  E: 'Unreliable',
  F: 'Reliability unknown'
}

export const RELIABILITY_DESCRIPTIONS: Record<AdmiraltyReliability, string> = {
  A: 'Sole authority. History of total reliability. Use without caveat.',
  B: 'History of mostly correct information. Reliable in most cases.',
  C: 'Some past success. Occasional doubt. Treat as worthwhile but corroborate.',
  D: 'Mostly invalid in the past. Treat with skepticism.',
  E: 'History of invalid information. Use only with strong corroboration.',
  F: 'Cannot be judged. New or insufficient sample.'
}

export const CREDIBILITY_LABELS: Record<Credibility, string> = {
  1: 'Confirmed',
  2: 'Probably true',
  3: 'Possibly true',
  4: 'Doubtfully true',
  5: 'Improbable',
  6: 'Truth cannot be judged'
}

export const CREDIBILITY_DESCRIPTIONS: Record<Credibility, string> = {
  1: 'Confirmed by other independent sources.',
  2: 'Logical, consistent with other intel, no contradiction.',
  3: 'Reasonably logical, agrees with some intel.',
  4: 'Not logical but possible. No other evidence.',
  5: 'Illogical, contradicted by other intel.',
  6: 'Insufficient evidence to judge.'
}

const RELIABILITY_COLORS: Record<AdmiraltyReliability, string> = {
  A: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  B: 'bg-green-500/15 text-green-300 border-green-500/40',
  C: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/40',
  D: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  E: 'bg-red-500/15 text-red-300 border-red-500/40',
  F: 'bg-slate-500/15 text-slate-300 border-slate-500/40'
}

const CREDIBILITY_COLORS: Record<Credibility, string> = {
  1: 'bg-emerald-500/15 text-emerald-300',
  2: 'bg-green-500/15 text-green-300',
  3: 'bg-yellow-500/15 text-yellow-300',
  4: 'bg-orange-500/15 text-orange-300',
  5: 'bg-red-500/15 text-red-300',
  6: 'bg-slate-500/15 text-slate-300'
}

export interface StanagBadgeProps {
  /** A–F. null/undefined renders as F (unknown). */
  reliability: AdmiraltyReliability | null | undefined
  /** 1–6. null/undefined renders as 6 (cannot be judged). */
  credibility: number | null | undefined
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Render the combined STANAG rating, e.g. "B2" with both axes color-coded
 * and the meaning surfaced in the title attribute (native tooltip).
 */
export function StanagBadge({ reliability, credibility, size = 'sm', className }: StanagBadgeProps) {
  const r: AdmiraltyReliability = (reliability && ['A', 'B', 'C', 'D', 'E', 'F'].includes(reliability))
    ? reliability
    : 'F'
  const c: Credibility = (credibility && credibility >= 1 && credibility <= 6
    ? Math.round(credibility)
    : 6) as Credibility

  const tooltip = [
    `STANAG 2511 rating: ${r}${c}`,
    '',
    `Source reliability ${r}: ${RELIABILITY_LABELS[r]}`,
    `  ${RELIABILITY_DESCRIPTIONS[r]}`,
    '',
    `Information credibility ${c}: ${CREDIBILITY_LABELS[c]}`,
    `  ${CREDIBILITY_DESCRIPTIONS[c]}`
  ].join('\n')

  const padding = size === 'sm' ? 'px-1 py-0' : 'px-1.5 py-0.5'
  const text = size === 'sm' ? 'text-[10px]' : 'text-xs'

  return (
    <span
      className={cn('inline-flex items-stretch border rounded font-mono select-none cursor-help', text, RELIABILITY_COLORS[r], className)}
      title={tooltip}
      aria-label={`STANAG 2511 ${r}${c}: ${RELIABILITY_LABELS[r]}; ${CREDIBILITY_LABELS[c]}`}
    >
      <span className={cn('font-bold border-r border-current/30', padding)}>{r}</span>
      <span className={cn(padding, CREDIBILITY_COLORS[c])}>{c}</span>
    </span>
  )
}
