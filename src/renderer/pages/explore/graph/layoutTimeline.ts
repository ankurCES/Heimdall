/**
 * Timeline swimlane layout — pins nodes at fixed positions.
 *
 * X-axis = createdAt (linear or log depending on spread)
 * Y-axis = discipline lane (enum → integer row)
 *
 * Returns a map of nodeId → {x, y, fx, fy}. fx/fy are the fixed-position
 * overrides used by d3-force to freeze a node in place.
 */

const DISCIPLINE_LANES: Record<string, number> = {
  osint: 0,
  cybint: 1,
  finint: 2,
  socmint: 3,
  geoint: 4,
  sigint: 5,
  rumint: 6,
  ci: 7,
  agency: 8,
  imint: 9,
  preliminary: 10,
  humint: 11,
  gap: 12
}

export interface TimelineNode {
  id: string
  discipline?: string
  createdAt?: number
}

export interface TimelinePosition {
  id: string
  x: number
  y: number
  fx: number
  fy: number
}

const WIDTH = 1800        // canvas-space X extent
const HEIGHT = 1000       // canvas-space Y extent (centered at 0)
const LANE_HEIGHT = 60    // vertical spacing between lanes
const JITTER_Y = 14       // ± jitter to avoid stacking

// Stable pseudo-random per id so re-layout doesn't jump on refresh
function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return (h >>> 0) / 4294967295 // → [0, 1)
}

export function computeTimelineLayout(nodes: TimelineNode[]): Map<string, TimelinePosition> {
  const out = new Map<string, TimelinePosition>()
  if (nodes.length === 0) return out

  // Establish time range
  const times = nodes.map((n) => n.createdAt || Date.now()).filter((t) => t > 0)
  const minT = Math.min(...times)
  const maxT = Math.max(...times)
  const span = Math.max(1, maxT - minT)

  // If span is < 1 hour, use linear; otherwise log-scale to compress long tails
  const useLog = span > 24 * 60 * 60 * 1000

  // Lane centering — center discipline lanes vertically around 0
  const usedDisciplines = new Set(nodes.map((n) => n.discipline || 'unknown'))
  const laneCount = Array.from(usedDisciplines).length
  const yOffset = -((laneCount - 1) * LANE_HEIGHT) / 2

  // Map actual disciplines to compact lane indices so gaps in DISCIPLINE_LANES
  // don't leave empty rows on screen
  const usedLaneOrder = Array.from(usedDisciplines).sort((a, b) => {
    const la = DISCIPLINE_LANES[a] ?? 99
    const lb = DISCIPLINE_LANES[b] ?? 99
    return la - lb
  })
  const laneIndexFor = new Map(usedLaneOrder.map((d, i) => [d, i]))

  for (const node of nodes) {
    const t = node.createdAt || minT
    const norm = (t - minT) / span
    const x = useLog
      ? (Math.log1p(norm * 10) / Math.log1p(10)) * WIDTH - WIDTH / 2
      : norm * WIDTH - WIDTH / 2

    const lane = laneIndexFor.get(node.discipline || 'unknown') ?? 0
    const jitter = (hash(node.id) - 0.5) * JITTER_Y * 2
    const y = yOffset + lane * LANE_HEIGHT + jitter

    out.set(node.id, { id: node.id, x, y, fx: x, fy: y })
  }

  return out
}

export function getTimelineLaneInfo(nodes: TimelineNode[]): Array<{ discipline: string; y: number }> {
  const usedDisciplines = Array.from(new Set(nodes.map((n) => n.discipline || 'unknown')))
    .sort((a, b) => (DISCIPLINE_LANES[a] ?? 99) - (DISCIPLINE_LANES[b] ?? 99))
  const yOffset = -((usedDisciplines.length - 1) * LANE_HEIGHT) / 2
  return usedDisciplines.map((d, i) => ({ discipline: d, y: yOffset + i * LANE_HEIGHT }))
}

export function getTimelineTimeRange(nodes: TimelineNode[]): { min: number; max: number } {
  const times = nodes.map((n) => n.createdAt || 0).filter((t) => t > 0)
  return { min: Math.min(...times, Date.now()), max: Math.max(...times, Date.now()) }
}
