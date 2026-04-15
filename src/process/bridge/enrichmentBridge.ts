import { ipcMain } from 'electron'
import { intelEnricher } from '../services/enrichment/IntelEnricher'
import { kuzuService } from '../services/graphdb/KuzuService'
import { getDatabase } from '../services/database'
import log from 'electron-log'

type RawNode = Record<string, unknown>

/**
 * Resolve a set of node IDs across the four tables that can hold graph nodes
 * (intel_reports, preliminary_reports, humint_reports, intel_gaps). A single
 * node appears in the result exactly once — more specific types (HUMINT,
 * preliminary, gap) override the generic intel_reports row that
 * HumintService writes alongside.
 *
 * This replaces the prior behaviour that fetched only from intel_reports
 * (missing preliminary / gap endpoints of HUMINT links) and that added
 * top-N recent nodes regardless of deduplication (producing duplicate node
 * ids which d3-force silently collapsed, leaving edges dangling).
 */
function resolveNodesById(db: ReturnType<typeof getDatabase>, ids: string[]): Map<string, RawNode> {
  const result = new Map<string, RawNode>()
  if (ids.length === 0) return result

  const placeholders = ids.map(() => '?').join(',')

  // intel_reports — generic base layer
  try {
    const rows = db.prepare(
      `SELECT id, title, discipline, severity, source_name, verification_score, created_at, substr(content, 1, 200) AS snippet FROM intel_reports WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>
    for (const r of rows) {
      result.set(r.id as string, {
        id: r.id,
        title: String(r.title || '').slice(0, 80),
        discipline: r.discipline,
        severity: r.severity,
        source: r.source_name,
        verification: r.verification_score,
        createdAt: r.created_at,
        snippet: r.snippet
      })
    }
  } catch {}

  // preliminary_reports — overrides intel_reports entry with preliminary type
  try {
    const rows = db.prepare(
      `SELECT id, title, status, created_at, substr(content, 1, 200) AS snippet FROM preliminary_reports WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>
    for (const r of rows) {
      result.set(r.id as string, {
        id: r.id,
        title: String(r.title || '').slice(0, 80),
        discipline: 'preliminary',
        severity: 'high',
        source: 'Preliminary Report',
        verification: 80,
        type: 'preliminary',
        createdAt: r.created_at,
        snippet: r.snippet
      })
    }
  } catch {}

  // humint_reports — overrides intel_reports entry with humint type
  try {
    const rows = db.prepare(
      `SELECT id, findings, confidence, created_at, session_id FROM humint_reports WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>
    for (const r of rows) {
      const findings = String(r.findings || '')
      result.set(r.id as string, {
        id: r.id,
        title: `HUMINT: ${findings.slice(0, 60)}`,
        discipline: 'humint',
        severity: 'high',
        source: 'HUMINT Chat',
        verification: 90,
        type: 'humint',
        createdAt: r.created_at,
        snippet: findings.slice(0, 200),
        confidence: r.confidence,
        sessionId: r.session_id
      })
    }
  } catch {}

  // intel_gaps
  try {
    const rows = db.prepare(
      `SELECT id, description, severity, created_at, preliminary_report_id FROM intel_gaps WHERE id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>
    for (const r of rows) {
      const description = String(r.description || '')
      result.set(r.id as string, {
        id: r.id,
        title: description.slice(0, 80),
        discipline: 'gap',
        severity: r.severity as string,
        source: 'Information Gap',
        verification: 0,
        type: 'gap',
        createdAt: r.created_at,
        snippet: description,
        preliminaryReportId: r.preliminary_report_id
      })
    }
  } catch {}

  return result
}

function getGraphFromSQLite(params?: {
  reportId?: string; discipline?: string; linkType?: string; limit?: number
}): { nodes: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> } {
  const db = getDatabase()
  const limit = params?.limit || 200

  // 1) Fetch links matching filter
  let linkQuery = 'SELECT source_report_id, target_report_id, link_type, strength, reason FROM intel_links'
  const conditions: string[] = []
  const vals: unknown[] = []

  if (params?.reportId) {
    conditions.push('(source_report_id = ? OR target_report_id = ?)')
    vals.push(params.reportId, params.reportId)
  }
  if (params?.linkType && params.linkType !== 'all') {
    if (params.linkType === 'humint') {
      conditions.push("link_type IN ('humint_source', 'humint_preliminary', 'humint_cross_session')")
    } else {
      conditions.push('link_type = ?')
      vals.push(params.linkType)
    }
  }
  if (conditions.length > 0) linkQuery += ` WHERE ${conditions.join(' AND ')}`
  linkQuery += ` ORDER BY strength DESC LIMIT ?`
  vals.push(limit)

  const links = db.prepare(linkQuery).all(...vals) as Array<{
    source_report_id: string; target_report_id: string; link_type: string; strength: number; reason: string
  }>

  // 2) Resolve ALL endpoints across all 4 tables (deduplicated by id)
  const endpointIds = new Set<string>()
  for (const link of links) {
    endpointIds.add(link.source_report_id)
    endpointIds.add(link.target_report_id)
  }

  const nodesById = resolveNodesById(db, Array.from(endpointIds))

  // 3) Optional discipline filter — shrinks the node set, which cascades to
  //    links (drop any link whose endpoint was filtered out).
  let finalLinks = links
  if (params?.discipline && params.discipline !== 'all') {
    const keep = new Set<string>()
    for (const [id, n] of nodesById) {
      if ((n as any).discipline === params.discipline) keep.add(id)
    }
    for (const id of Array.from(nodesById.keys())) {
      if (!keep.has(id)) nodesById.delete(id)
    }
    finalLinks = links.filter((l) => keep.has(l.source_report_id) && keep.has(l.target_report_id))
  }

  // 4) Also include recent HUMINT / preliminary / gap nodes + their gap
  //    links. These are "analyst products" — they must stay visible
  //    regardless of the link-type filter so the user always sees what they
  //    have produced. The discipline filter still applies (a cybint-only
  //    view won't pull in humint products unless humint links cybint intel).
  const showProducts = !params?.discipline || params.discipline === 'all'

  const gapSyntheticLinks: Array<{
    source: string; target: string; type: string; strength: number; reason: string
  }> = []

  if (showProducts) {
    // Recent preliminary reports not already in the set
    try {
      const rows = db.prepare(
        'SELECT id, title, status, created_at, substr(content, 1, 200) AS snippet FROM preliminary_reports ORDER BY created_at DESC LIMIT 50'
      ).all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const id = r.id as string
        if (nodesById.has(id)) continue
        nodesById.set(id, {
          id, title: String(r.title || '').slice(0, 80),
          discipline: 'preliminary', severity: 'high', source: 'Preliminary Report',
          verification: 80, type: 'preliminary',
          createdAt: r.created_at, snippet: r.snippet
        })
      }
    } catch {}

    // Recent HUMINT reports not already in the set
    try {
      const rows = db.prepare(
        'SELECT id, findings, confidence, created_at, session_id FROM humint_reports ORDER BY created_at DESC LIMIT 30'
      ).all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const id = r.id as string
        if (nodesById.has(id)) continue
        const findings = String(r.findings || '')
        nodesById.set(id, {
          id, title: `HUMINT: ${findings.slice(0, 60)}`,
          discipline: 'humint', severity: 'high', source: 'HUMINT Chat',
          verification: 90, type: 'humint',
          createdAt: r.created_at, snippet: findings.slice(0, 200),
          confidence: r.confidence, sessionId: r.session_id
        })
      }
    } catch {}

    // Recent pending actions from recommended_actions table. Each action is a
    // child of its parent preliminary_report. Same model as gaps.
    const includeActionLinks = !params?.linkType || params.linkType === 'all' || params.linkType === 'action_identified'
    try {
      const rows = db.prepare(
        "SELECT id, action, priority, preliminary_report_id, created_at FROM recommended_actions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50"
      ).all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const id = r.id as string
        const action = String(r.action || '')
        if (!nodesById.has(id)) {
          nodesById.set(id, {
            id,
            title: action.slice(0, 80),
            discipline: 'action',
            severity: r.priority === 'critical' ? 'critical' : r.priority === 'high' ? 'high' : 'medium',
            source: 'Recommended Action',
            verification: 0,
            type: 'action',
            createdAt: r.created_at,
            snippet: action,
            priority: r.priority,
            preliminaryReportId: r.preliminary_report_id
          })
        }
        if (includeActionLinks && r.preliminary_report_id) {
          if (!nodesById.has(r.preliminary_report_id as string)) {
            const prelim = resolveNodesById(db, [r.preliminary_report_id as string])
            for (const [pid, pnode] of prelim) {
              if (!nodesById.has(pid)) nodesById.set(pid, pnode)
            }
          }
          if (nodesById.has(r.preliminary_report_id as string)) {
            gapSyntheticLinks.push({
              source: r.preliminary_report_id as string,
              target: id,
              type: 'action_identified',
              strength: 0.6,
              reason: 'Recommended action from report'
            })
          }
        }
      }
    } catch {}

    // Recent open gaps — add node + (conditionally) synthesize gap→preliminary
    // link. The link is only emitted when the current linkType filter would
    // accept a 'gap_identified' edge.
    const includeGapLinks = !params?.linkType || params.linkType === 'all' || params.linkType === 'gap_identified'
    try {
      const rows = db.prepare(
        "SELECT id, description, severity, created_at, preliminary_report_id FROM intel_gaps WHERE status = 'open' ORDER BY created_at DESC LIMIT 30"
      ).all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const id = r.id as string
        const description = String(r.description || '')
        if (!nodesById.has(id)) {
          nodesById.set(id, {
            id, title: description.slice(0, 80),
            discipline: 'gap', severity: r.severity as string, source: 'Information Gap',
            verification: 0, type: 'gap',
            createdAt: r.created_at, snippet: description,
            preliminaryReportId: r.preliminary_report_id
          })
        }
        // Synthesize the preliminary→gap edge (not stored in intel_links)
        if (includeGapLinks && r.preliminary_report_id) {
          // Ensure the preliminary parent is in the node set so the edge renders
          if (!nodesById.has(r.preliminary_report_id as string)) {
            const prelim = resolveNodesById(db, [r.preliminary_report_id as string])
            for (const [pid, pnode] of prelim) {
              if (!nodesById.has(pid)) nodesById.set(pid, pnode)
            }
          }
          if (nodesById.has(r.preliminary_report_id as string)) {
            gapSyntheticLinks.push({
              source: r.preliminary_report_id as string,
              target: id,
              type: 'gap_identified',
              strength: 0.7,
              reason: 'Information gap identified in report'
            })
          }
        }
      }
    } catch {}
  }

  return {
    nodes: Array.from(nodesById.values()),
    links: [
      ...finalLinks.map((l) => ({
        source: l.source_report_id, target: l.target_report_id,
        type: l.link_type, strength: l.strength, reason: l.reason
      })),
      ...gapSyntheticLinks
    ]
  }
}

