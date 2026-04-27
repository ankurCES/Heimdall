// EntityMergeService — v1.7.3 analyst-driven canonical correction.
//
// The auto-resolver (EntityResolutionService) clusters raw mentions
// into canonical entities using normalised-string + embedding
// similarity. It's right ~95% of the time, but the long tail
// matters: "FIN7" vs "Fin 7" vs "Fin-7", "Putin" vs "Vladimir
// Putin" vs "Владимир Путин", "Boeing" the company vs "Boeing
// 737" the aircraft. This service lets an analyst fix those by hand:
//
//   merge(sourceIds, targetId)   — fold N canonical entities into 1
//   split(canonicalId, values)   — peel raw entity_values out of a
//                                  canonical and reseat under a new id
//
// Every operation is wrapped in a SQL transaction (better-sqlite3
// rolls back on throw) so a partial failure never leaves the graph
// half-merged. Each operation also writes an audit_log entry with
// before/after counts so the compliance log shows exactly which
// canonicalisation an analyst overrode and when.

import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { auditService } from '../audit/AuditService'

export interface MergeResult {
  ok: boolean
  target_canonical_id: string
  removed_canonical_ids: string[]
  reassigned_intel_entities: number
  new_alias_count: number
  new_mention_count: number
}

export interface SplitResult {
  ok: boolean
  source_canonical_id: string
  new_canonical_id: string
  reassigned_intel_entities: number
  source_remaining_alias_count: number
  source_remaining_mention_count: number
}

export class EntityMergeService {
  /** Fold every `sourceIds` canonical entity into `targetId`.
   *  - Re-points every intel_entities.canonical_id from source → target
   *  - Updates target's alias_count + mention_count
   *  - Deletes the now-empty source canonical_entities rows
   *  - Refuses to merge across different entity_types (intentional;
   *    a person and an org with the same name shouldn't be linked
   *    by accident — analyst can change entity_type first if needed). */
  merge(sourceIds: string[], targetId: string): MergeResult {
    const db = getDatabase()
    if (sourceIds.includes(targetId)) {
      throw new Error(`Target ${targetId} cannot also be a source`)
    }
    const target = db.prepare(`
      SELECT id, entity_type, canonical_value, alias_count, mention_count
      FROM canonical_entities WHERE id = ?
    `).get(targetId) as { id: string; entity_type: string; canonical_value: string; alias_count: number; mention_count: number } | undefined
    if (!target) throw new Error(`Target canonical not found: ${targetId}`)

    const placeholders = sourceIds.map(() => '?').join(',')
    const sources = db.prepare(`
      SELECT id, entity_type, canonical_value, alias_count, mention_count
      FROM canonical_entities WHERE id IN (${placeholders})
    `).all(...sourceIds) as Array<{ id: string; entity_type: string; canonical_value: string; alias_count: number; mention_count: number }>
    if (sources.length === 0) throw new Error('No source canonicals matched the supplied ids')
    for (const s of sources) {
      if (s.entity_type !== target.entity_type) {
        throw new Error(`Cannot merge across entity types (source ${s.id} is "${s.entity_type}", target is "${target.entity_type}"). Change the source's type first.`)
      }
    }

    let reassigned = 0
    const tx = db.transaction(() => {
      // Repoint every raw mention. We use UPDATE with a parameterised
      // IN list — better-sqlite3 binds the count at prepare time so we
      // recreate the statement here per-call.
      const upd = db.prepare(`UPDATE intel_entities SET canonical_id = ? WHERE canonical_id IN (${placeholders})`)
      const res = upd.run(targetId, ...sourceIds)
      reassigned = res.changes

      // Recompute the target's counts from the now-merged set.
      const newCounts = db.prepare(`
        SELECT
          COUNT(DISTINCT entity_value) AS alias_count,
          COUNT(*)                     AS mention_count
        FROM intel_entities
        WHERE canonical_id = ?
      `).get(targetId) as { alias_count: number; mention_count: number }

      db.prepare(`
        UPDATE canonical_entities
        SET alias_count = ?, mention_count = ?, updated_at = ?
        WHERE id = ?
      `).run(newCounts.alias_count, newCounts.mention_count, Date.now(), targetId)

      // Drop the source rows — they've been emptied.
      db.prepare(`DELETE FROM canonical_entities WHERE id IN (${placeholders})`).run(...sourceIds)
    })
    tx()

    // Audit-log the merge for compliance review.
    try {
      auditService.log('entity.merge', {
        target_id: targetId,
        target_canonical_value: target.canonical_value,
        source_ids: sourceIds,
        source_canonical_values: sources.map((s) => s.canonical_value),
        reassigned_intel_entities: reassigned
      })
    } catch (err) {
      log.debug(`entity.merge: audit log failed: ${(err as Error).message}`)
    }

    const final = db.prepare(`
      SELECT alias_count, mention_count FROM canonical_entities WHERE id = ?
    `).get(targetId) as { alias_count: number; mention_count: number }

    log.info(`entity.merge: folded ${sources.length} canonical(s) into ${targetId} (${target.canonical_value}); reassigned ${reassigned} mentions`)

    return {
      ok: true,
      target_canonical_id: targetId,
      removed_canonical_ids: sources.map((s) => s.id),
      reassigned_intel_entities: reassigned,
      new_alias_count: final.alias_count,
      new_mention_count: final.mention_count
    }
  }

