// AuditChainAnchorService — periodically signs the head of the existing
// audit_log_chained chain (maintained by AuditChainService) and stores
// the signed head as an "anchor" row in audit_chain_anchors.
//
// Anchors give third-party verifiers a fixed point of reference: any
// claim about the chain's history before an anchor's recorded_at must
// match the signed chain head. Tampering with the chain breaks all
// subsequent anchors' verification.
//
// Anchors are created:
//   - hourly via cron (background)
//   - on-demand via IPC (manual signing for export)
//
// Each anchor is signed with the SAME Ed25519 key used by SignatureService,
// so consumers verify both PDF reports AND audit anchors with one key.

import { getDatabase } from '../database'
import { generateId } from '@common/utils/id'
import { signFile, getPublicKeyInfo } from '../report/SignatureService'
import { createHash } from 'crypto'
import log from 'electron-log'

export interface AuditAnchor {
  id: string
  headSeq: number
  headHash: string
  signatureB64: string
  publicKeyB64: string
  fingerprint: string
  anchoredAt: number
}

interface ChainHeadRow {
  sequence: number
  this_hash: string
}

export class AuditChainAnchorService {
  private timer: NodeJS.Timeout | null = null

  /** Start hourly background anchoring. */
  start(intervalMs: number = 60 * 60 * 1000): void {
    if (this.timer) return
    log.info(`AuditChainAnchor: started (interval ${intervalMs}ms)`)
    setTimeout(() => this.createAnchor().catch((e) => log.warn(`anchor initial: ${e}`)), 60_000)
    this.timer = setInterval(
      () => this.createAnchor().catch((e) => log.warn(`anchor: ${e}`)),
      intervalMs
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Sign the current chain head + persist to audit_chain_anchors.
   * No-op if the chain hasn't grown since the last anchor.
   */
  async createAnchor(): Promise<AuditAnchor | null> {
    const db = getDatabase()

    // Read chain head from the existing audit_log_chained table
    let head: ChainHeadRow | undefined
    try {
      head = db.prepare(`
        SELECT sequence, this_hash FROM audit_log_chained
        ORDER BY sequence DESC LIMIT 1
      `).get() as ChainHeadRow | undefined
    } catch {
      log.debug('AuditChainAnchor: audit_log_chained not present yet')
      return null
    }
    if (!head) {
      log.debug('AuditChainAnchor: chain is empty, skipping anchor')
      return null
    }

    // Skip if we already have an anchor at this exact head
    const last = db.prepare(`
      SELECT head_seq AS headSeq, head_hash AS headHash
      FROM audit_chain_anchors
      ORDER BY anchored_at DESC LIMIT 1
    `).get() as { headSeq: number; headHash: string } | undefined
    if (last && last.headSeq === head.sequence && last.headHash === head.this_hash) {
      return null
    }

    // Sign the head hash. We sign a canonical representation:
    // SHA256("audit-chain-anchor:v1\n" + headSeq + "\n" + headHash + "\n" + timestamp)
    const ts = Date.now()
    const canonical = `audit-chain-anchor:v1\n${head.sequence}\n${head.this_hash}\n${ts}`
    const canonicalBytes = new Uint8Array(Buffer.from(canonical, 'utf8'))
    const signed = await signFile(canonicalBytes)
    const id = generateId()

    db.prepare(`
      INSERT INTO audit_chain_anchors
        (id, head_seq, head_hash, signature_b64, public_key_b64, fingerprint, anchored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, head.sequence, head.this_hash, signed.signatureB64,
      signed.publicKeyB64, signed.fingerprint, ts)

    log.info(`AuditChainAnchor: anchored chain head seq=${head.sequence} hash=${head.this_hash.slice(0, 16)}… fp=${signed.fingerprint}`)
    return {
      id, headSeq: head.sequence, headHash: head.this_hash,
      signatureB64: signed.signatureB64, publicKeyB64: signed.publicKeyB64,
      fingerprint: signed.fingerprint, anchoredAt: ts
    }
  }

  /** Recent anchors for the dashboard / export. */
  recentAnchors(limit: number = 50): AuditAnchor[] {
    return getDatabase().prepare(`
      SELECT id, head_seq AS headSeq, head_hash AS headHash,
             signature_b64 AS signatureB64, public_key_b64 AS publicKeyB64,
             fingerprint, anchored_at AS anchoredAt
      FROM audit_chain_anchors
      ORDER BY anchored_at DESC
      LIMIT ?
    `).all(limit) as AuditAnchor[]
  }

  /** Get current chain stats for the audit page. */
  async chainStats(): Promise<{
    chainLength: number
    lastAnchoredSeq: number | null
    lastAnchoredAt: number | null
    publicKeyInfo: { publicKeyB64: string; fingerprint: string }
    headHash: string | null
    coveragePercent: number
  }> {
    const db = getDatabase()
    let chainLength = 0
    let headHash: string | null = null
    try {
      const head = db.prepare(`SELECT COUNT(*) AS n, MAX(this_hash) AS h FROM audit_log_chained`)
        .get() as { n: number; h: string | null }
      chainLength = head.n
      const headRow = db.prepare(`SELECT this_hash AS h FROM audit_log_chained ORDER BY sequence DESC LIMIT 1`)
        .get() as { h: string } | undefined
      headHash = headRow?.h ?? null
    } catch { /* table may not exist on fresh installs */ }

    const lastAnchor = db.prepare(`
      SELECT head_seq AS headSeq, anchored_at AS anchoredAt
      FROM audit_chain_anchors ORDER BY anchored_at DESC LIMIT 1
    `).get() as { headSeq: number; anchoredAt: number } | undefined

    const publicKeyInfo = await getPublicKeyInfo()
    const coveragePercent = chainLength > 0
      ? Math.round(100 * (lastAnchor?.headSeq ?? 0) / chainLength)
      : 100

    return {
      chainLength,
      lastAnchoredSeq: lastAnchor?.headSeq ?? null,
      lastAnchoredAt: lastAnchor?.anchoredAt ?? null,
      publicKeyInfo,
      headHash,
      coveragePercent
    }
  }

  /**
   * Verify an anchor against the current chain. Returns:
   *   - 'valid' — anchor's headHash matches the row at headSeq
   *   - 'tampered' — chain has been altered (current hash at headSeq doesn't match)
   *   - 'orphan' — chain doesn't contain headSeq anymore (truncated)
   */
  verifyAnchor(anchorId: string): { status: 'valid' | 'tampered' | 'orphan' | 'not_found'; detail?: string } {
    const db = getDatabase()
    const anchor = db.prepare(`
      SELECT head_seq AS headSeq, head_hash AS headHash
      FROM audit_chain_anchors WHERE id = ?
    `).get(anchorId) as { headSeq: number; headHash: string } | undefined
    if (!anchor) return { status: 'not_found' }

    let row: { this_hash: string } | undefined
    try {
      row = db.prepare(`SELECT this_hash FROM audit_log_chained WHERE sequence = ?`)
        .get(anchor.headSeq) as { this_hash: string } | undefined
    } catch { return { status: 'orphan', detail: 'audit_log_chained table missing' } }

    if (!row) return { status: 'orphan', detail: 'chain row pruned' }
    if (row.this_hash !== anchor.headHash) {
      return { status: 'tampered', detail: `expected ${anchor.headHash.slice(0, 16)}…, got ${row.this_hash.slice(0, 16)}…` }
    }
    return { status: 'valid' }
  }

  /** Build an export blob of recent anchors for a third-party verifier. */
  exportAnchors(limit: number = 100): { exportedAt: number; anchors: AuditAnchor[]; manifestHash: string } {
    const anchors = this.recentAnchors(limit)
    const exportedAt = Date.now()
    // Hash the manifest itself for tamper-detection of the export bundle
    const manifestStr = JSON.stringify({ exportedAt, anchors })
    const manifestHash = createHash('sha256').update(manifestStr).digest('hex')
    return { exportedAt, anchors, manifestHash }
  }
}

export const auditChainAnchorService = new AuditChainAnchorService()
