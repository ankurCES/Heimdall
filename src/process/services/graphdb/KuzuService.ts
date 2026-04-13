import kuzu from 'kuzu'
import { app } from 'electron'
import path from 'path'
import { mkdirSync, existsSync, rmSync } from 'fs'
import log from 'electron-log'

// Kuzu Node/Rel value types for query results
interface KuzuNodeValue {
  _label: string | null
  _id: { offset: number; table: number } | null
  [key: string]: unknown
}

interface KuzuRelValue {
  _src: { offset: number; table: number } | null
  _dst: { offset: number; table: number } | null
  _label: string | null
  [key: string]: unknown
}

// Graph result matching existing frontend contract
interface GraphNode {
  id: string
  title: string
  discipline: string
  severity: string
  source: string
  verification: number
  type?: string
}

interface GraphLink {
  source: string
  target: string
  type: string
  strength: number
  reason: string
}

interface GraphResult {
  nodes: GraphNode[]
  links: GraphLink[]
}

// Map link_type strings to Kuzu REL TABLE names
const LINK_TYPE_MAP: Record<string, { rel: string; fromTable: string; toTable: string }> = {
  shared_entity: { rel: 'SHARED_ENTITY', fromTable: 'IntelReport', toTable: 'IntelReport' },
  temporal: { rel: 'TEMPORAL', fromTable: 'IntelReport', toTable: 'IntelReport' },
  preliminary_reference: { rel: 'PRELIM_REFERENCE', fromTable: 'PreliminaryReport', toTable: 'IntelReport' },
  gap_identified: { rel: 'GAP_IDENTIFIED', fromTable: 'PreliminaryReport', toTable: 'IntelGap' },
  humint_source: { rel: 'HUMINT_SOURCE', fromTable: 'HumintReport', toTable: 'IntelReport' },
  humint_preliminary: { rel: 'HUMINT_PRELIM', fromTable: 'HumintReport', toTable: 'PreliminaryReport' },
  humint_cross_session: { rel: 'HUMINT_CROSS_SESSION', fromTable: 'HumintReport', toTable: 'HumintReport' }
}

// Reverse map: REL name → link_type string
const REL_TO_LINK_TYPE: Record<string, string> = {}
for (const [lt, cfg] of Object.entries(LINK_TYPE_MAP)) {
  REL_TO_LINK_TYPE[cfg.rel] = lt
}

class KuzuService {
  private database: kuzu.Database | null = null
  private connection: kuzu.Connection | null = null
  private initialized = false
  private dbPath: string = ''

  async initialize(): Promise<void> {
    try {
      this.dbPath = path.join(app.getPath('userData'), 'heimdall-graph')
      if (!existsSync(this.dbPath)) {
        mkdirSync(this.dbPath, { recursive: true })
      }

      this.database = new kuzu.Database(this.dbPath)
      await this.database.init()

      this.connection = new kuzu.Connection(this.database)
      await this.connection.init()

      await this.createSchema()
      this.initialized = true
      log.info(`Kuzu graph database initialized at ${this.dbPath}`)
    } catch (err) {
      log.error(`Kuzu initialization failed: ${err}`)
      this.initialized = false
    }
  }

  isReady(): boolean {
    return this.initialized && this.connection !== null
  }