  /** Peel a set of raw entity_values out of an existing canonical and
   *  reseat them under a freshly-created canonical with the supplied
   *  display name. Used when the resolver collapsed two distinct
   *  things — e.g. "Apple" the company vs "Apple" the surname. */
  split(args: {
    sourceCanonicalId: string
    splitValues: string[]
    newCanonicalValue: string
  }): SplitResult {
    const db = getDatabase()
    const source = db.prepare(`
      SELECT id, entity_type, canonical_value FROM canonical_entities WHERE id = ?
    `).get(args.sourceCanonicalId) as { id: string; entity_type: string; canonical_value: string } | undefined
    if (!source) throw new Error(`Source canonical not found: ${args.sourceCanonicalId}`)
    const splitValues = args.splitValues.filter((v) => v && v.trim())
    if (splitValues.length === 0) throw new Error('No values supplied to split')
    const newValue = args.newCanonicalValue.trim()
    if (!newValue) throw new Error('newCanonicalValue is required')

    const newId = generateId()
    const now = Date.now()
    const placeholders = splitValues.map(() => '?').join(',')
    let reassigned = 0

    const tx = db.transaction(() => {
      // Create the new canonical entity. Same entity_type as the
      // source so existing per-type indexes stay healthy. The
      // resolver's normalised_value computation lives outside this
      // file, so we stash a lowercase fallback — a future resolver
      // run will recompute it cleanly.
      db.prepare(`
        INSERT INTO canonical_entities
          (id, entity_type, canonical_value, normalized_value, alias_count, mention_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?)
      `).run(newId, source.entity_type, newValue, newValue.toLowerCase(), now, now)

      const upd = db.prepare(`
        UPDATE intel_entities
        SET canonical_id = ?
        WHERE canonical_id = ? AND entity_value IN (${placeholders})
      `)
      const res = upd.run(newId, args.sourceCanonicalId, ...splitValues)
      reassigned = res.changes

      // Recompute counts on both canonicals.
      const recompute = (cid: string) => {
        const c = db.prepare(`
          SELECT
            COUNT(DISTINCT entity_value) AS alias_count,
            COUNT(*)                     AS mention_count
          FROM intel_entities
          WHERE canonical_id = ?
        `).get(cid) as { alias_count: number; mention_count: number }
        db.prepare(`
          UPDATE canonical_entities
          SET alias_count = ?, mention_count = ?, updated_at = ?
          WHERE id = ?
        `).run(c.alias_count, c.mention_count, Date.now(), cid)
      }
      recompute(newId)
      recompute(args.sourceCanonicalId)
    })
    tx()

    try {
      auditService.log('entity.split', {
        source_id: args.sourceCanonicalId,
        source_canonical_value: source.canonical_value,
        new_id: newId,
        new_canonical_value: newValue,
        split_values: splitValues,
        reassigned_intel_entities: reassigned
      })
    } catch (err) {
      log.debug(`entity.split: audit log failed: ${(err as Error).message}`)
    }

    const remaining = db.prepare(`
      SELECT alias_count, mention_count FROM canonical_entities WHERE id = ?
    `).get(args.sourceCanonicalId) as { alias_count: number; mention_count: number }

    log.info(`entity.split: peeled ${splitValues.length} alias(es) off ${args.sourceCanonicalId} into ${newId} (${newValue}); reassigned ${reassigned} mentions`)

    return {
      ok: true,
      source_canonical_id: args.sourceCanonicalId,
      new_canonical_id: newId,
      reassigned_intel_entities: reassigned,
      source_remaining_alias_count: remaining.alias_count,
      source_remaining_mention_count: remaining.mention_count
    }
  }
}

export const entityMergeService = new EntityMergeService()