export function registerEnrichmentBridge(): void {
  ipcMain.handle('enrichment:getTags', (_event, params: { reportId: string }) => {
    return intelEnricher.getTags(params.reportId)
  })

  ipcMain.handle('enrichment:getEntities', (_event, params: { reportId: string }) => {
    return intelEnricher.getEntities(params.reportId)
  })

  ipcMain.handle('enrichment:getLinks', (_event, params: { reportId: string }) => {
    return intelEnricher.getLinks(params.reportId)
  })

  ipcMain.handle('enrichment:getTopTags', (_event, params?: { limit?: number }) => {
    return intelEnricher.getTopTags(params?.limit)
  })

  ipcMain.handle('enrichment:getTopEntities', (_event, params?: { type?: string; limit?: number }) => {
    return intelEnricher.getTopEntities(params?.type, params?.limit)
  })

  // Get enriched reports with tags, entities, links
  ipcMain.handle('enrichment:getEnrichedReports', (_event, params: {
    tag?: string; entityType?: string; corroboration?: string; limit?: number
  }) => {
    log.info(`getEnrichedReports called with: ${JSON.stringify(params)}`)
    const db = getDatabase()
    const limit = params?.limit || 50

    let query = `SELECT DISTINCT r.id, r.title, r.discipline, r.severity, r.source_name,
      r.verification_score, r.content, r.created_at, r.source_url
      FROM intel_reports r
      INNER JOIN intel_tags t ON r.id = t.report_id`
    const conditions: string[] = []
    const vals: unknown[] = []

    if (params?.tag) {
      conditions.push('t.tag = ?')
      vals.push(params.tag)
    }

    if (params?.entityType) {
      conditions.push('r.id IN (SELECT report_id FROM intel_entities WHERE entity_type = ?)')
      vals.push(params.entityType)
    }

    if (params?.corroboration) {
      conditions.push(`r.id IN (SELECT report_id FROM intel_tags WHERE tag = ?)`)
      vals.push(`corroboration:${params.corroboration}`)
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`
    query += ` ORDER BY r.created_at DESC LIMIT ?`
    vals.push(limit)

    try {
      const reports = db.prepare(query).all(...vals) as Array<Record<string, unknown>>

      return reports.map((r) => ({
        id: r.id, title: r.title, discipline: r.discipline, severity: r.severity,
        sourceName: r.source_name, verificationScore: r.verification_score,
        content: (r.content as string).slice(0, 1000), createdAt: r.created_at,
        sourceUrl: r.source_url,
        tags: intelEnricher.getTags(r.id as string),
        entities: intelEnricher.getEntities(r.id as string),
        links: intelEnricher.getLinks(r.id as string)
      }))
    } catch (err) {
      log.error(`getEnrichedReports error: ${err}`)
      return []
    }
  })

  // Get graph data for relationship visualization — Kuzu-first with SQLite fallback
  ipcMain.handle('enrichment:getGraph', async (_event, params?: {
    reportId?: string; discipline?: string; linkType?: string; limit?: number
  }) => {
    // Try Kuzu first
    if (kuzuService.isReady()) {
      try {
        const result = await kuzuService.getGraph(params)
        if (result.nodes.length > 0 || result.links.length > 0) {
          return result
        }
        // If Kuzu returned empty, fall through to SQLite (may not be synced yet)
      } catch (err) {
        log.warn(`Kuzu graph query failed, falling back to SQLite: ${err}`)
      }
    }

    // Fallback: existing SQLite implementation
    return getGraphFromSQLite(params)
  })

  log.info('Enrichment bridge registered')
}