  private async createSchema(): Promise<void> {
    if (!this.connection) return

    const nodeTables = [
      'CREATE NODE TABLE IF NOT EXISTS IntelReport (id STRING, title STRING, discipline STRING, severity STRING, source_name STRING, verification_score INT64, created_at INT64, PRIMARY KEY(id))',
      'CREATE NODE TABLE IF NOT EXISTS PreliminaryReport (id STRING, title STRING, status STRING, created_at INT64, PRIMARY KEY(id))',
      'CREATE NODE TABLE IF NOT EXISTS HumintReport (id STRING, title STRING, confidence STRING, created_at INT64, PRIMARY KEY(id))',
      'CREATE NODE TABLE IF NOT EXISTS IntelGap (id STRING, description STRING, category STRING, severity STRING, PRIMARY KEY(id))',
      'CREATE NODE TABLE IF NOT EXISTS Entity (id STRING, type STRING, value STRING, PRIMARY KEY(id))',
      'CREATE NODE TABLE IF NOT EXISTS Tag (name STRING, PRIMARY KEY(name))'
    ]

    const relTables = [
      'CREATE REL TABLE IF NOT EXISTS SHARED_ENTITY (FROM IntelReport TO IntelReport, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS TEMPORAL (FROM IntelReport TO IntelReport, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS PRELIM_REFERENCE (FROM PreliminaryReport TO IntelReport, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS GAP_IDENTIFIED (FROM PreliminaryReport TO IntelGap, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS HUMINT_SOURCE (FROM HumintReport TO IntelReport, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS HUMINT_PRELIM (FROM HumintReport TO PreliminaryReport, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS HUMINT_CROSS_SESSION (FROM HumintReport TO HumintReport, strength DOUBLE)',
      'CREATE REL TABLE IF NOT EXISTS HAS_ENTITY (FROM IntelReport TO Entity)',
      'CREATE REL TABLE IF NOT EXISTS HAS_TAG (FROM IntelReport TO Tag, confidence DOUBLE)'
    ]

    for (const ddl of [...nodeTables, ...relTables]) {
      try {
        await this.connection.query(ddl)
      } catch (err) {
        // "already exists" is expected on re-init
        const msg = String(err)
        if (!msg.includes('already exists')) {
          log.debug(`Kuzu DDL note: ${msg.slice(0, 100)}`)
        }
      }
    }
  }

  // ── Node Upserts ─────────────────────────────────────────────────

  async upsertIntelReport(r: {
    id: string; title: string; discipline: string; severity: string
    source: string; verification: number; created_at: number
  }): Promise<void> {
    if (!this.connection) return
    const ps = await this.connection.prepare(
      `MERGE (n:IntelReport {id: $id})
       SET n.title = $title, n.discipline = $discipline, n.severity = $severity,
           n.source_name = $source, n.verification_score = $verification, n.created_at = $created_at`
    )
    await this.connection.execute(ps, {
      id: r.id, title: r.title.slice(0, 200), discipline: r.discipline,
      severity: r.severity, source: r.source, verification: BigInt(r.verification),
      created_at: BigInt(r.created_at)
    })
  }

  async upsertPreliminaryReport(r: {
    id: string; title: string; status: string; created_at: number
  }): Promise<void> {
    if (!this.connection) return
    const ps = await this.connection.prepare(
      `MERGE (n:PreliminaryReport {id: $id})
       SET n.title = $title, n.status = $status, n.created_at = $created_at`
    )
    await this.connection.execute(ps, {
      id: r.id, title: r.title.slice(0, 200), status: r.status,
      created_at: BigInt(r.created_at)
    })
  }

  async upsertHumintReport(r: {
    id: string; title: string; confidence: string; created_at: number
  }): Promise<void> {
    if (!this.connection) return
    const ps = await this.connection.prepare(
      `MERGE (n:HumintReport {id: $id})
       SET n.title = $title, n.confidence = $confidence, n.created_at = $created_at`
    )
    await this.connection.execute(ps, {
      id: r.id, title: r.title.slice(0, 200), confidence: r.confidence,
      created_at: BigInt(r.created_at)
    })
  }

  async upsertIntelGap(g: {
    id: string; description: string; category: string | null; severity: string
  }): Promise<void> {
    if (!this.connection) return
    const ps = await this.connection.prepare(
      `MERGE (n:IntelGap {id: $id})
       SET n.description = $description, n.category = $category, n.severity = $severity`
    )
    await this.connection.execute(ps, {
      id: g.id, description: g.description.slice(0, 500),
      category: g.category || 'unknown', severity: g.severity
    })
  }

  async upsertEntity(e: { id: string; type: string; value: string }): Promise<void> {
    if (!this.connection) return
    const ps = await this.connection.prepare(
      `MERGE (n:Entity {id: $id}) SET n.type = $type, n.value = $value`
    )
    await this.connection.execute(ps, { id: e.id, type: e.type, value: e.value.slice(0, 500) })
  }

