/**
 * Radial layout — concentric rings, one ring per discipline.
 *
 * Each discipline gets its own radius; nodes are placed around the ring at
 * stable angles derived from node id (so layout persists across refreshes).
 */

export interface RadialNode {
  id: string
  discipline?: string
}

export interface RadialPosition {
  id: string
  x: number
  y: number
  fx: number
  fy: number
}

// Order disciplines inner→outer. HUMINT / preliminary / gaps sit in inner rings
// because they typically have fewer nodes and are reference/summary products.
const RING_ORDER = [
  'humint',
  'preliminary',
  'gap',
  'agency',
  'ci',
  'finint',
  'cybint',
  'geoint',
  'sigint',
  'imint',
  'socmint',
  'rumint',
  'osint'
]

const INNER_R = 120
const RING_GAP = 80

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return (h >>> 0) / 4294967295
}

export function computeRadialLayout(nodes: RadialNode[]): Map<string, RadialPosition> {
  const out = new Map<string, RadialPosition>()
  if (nodes.length === 0) return out

  // Group nodes by discipline
  const byDisc = new Map<string, RadialNode[]>()
  for (const node of nodes) {
    const d = node.discipline || 'unknown'
    if (!byDisc.has(d)) byDisc.set(d, [])
    byDisc.get(d)!.push(node)
  }

  // Assign ring index (inner→outer)
  const orderedDisciplines = Array.from(byDisc.keys()).sort((a, b) => {
    const ra = RING_ORDER.indexOf(a)
    const rb = RING_ORDER.indexOf(b)
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
  })

  orderedDisciplines.forEach((disc, ringIdx) => {
    const ringNodes = byDisc.get(disc)!
    const r = INNER_R + ringIdx * RING_GAP
    // Sort nodes by id for stable angular placement
    const sorted = [...ringNodes].sort((a, b) => a.id.localeCompare(b.id))
    sorted.forEach((node, i) => {
      // Evenly distribute around the ring, with small jitter from hash to avoid perfect alignment
      const baseTheta = (i / sorted.length) * Math.PI * 2
      const jitter = (hash(node.id) - 0.5) * 0.08 // ±~2°
      const theta = baseTheta + jitter
      const x = r * Math.cos(theta)
      const y = r * Math.sin(theta)
      out.set(node.id, { id: node.id, x, y, fx: x, fy: y })
    })
  })

  return out
}

export function getRadialRingInfo(nodes: RadialNode[]): Array<{ discipline: string; r: number }> {
  const byDisc = new Set(nodes.map((n) => n.discipline || 'unknown'))
  const ordered = Array.from(byDisc).sort((a, b) => {
    const ra = RING_ORDER.indexOf(a)
    const rb = RING_ORDER.indexOf(b)
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb)
  })
  return ordered.map((d, i) => ({ discipline: d, r: INNER_R + i * RING_GAP }))
}
