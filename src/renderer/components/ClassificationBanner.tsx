import { cn } from '@renderer/lib/utils'

/**
 * US/NATO classification levels — ordered low → high.
 * UI banners use the canonical color scheme:
 *   UNCLASSIFIED → green
 *   CONFIDENTIAL → blue
 *   SECRET       → red
 *   TOP SECRET   → orange/yellow
 *
 * Heimdall is a single-user tool today; the user's clearance is set in
 * Settings → Security and gates rendering of higher-classified material
 * (the gate itself is enforced renderer-side via Feed list filter +
 * detail-pane redaction overlay; multi-user RBAC is deferred to
 * Theme 10.10).
 */

export const CLASSIFICATION_LEVELS = ['UNCLASSIFIED', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'] as const
export type Classification = (typeof CLASSIFICATION_LEVELS)[number]

export const CLASSIFICATION_RANK: Record<Classification, number> = {
  UNCLASSIFIED: 0,
  CONFIDENTIAL: 1,
  SECRET: 2,
  'TOP SECRET': 3
}

export function isClassification(s: unknown): s is Classification {
  return typeof s === 'string' && (CLASSIFICATION_LEVELS as readonly string[]).includes(s)
}

/** True if user with `clearance` is allowed to see content classified `level`. */
export function isCleared(clearance: Classification, level: Classification): boolean {
  return CLASSIFICATION_RANK[clearance] >= CLASSIFICATION_RANK[level]
}

const CLASS_BANNER_BG: Record<Classification, string> = {
  UNCLASSIFIED: 'bg-green-700/90 text-white',
  CONFIDENTIAL: 'bg-blue-700/90 text-white',
  SECRET: 'bg-red-700/90 text-white',
  'TOP SECRET': 'bg-orange-600/90 text-black'
}

const CLASS_BADGE_BG: Record<Classification, string> = {
  UNCLASSIFIED: 'bg-green-700/80 text-white border-green-600',
  CONFIDENTIAL: 'bg-blue-700/80 text-white border-blue-600',
  SECRET: 'bg-red-700/80 text-white border-red-600',
  'TOP SECRET': 'bg-orange-500/90 text-black border-orange-400'
}

/**
 * Full-width banner. Place at the top of any page rendering classified
 * material. Shows the highest classification visible on the page.
 */
export function ClassificationBanner({ level, className }: { level: Classification; className?: string }) {
  return (
    <div
      className={cn(
        'w-full text-center text-[10px] font-bold tracking-[0.3em] uppercase py-0.5 select-none',
        CLASS_BANNER_BG[level],
        className
      )}
      role="banner"
      aria-label={`Classification banner: ${level}`}
    >
      {level}
    </div>
  )
}

/**
 * Compact inline badge. Renders next to a single artifact.
 */
export function ClassificationBadge({ level, className }: { level: Classification | null | undefined; className?: string }) {
  const lvl: Classification = isClassification(level) ? level : 'UNCLASSIFIED'
  if (lvl === 'UNCLASSIFIED') {
    // De-emphasize the most common case so the eye is drawn to elevated marks
    return (
      <span className={cn('inline-flex items-center px-1 rounded text-[9px] font-bold border border-green-700/40 text-green-400/70 bg-transparent', className)}>
        U
      </span>
    )
  }
  // Abbreviate for inline density: C / S / TS
  const abbrev = lvl === 'CONFIDENTIAL' ? 'C' : lvl === 'SECRET' ? 'S' : 'TS'
  return (
    <span
      className={cn('inline-flex items-center px-1 rounded text-[9px] font-bold border', CLASS_BADGE_BG[lvl], className)}
      title={lvl}
      aria-label={`Classification: ${lvl}`}
    >
      {abbrev}
    </span>
  )
}