  async upsertTag(name: string): Promise<void> {
    if (!this.connection) return
    const ps = await this.connection.prepare(`MERGE (n:Tag {name: $name})`)
    await this.connection.execute(ps, { name })
  }

  // ── Relationship Creates ─────────────────────────────────────────

  async createLink(
    sourceId: string, targetId: string, linkType: string,
    strength: number, _fromTable?: string, _toTable?: string
  ): Promise<void> {
    if (!this.connection) return
    const mapping = LINK_TYPE_MAP[linkType]
    if (!mapping) {
      log.debug(`Unknown link type for Kuzu: ${linkType}`)
      return
    }

    try {
      const cypher = `MATCH (a:${mapping.fromTable} {id: $src}), (b:${mapping.toTable} {id: $tgt})
                       MERGE (a)-[r:${mapping.rel}]->(b) SET r.strength = $str`
      const ps = await this.connection.prepare(cypher)
      await this.connection.execute(ps, { src: sourceId, tgt: targetId, str: strength })
    } catch (err) {
      log.debug(`Kuzu createLink failed (${linkType}): ${String(err).slice(0, 100)}`)
    }
  }

  async createHasEntity(reportId: string, entityId: string): Promise<void> {
    if (!this.connection) return
    try {
      const ps = await this.connection.prepare(
        `MATCH (r:IntelReport {id: $rid}), (e:Entity {id: $eid})
         MERGE (r)-[:HAS_ENTITY]->(e)`
      )
      await this.connection.execute(ps, { rid: reportId, eid: entityId })
    } catch {}
  }

  async createHasTag(reportId: string, tagName: string, confidence: number): Promise<void> {
    if (!this.connection) return
    try {
      const ps = await this.connection.prepare(
        `MATCH (r:IntelReport {id: $rid}), (t:Tag {name: $tag})
         MERGE (r)-[rel:HAS_TAG]->(t) SET rel.confidence = $conf`
      )
      await this.connection.execute(ps, { rid: reportId, tag: tagName, conf: confidence })
    } catch {}
  }

  // ── Graph Queries ────────────────────────────────────────────────

  async getGraph(params?: {
    reportId?: string; discipline?: string; linkType?: string; limit?: number
  }): Promise<GraphResult> {
    if (!this.connection) return { nodes: [], links: [] }

    const limit = params?.limit || 200
    const nodes = new Map<string, GraphNode>()
    const links: GraphLink[] = []

    // Query intel report links
    const relTypes = params?.linkType && params.linkType !== 'all'
      ? [LINK_TYPE_MAP[params.linkType]?.rel].filter(Boolean) as string[]
      : Object.values(LINK_TYPE_MAP).map((m) => m.rel)

    // For IntelReport-to-IntelReport relations
    const rrTypes = relTypes.filter((r) => ['SHARED_ENTITY', 'TEMPORAL'].includes(r))
    if (rrTypes.length > 0) {
      for (const relType of rrTypes) {
        let cypher: string
        if (params?.reportId) {
          cypher = `MATCH (a:IntelReport)-[r:${relType}]->(b:IntelReport)
                    WHERE a.id = '${params.reportId}' OR b.id = '${params.reportId}'
                    RETURN a.id AS src_id, a.title AS src_title, a.discipline AS src_disc, a.severity AS src_sev, a.source_name AS src_source, a.verification_score AS src_ver,
                           b.id AS tgt_id, b.title AS tgt_title, b.discipline AS tgt_disc, b.severity AS tgt_sev, b.source_name AS tgt_source, b.verification_score AS tgt_ver,
                           r.strength AS strength
                    LIMIT ${limit}`
        } else {
          cypher = `MATCH (a:IntelReport)-[r:${relType}]->(b:IntelReport)
                    ${params?.discipline && params.discipline !== 'all' ? `WHERE a.discipline = '${params.discipline}' AND b.discipline = '${params.discipline}'` : ''}
                    RETURN a.id AS src_id, a.title AS src_title, a.discipline AS src_disc, a.severity AS src_sev, a.source_name AS src_source, a.verification_score AS src_ver,
                           b.id AS tgt_id, b.title AS tgt_title, b.discipline AS tgt_disc, b.severity AS tgt_sev, b.source_name AS tgt_source, b.verification_score AS tgt_ver,
                           r.strength AS strength
                    LIMIT ${limit}`
        }

        try {
          const result = await this.connection.query(cypher) as kuzu.QueryResult
          const rows = await result.getAll()
          for (const row of rows) {
            const srcId = row.src_id as string
            const tgtId = row.tgt_id as string

            if (!nodes.has(srcId)) {
              nodes.set(srcId, {
                id: srcId, title: (row.src_title as string || '').slice(0, 50),
                discipline: row.src_disc as string, severity: row.src_sev as string,
                source: row.src_source as string, verification: Number(row.src_ver || 50)
              })
            }
            if (!nodes.has(tgtId)) {
              nodes.set(tgtId, {
                id: tgtId, title: (row.tgt_title as string || '').slice(0, 50),
                discipline: row.tgt_disc as string, severity: row.tgt_sev as string,
                source: row.tgt_source as string, verification: Number(row.tgt_ver || 50)
              })
            }

            links.push({
              source: srcId, target: tgtId,
              type: REL_TO_LINK_TYPE[relType] || relType.toLowerCase(),
              strength: Number(row.strength || 0.5),
              reason: `${relType.replace(/_/g, ' ')}`
            })
          }
        } catch (err) {
          log.debug(`Kuzu query error (${relType}): ${err}`)
        }
      }
    }

    // Also fetch preliminary, HUMINT, and gap nodes if no specific link type filter
    if (!params?.linkType || params.linkType === 'all') {
      await this.fetchCrossTypeLinks(nodes, links, limit, params?.reportId)
    }

    return { nodes: Array.from(nodes.values()), links }
  }

