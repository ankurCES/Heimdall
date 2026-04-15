import { getDatabase } from '../database'
import { generateId, timestamp } from '@common/utils/id'
import { auditChainService } from '../audit/AuditChainService'
import log from 'electron-log'

/**
 * Need-to-know compartments — Theme 10.2 + 10.5 of the agency roadmap.
 *
 * Compartments are an orthogonal axis to classification. A document
 * tagged [SI, NOFORN] is visible only to actors with grants for BOTH
 * SI AND NOFORN. The tickets are arbitrary strings the analyst defines
 * — Heimdall ships no defaults because real-world codewords are
 * themselves classified.
 *
 * Visibility rule: ALL compartments must be granted. An empty
 * compartment list = universally visible (subject to classification).
 *
 * Heimdall is single-user today, so the actor defaults to 'self' on
 * both grants and visibility checks. When multi-user lands (Theme
 * 10.10), the actor will be the authenticated user id.
 */

export interface Compartment {
  id: string
  ticket: string         // short uppercase code: "SI", "TK", "NOFORN", etc.
  name: string
  description: string | null
  color: string | null
  created_at: number
  updated_at: number
}

export interface CompartmentGrant {
  id: string
  compartment_id: string
  actor: string
  granted_at: number
  granted_by: string | null
  revoked_at: number | null
  notes: string | null
}

export interface CompartmentSummary extends Compartment {
  granted: boolean
}

class CompartmentServiceImpl {
  // ---- Compartments CRUD ----

  create(input: { ticket: string; name: string; description?: string; color?: string }): Compartment {
    const db = getDatabase()
    const ticket = input.ticket.trim().toUpperCase().replace(/\s+/g, '_').slice(0, 32)
    if (!/^[A-Z][A-Z0-9_]*$/.test(ticket)) {
      throw new Error(`Invalid compartment ticket: ${ticket}. Must start with a letter, contain only A–Z 0–9 _.`)
    }
    const id = generateId()
    const now = timestamp()
    db.prepare(`
      INSERT INTO compartments (id, ticket, name, description, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ticket, input.name, input.description || null, input.color || null, now, now)

    auditChainService.append('compartment.create', {
      entityType: 'compartment', entityId: id,
      payload: { ticket, name: input.name }
    })

    return this.get(id)!
  }

  update(id: string, patch: Partial<Pick<Compartment, 'name' | 'description' | 'color'>>): Compartment {
    const db = getDatabase()
    const fields: string[] = []
    const vals: unknown[] = []
    for (const k of ['name', 'description', 'color'] as const) {
      if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(patch[k]) }
    }
    fields.push('updated_at = ?'); vals.push(timestamp())
    if (fields.length > 1) {
      db.prepare(`UPDATE compartments SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return this.get(id)!
  }

  delete(id: string): void {
    const db = getDatabase()
    const c = db.prepare('SELECT ticket, name FROM compartments WHERE id = ?').get(id) as { ticket: string; name: string } | undefined
    db.prepare('DELETE FROM compartments WHERE id = ?').run(id)
    if (c) {
      auditChainService.append('compartment.delete', {
        entityType: 'compartment', entityId: id,
        payload: { ticket: c.ticket, name: c.name }
      })
    }
  }

  get(id: string): Compartment | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM compartments WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapCompartment(row) : null
  }

