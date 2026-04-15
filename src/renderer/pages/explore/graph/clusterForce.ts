/**
 * Discipline-cluster force for react-force-graph-2d.
 *
 * Pulls same-discipline nodes toward a shared centroid each tick so the graph
 * naturally separates into themed regions instead of one giant blob.
 *
 * Usage inside `d3Force={(sim) => ...}`:
 *   sim.force('cluster', clusterForce(nodes, 'discipline', 0.08))
 */

type AnyNode = { x?: number; y?: number; vx?: number; vy?: number; [key: string]: unknown }

export function clusterForce(
  nodes: AnyNode[],
  groupKey: string = 'discipline',
  strength: number = 0.08
): (alpha: number) => void {
  // Deterministic centroid seeds — distribute groups evenly around a circle
  const groups = new Map<string, { x: number; y: number }>()
  const uniqueGroups = Array.from(new Set(nodes.map((n) => String(n[groupKey] ?? 'unknown'))))
  const R = 400
  uniqueGroups.forEach((g, i) => {
    const theta = (i / uniqueGroups.length) * Math.PI * 2
    groups.set(g, { x: R * Math.cos(theta), y: R * Math.sin(theta) })
  })

  // Running centroids (updated each tick from actual node positions)
  const centroids = new Map<string, { x: number; y: number; count: number }>()

  return function force(alpha: number): void {
    // Reset centroid accumulators
    centroids.clear()
    for (const node of nodes) {
      const g = String(node[groupKey] ?? 'unknown')
      const cur = centroids.get(g) || { x: 0, y: 0, count: 0 }
      cur.x += node.x || 0
      cur.y += node.y || 0
      cur.count += 1
      centroids.set(g, cur)
    }

    // Seed centroids for groups with < 2 nodes (use evenly-spaced anchors)
    for (const [g, c] of centroids.entries()) {
      if (c.count > 0) {
        c.x /= c.count
        c.y /= c.count
      } else {
        const seed = groups.get(g)!
        c.x = seed.x
        c.y = seed.y
      }
    }

    // Apply pull toward centroid
    const k = strength * alpha
    for (const node of nodes) {
      const g = String(node[groupKey] ?? 'unknown')
      const c = centroids.get(g)
      if (!c || node.x == null || node.y == null) continue
      node.vx = (node.vx || 0) + (c.x - node.x) * k
      node.vy = (node.vy || 0) + (c.y - node.y) * k
    }
  }
}