  private async fetchCrossTypeLinks(
    nodes: Map<string, GraphNode>, links: GraphLink[],
    limit: number, reportId?: string
  ): Promise<void> {
    if (!this.connection) return

    // Preliminary → IntelReport links
    try {
      const result = await this.connection.query(
        `MATCH (p:PreliminaryReport)-[r:PRELIM_REFERENCE]->(i:IntelReport)
         RETURN p.id AS pid, p.title AS ptitle, i.id AS iid, i.title AS ititle,
                i.discipline AS idisc, i.severity AS isev, i.source_name AS isrc,
                i.verification_score AS iver, r.strength AS str
         LIMIT ${limit}`
      ) as kuzu.QueryResult
      for (const row of await result.getAll()) {
        const pid = row.pid as string
        const iid = row.iid as string
        if (!nodes.has(pid)) {
          nodes.set(pid, {
            id: pid, title: `\u{1F4CB} ${(row.ptitle as string || '').slice(0, 40)}`,
            discipline: 'preliminary', severity: 'high', source: 'Preliminary Report',
            verification: 80, type: 'preliminary'
          })
        }
        if (!nodes.has(iid)) {
          nodes.set(iid, {
            id: iid, title: (row.ititle as string || '').slice(0, 50),
            discipline: row.idisc as string, severity: row.isev as string,
            source: row.isrc as string, verification: Number(row.iver || 50)
          })
        }
        links.push({
          source: pid, target: iid, type: 'preliminary_reference',
          strength: Number(row.str || 0.8), reason: 'Preliminary report reference'
        })
      }
    } catch (err) {
      log.debug(`Kuzu prelim links error: ${err}`)
    }

    // HUMINT → IntelReport links
    try {
      const result = await this.connection.query(
        `MATCH (h:HumintReport)-[r:HUMINT_SOURCE]->(i:IntelReport)
         RETURN h.id AS hid, h.title AS htitle, h.confidence AS hconf,
                i.id AS iid, i.title AS ititle, i.discipline AS idisc,
                i.severity AS isev, i.source_name AS isrc, i.verification_score AS iver,
                r.strength AS str
         LIMIT ${limit}`
      ) as kuzu.QueryResult
      for (const row of await result.getAll()) {
        const hid = row.hid as string
        const iid = row.iid as string
        if (!nodes.has(hid)) {
          nodes.set(hid, {
            id: hid, title: `\u{1F530} ${(row.htitle as string || '').slice(0, 35)}`,
            discipline: 'humint', severity: 'high', source: 'HUMINT',
            verification: 90, type: 'humint'
          })
        }
        if (!nodes.has(iid)) {
          nodes.set(iid, {
            id: iid, title: (row.ititle as string || '').slice(0, 50),
            discipline: row.idisc as string, severity: row.isev as string,
            source: row.isrc as string, verification: Number(row.iver || 50)
          })
        }
        links.push({
          source: hid, target: iid, type: 'humint_source',
          strength: Number(row.str || 0.85), reason: 'HUMINT source intel'
        })
      }
    } catch (err) {
      log.debug(`Kuzu HUMINT links error: ${err}`)
    }

    // Gap links
    try {
      const result = await this.connection.query(
        `MATCH (p:PreliminaryReport)-[r:GAP_IDENTIFIED]->(g:IntelGap)
         RETURN p.id AS pid, g.id AS gid, g.description AS gdesc,
                g.severity AS gsev, r.strength AS str
         LIMIT ${limit}`
      ) as kuzu.QueryResult
      for (const row of await result.getAll()) {
        const pid = row.pid as string
        const gid = row.gid as string
        if (!nodes.has(gid)) {
          nodes.set(gid, {
            id: gid, title: `\u{26A0}\u{FE0F} ${(row.gdesc as string || '').slice(0, 40)}`,
            discipline: 'gap', severity: row.gsev as string, source: 'Information Gap',
            verification: 0, type: 'gap'
          })
        }
        links.push({
          source: pid, target: gid, type: 'gap_identified',
          strength: Number(row.str || 0.7), reason: 'Information gap identified'
        })
      }
    } catch (err) {
      log.debug(`Kuzu gap links error: ${err}`)
    }
  }