  getByTicket(ticket: string): Compartment | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM compartments WHERE ticket = ?').get(ticket.toUpperCase()) as Record<string, unknown> | undefined
    return row ? this.mapCompartment(row) : null
  }

  list(): Compartment[] {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM compartments ORDER BY ticket ASC').all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapCompartment(r))
  }

  /**
   * List every compartment + whether the given actor (default: 'self')
   * currently holds an active grant for it. Drives the Settings UI and
   * the per-artifact compartment picker.
   */
  listWithGrantState(actor = 'self'): CompartmentSummary[] {
    const db = getDatabase()
    const grants = new Set(this.activeGrantedCompartments(actor))
    return this.list().map((c) => ({ ...c, granted: grants.has(c.id) }))
  }

  // ---- Grants ----

  grant(compartmentId: string, opts: { actor?: string; granted_by?: string; notes?: string } = {}): CompartmentGrant {
    const db = getDatabase()
    const actor = opts.actor || 'self'
    const now = timestamp()

    // Check if there's already an active grant — idempotent.
    const existing = db.prepare(
      'SELECT * FROM compartment_grants WHERE compartment_id = ? AND actor = ? AND revoked_at IS NULL'
    ).get(compartmentId, actor) as Record<string, unknown> | undefined
    if (existing) return this.mapGrant(existing)

    const id = generateId()
    db.prepare(`
      INSERT INTO compartment_grants (id, compartment_id, actor, granted_at, granted_by, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, compartmentId, actor, now, opts.granted_by || null, opts.notes || null)

    const c = this.get(compartmentId)
    auditChainService.append('compartment.grant', {
      entityType: 'compartment', entityId: compartmentId,
      actor,
      payload: { ticket: c?.ticket, by: opts.granted_by, notes: opts.notes }
    })

    return this.mapGrant(db.prepare('SELECT * FROM compartment_grants WHERE id = ?').get(id) as Record<string, unknown>)
  }

  revoke(compartmentId: string, actor = 'self'): void {
    const db = getDatabase()
    const now = timestamp()
    db.prepare(
      'UPDATE compartment_grants SET revoked_at = ? WHERE compartment_id = ? AND actor = ? AND revoked_at IS NULL'
    ).run(now, compartmentId, actor)

    const c = this.get(compartmentId)
    auditChainService.append('compartment.revoke', {
      entityType: 'compartment', entityId: compartmentId,
      actor,
      payload: { ticket: c?.ticket }
    })
  }

  /** Compartment IDs the actor currently holds active grants for. */
  activeGrantedCompartments(actor = 'self'): string[] {
    const db = getDatabase()
    const rows = db.prepare(
      'SELECT compartment_id FROM compartment_grants WHERE actor = ? AND revoked_at IS NULL'
    ).all(actor) as Array<{ compartment_id: string }>
    return rows.map((r) => r.compartment_id)
  }

  /**
   * Visibility predicate. Returns true if the actor holds grants for
   * EVERY compartment in `required`. Empty `required` = always visible.
   */
  isVisible(required: string[], actor = 'self'): boolean {
    if (!required || required.length === 0) return true
    const granted = new Set(this.activeGrantedCompartments(actor))
    return required.every((id) => granted.has(id))
  }

  /**
   * Set the compartments tag on an artifact. The artifactType maps to the
   * SQL table name (intel_reports, preliminary_reports, humint_reports,
   * recommended_actions, intel_gaps, chat_sessions, iw_events,
   * ach_sessions, analytics_reports, analyst_council_runs, dpb_briefings).
   *
   * Validates that every compartment ID exists. Strips duplicates.
   * Chain-logged.
   */
  setArtifactCompartments(artifactType: string, artifactId: string, compartmentIds: string[]): void {
    const ALLOWED = new Set([
      'intel_reports', 'preliminary_reports', 'humint_reports',
      'recommended_actions', 'intel_gaps', 'chat_sessions',
      'iw_events', 'ach_sessions', 'analytics_reports',
      'analyst_council_runs', 'dpb_briefings'
    ])
    if (!ALLOWED.has(artifactType)) {
      throw new Error(`Unknown artifact type: ${artifactType}`)
    }

    const db = getDatabase()
    const unique = Array.from(new Set(compartmentIds))
    if (unique.length > 0) {
      const placeholders = unique.map(() => '?').join(',')
      const found = db.prepare(`SELECT id FROM compartments WHERE id IN (${placeholders})`).all(...unique) as Array<{ id: string }>
      if (found.length !== unique.length) {
        const missing = unique.filter((id) => !found.find((r) => r.id === id))
        throw new Error(`Unknown compartment ids: ${missing.join(', ')}`)
      }
    }

    const before = db.prepare(`SELECT compartments FROM ${artifactType} WHERE id = ?`).get(artifactId) as { compartments: string } | undefined
    if (!before) throw new Error(`${artifactType} not found: ${artifactId}`)
    const beforeArr = (() => { try { return JSON.parse(before.compartments || '[]') as string[] } catch { return [] } })()

    const json = JSON.stringify(unique)
    db.prepare(`UPDATE ${artifactType} SET compartments = ? WHERE id = ?`).run(json, artifactId)

    auditChainService.append('compartment.tag', {
      entityType: artifactType, entityId: artifactId,
      payload: { from: beforeArr, to: unique }
    })
  }

  /** Read the compartment ids currently tagged on an artifact. */
  getArtifactCompartments(artifactType: string, artifactId: string): string[] {
    const db = getDatabase()
    const row = db.prepare(`SELECT compartments FROM ${artifactType} WHERE id = ?`).get(artifactId) as { compartments: string } | undefined
    if (!row) return []
    try { return JSON.parse(row.compartments || '[]') } catch { return [] }
  }

  // ---- Internal ----

  private mapCompartment(row: Record<string, unknown>): Compartment {
    return {
      id: row.id as string,
      ticket: row.ticket as string,
      name: row.name as string,
      description: (row.description as string) || null,
      color: (row.color as string) || null,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number
    }
  }

  private mapGrant(row: Record<string, unknown>): CompartmentGrant {
    return {
      id: row.id as string,
      compartment_id: row.compartment_id as string,
      actor: row.actor as string,
      granted_at: row.granted_at as number,
      granted_by: (row.granted_by as string) || null,
      revoked_at: (row.revoked_at as number) || null,
      notes: (row.notes as string) || null
    }
  }
}

export const compartmentService = new CompartmentServiceImpl()
log.debug('CompartmentService initialized')
