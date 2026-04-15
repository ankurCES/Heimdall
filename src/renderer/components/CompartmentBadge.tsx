import { useEffect, useState } from 'react'
import { cn } from '@renderer/lib/utils'

/**
 * Need-to-know compartment ticket badge — Theme 10.2 + 10.5.
 *
 * Renders the compartment ticket(s) as compact monospace pills next to
 * an artifact, e.g.  `[SI//NOFORN]`. When the user lacks a grant for any
 * required compartment, the badge renders in red and the artifact body
 * should also be redacted (gating logic lives in callers; this is just
 * the visual marker).
 */

interface Compartment {
  id: string
  ticket: string
  name: string
  color: string | null
}

interface Props {
  /** Compartment IDs tagged on the artifact. */
  compartmentIds: string[]
  /** Optional pre-resolved metadata (avoids fetch when caller already has it). */
  compartments?: Compartment[]
  /** Render compact (just tickets) vs verbose (tickets + names). */
  variant?: 'compact' | 'verbose'
}

// Module-level cache so we only hit IPC once per ticket value across renders
let _allCompartments: Compartment[] | null = null
let _grantedIds: Set<string> | null = null
const _listeners = new Set<() => void>()

async function loadCompartments(): Promise<void> {
  try {
    const list = await window.heimdall.invoke('compartments:list') as Compartment[]
    _allCompartments = list
    const granted = await window.heimdall.invoke('compartments:granted_ids') as string[]
    _grantedIds = new Set(granted)
    for (const cb of _listeners) cb()
  } catch {
    _allCompartments = []
    _grantedIds = new Set()
  }
}

export function invalidateCompartmentCache(): void {
  _allCompartments = null
  _grantedIds = null
  void loadCompartments()
}

export function CompartmentBadge({ compartmentIds, compartments, variant = 'compact' }: Props) {
  const [, force] = useState(0)

  useEffect(() => {
    if (compartments) return // caller already supplied resolved data
    if (_allCompartments == null) void loadCompartments()
    const cb = () => force((n) => n + 1)
    _listeners.add(cb)
    return () => { _listeners.delete(cb) }
  }, [compartments])

  if (!compartmentIds || compartmentIds.length === 0) return null

  const all = compartments ?? _allCompartments ?? []
  const granted = _grantedIds ?? new Set<string>()
  const resolved = compartmentIds.map((id) => all.find((c) => c.id === id) ?? { id, ticket: '?', name: 'Unknown', color: null })

  const lacksGrant = compartmentIds.some((id) => !granted.has(id))

  const tooltip = resolved.map((c) => `${c.ticket}: ${c.name}`).join('\n')

  return (
    <span
      className={cn(
        'inline-flex items-center px-1 rounded text-[9px] font-bold font-mono border select-none cursor-help',
        lacksGrant
          ? 'border-red-500/60 bg-red-500/15 text-red-300'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
      )}
      title={tooltip + (lacksGrant ? '\n\n⚠ You lack a grant for one or more of these compartments.' : '')}
      aria-label={`Compartments: ${resolved.map((c) => c.ticket).join('//')}`}
    >
      {variant === 'verbose'
        ? resolved.map((c) => c.ticket).join(' / ')
        : resolved.map((c) => c.ticket).join('//')}
    </span>
  )
}