  // ── Advanced Graph Queries ───────────────────────────────────────

  async getNeighbors(reportId: string, hops: number = 2): Promise<GraphResult> {
    if (!this.connection) return { nodes: [], links: [] }

    const nodes = new Map<string, GraphNode>()
    const links: GraphLink[] = []

    try {
      // Use recursive relationship for multi-hop
      const result = await this.connection.query(
        `MATCH (center:IntelReport {id: '${reportId}'})-[r:SHARED_ENTITY|TEMPORAL*1..${hops}]-(neighbor:IntelReport)
         RETURN DISTINCT neighbor.id AS nid, neighbor.title AS ntitle, neighbor.discipline AS ndisc,
                neighbor.severity AS nsev, neighbor.source_name AS nsrc, neighbor.verification_score AS nver
         LIMIT 50`
      ) as kuzu.QueryResult

      const rows = await result.getAll()
      // Add center node
      nodes.set(reportId, {
        id: reportId, title: 'Center', discipline: '', severity: '',
        source: '', verification: 0
      })

      for (const row of rows) {
        const nid = row.nid as string
        nodes.set(nid, {
          id: nid, title: (row.ntitle as string || '').slice(0, 50),
          discipline: row.ndisc as string, severity: row.nsev as string,
          source: row.nsrc as string, verification: Number(row.nver || 50)
        })
      }

      // Get all links between these nodes
      const nodeIds = Array.from(nodes.keys())
      for (const relType of ['SHARED_ENTITY', 'TEMPORAL']) {
        const linkResult = await this.connection.query(
          `MATCH (a:IntelReport)-[r:${relType}]->(b:IntelReport)
           WHERE a.id IN [${nodeIds.map((id) => `'${id}'`).join(',')}]
             AND b.id IN [${nodeIds.map((id) => `'${id}'`).join(',')}]
           RETURN a.id AS src, b.id AS tgt, r.strength AS str`
        ) as kuzu.QueryResult

        for (const row of await linkResult.getAll()) {
          links.push({
            source: row.src as string, target: row.tgt as string,
            type: REL_TO_LINK_TYPE[relType] || relType.toLowerCase(),
            strength: Number(row.str || 0.5), reason: relType.replace(/_/g, ' ')
          })
        }
      }
    } catch (err) {
      log.debug(`Kuzu neighbors error: ${err}`)
    }

    return { nodes: Array.from(nodes.values()), links }
  }

  async getShortestPath(fromId: string, toId: string): Promise<GraphResult> {
    if (!this.connection) return { nodes: [], links: [] }

    const nodes = new Map<string, GraphNode>()
    const links: GraphLink[] = []

    try {
      const result = await this.connection.query(
        `MATCH p = shortestPath((a:IntelReport {id: '${fromId}'})-[r:SHARED_ENTITY|TEMPORAL*1..10]-(b:IntelReport {id: '${toId}'}))
         RETURN nodes(p) AS path_nodes, rels(p) AS path_rels`
      ) as kuzu.QueryResult

      const rows = await result.getAll()
      for (const row of rows) {
        const pathNodes = row.path_nodes as KuzuNodeValue[] || []
        const pathRels = row.path_rels as KuzuRelValue[] || []

        for (const n of pathNodes) {
          if (n && n.id) {
            nodes.set(n.id as string, {
              id: n.id as string, title: (n.title as string || '').slice(0, 50),
              discipline: n.discipline as string || '', severity: n.severity as string || '',
              source: n.source_name as string || '', verification: Number(n.verification_score || 50)
            })
          }
        }

        for (const r of pathRels) {
          if (r && r._src && r._dst) {
            links.push({
              source: '', target: '', // Filled from node IDs
              type: REL_TO_LINK_TYPE[r._label || ''] || 'shared_entity',
              strength: Number(r.strength || 0.5),
              reason: `Path segment: ${r._label}`
            })
          }
        }
      }
    } catch (err) {
      log.debug(`Kuzu shortest path error: ${err}`)
    }

    return { nodes: Array.from(nodes.values()), links }
  }

  async getPatternMatch(entityType: string, entityValue: string): Promise<GraphResult> {
    if (!this.connection) return { nodes: [], links: [] }

    const nodes = new Map<string, GraphNode>()
    const links: GraphLink[] = []

    try {
      const entityId = `${entityType}:${entityValue.toLowerCase()}`
      const result = await this.connection.query(
        `MATCH (r:IntelReport)-[:HAS_ENTITY]->(e:Entity {id: '${entityId}'})
         RETURN r.id AS rid, r.title AS rtitle, r.discipline AS rdisc,
                r.severity AS rsev, r.source_name AS rsrc, r.verification_score AS rver
         LIMIT 50`
      ) as kuzu.QueryResult

      const rows = await result.getAll()
      for (const row of rows) {
        const rid = row.rid as string
        nodes.set(rid, {
          id: rid, title: (row.rtitle as string || '').slice(0, 50),
          discipline: row.rdisc as string, severity: row.rsev as string,
          source: row.rsrc as string, verification: Number(row.rver || 50)
        })
      }

      // Entity center node
      nodes.set(entityId, {
        id: entityId, title: `${entityType}: ${entityValue}`,
        discipline: 'entity', severity: 'info', source: 'Entity',
        verification: 100, type: 'entity'
      })

      // Links from reports to entity
      for (const rid of nodes.keys()) {
        if (rid !== entityId) {
          links.push({
            source: rid, target: entityId, type: 'has_entity',
            strength: 0.8, reason: `Has entity: ${entityValue}`
          })
        }
      }
    } catch (err) {
      log.debug(`Kuzu pattern match error: ${err}`)
    }

    return { nodes: Array.from(nodes.values()), links }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async rebuild(): Promise<void> {
    await this.close()
    if (existsSync(this.dbPath)) {
      rmSync(this.dbPath, { recursive: true, force: true })
      log.info('Kuzu database deleted for rebuild')
    }
    await this.initialize()
  }

  async close(): Promise<void> {
    try {
      if (this.connection) {
        await this.connection.close()
        this.connection = null
      }
      if (this.database) {
        await this.database.close()
        this.database = null
      }
      this.initialized = false
      log.info('Kuzu graph database closed')
    } catch (err) {
      log.debug(`Kuzu close error: ${err}`)
    }
  }
}

export const kuzuService = new KuzuService()
