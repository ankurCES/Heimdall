import bcrypt from 'bcryptjs'
import log from 'electron-log'
import { generateId } from '@common/utils/id'
import { getDatabase } from '../database'
import { settingsService } from '../settings/SettingsService'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Theme 10.8 — Two-person integrity for high-classification exports.
 *
 * In single-user mode the "second person" is a separate passphrase
 * (different from the DB encryption passphrase). The analyst sets it
 * once in Settings → Safety. When enabled, certain actions require
 * approval:
 *   - Export at SECRET or TOP SECRET
 *   - Panic wipe
 *   - Changing encryption passphrase
 *   - Disabling air-gap mode
 *
 * The approval flow:
 *   1. The action creates a pending ApprovalRequest (expires 1h).
 *   2. Renderer shows ApprovalDialog requiring the second passphrase.
 *   3. On correct passphrase → approved. On wrong → rejected.
 *   4. The action proceeds only on approval.
 *
 * In multi-user mode (Batch 5 / Theme 10.10), the approver becomes a
 * different authenticated user rather than a passphrase check.
 */

export interface ApprovalRequest {
  id: string
  action: string
  artifact_type: string | null
  artifact_id: string | null
  classification: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  requester: string
  approver: string | null
  rejection_reason: string | null
  created_at: number
  resolved_at: number | null
  expires_at: number
}

const EXPIRY_MS = 60 * 60 * 1000 // 1 hour

export class TwoPersonService {
  isEnabled(): boolean {
    return !!(settingsService.get<boolean>('twoPersonIntegrity.enabled'))
  }

  hasPassphrase(): boolean {
    return !!(settingsService.get<string>('twoPersonIntegrity.passphraseHash'))
  }

  setPassphrase(passphrase: string): void {
    if (!passphrase || passphrase.length < 8) throw new Error('Passphrase must be ≥8 characters')
    const hash = bcrypt.hashSync(passphrase, 10)
    settingsService.set('twoPersonIntegrity.passphraseHash', hash)
    settingsService.set('twoPersonIntegrity.enabled', true)
    try {
      auditChainService.append('twoperson.passphrase_set', {
        entityType: 'two_person', entityId: 'self', payload: {}
      })
    } catch { /* noop */ }
    log.info('two-person: passphrase set and enabled')
  }

  disable(): void {
    settingsService.set('twoPersonIntegrity.enabled', false)
    log.info('two-person: disabled')
    try {
      auditChainService.append('twoperson.disabled', {
        entityType: 'two_person', entityId: 'self', payload: {}
      })
    } catch { /* noop */ }
  }

  /**
   * Verify the second-person passphrase WITHOUT consuming an approval
   * request. Used by the gated `twoperson:disable` IPC handler.
   * Constant-time bcrypt compare.
   */
  verifyPassphrase(passphrase: string): boolean {
    if (!passphrase) return false
    const hash = settingsService.get<string>('twoPersonIntegrity.passphraseHash')
    if (!hash) return false
    try { return bcrypt.compareSync(passphrase, hash) }
    catch { return false }
  }

  /** Create a pending approval request. Returns the request for the renderer to display. */
  requireApproval(args: {
    action: string
    artifact_type?: string | null
    artifact_id?: string | null
    classification: string
  }): ApprovalRequest {
    if (!this.isEnabled()) throw new Error('Two-person integrity is not enabled')
    const db = getDatabase()
    const id = generateId()
    const now = Date.now()
    db.prepare(`
      INSERT INTO approval_requests
        (id, action, artifact_type, artifact_id, classification, status, requester, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'self', ?, ?)
    `).run(id, args.action, args.artifact_type ?? null, args.artifact_id ?? null,
      args.classification, now, now + EXPIRY_MS)
    return this.get(id)!
  }

  /** Approve a request by verifying the second-person passphrase. */
  approve(requestId: string, passphrase: string): boolean {
    const db = getDatabase()
    const req = this.get(requestId)
    if (!req) throw new Error(`Request ${requestId} not found`)
    if (req.status !== 'pending') throw new Error(`Request is ${req.status}, not pending`)
    if (Date.now() > req.expires_at) {
      db.prepare('UPDATE approval_requests SET status = ?, resolved_at = ? WHERE id = ?')
        .run('expired', Date.now(), requestId)
      throw new Error('Request has expired')
    }
    const hash = settingsService.get<string>('twoPersonIntegrity.passphraseHash')
    if (!hash) throw new Error('No second-person passphrase configured')
    if (!bcrypt.compareSync(passphrase, hash)) {
      db.prepare(`
        UPDATE approval_requests SET status = 'rejected', rejection_reason = 'wrong_passphrase', resolved_at = ? WHERE id = ?
      `).run(Date.now(), requestId)
      try {
        auditChainService.append('twoperson.rejected', {
          entityType: 'approval', entityId: requestId,
          payload: { action: req.action, reason: 'wrong_passphrase' }
        })
      } catch { /* noop */ }
      return false
    }
    db.prepare(`
      UPDATE approval_requests SET status = 'approved', approver = 'second_person', resolved_at = ? WHERE id = ?
    `).run(Date.now(), requestId)
    try {
      auditChainService.append('twoperson.approved', {
        entityType: 'approval', entityId: requestId,
        payload: { action: req.action }
      })
    } catch { /* noop */ }
    return true
  }

  reject(requestId: string, reason: string): void {
    const db = getDatabase()
    db.prepare(`
      UPDATE approval_requests SET status = 'rejected', rejection_reason = ?, resolved_at = ? WHERE id = ?
    `).run(reason, Date.now(), requestId)
  }

  /**
   * Check that a request id is in 'approved' state for the expected
   * action and within an acceptable freshness window. Used by privileged
   * IPC handlers (panic_wipe, mcp:add_server, etc.) to enforce
   * two-person integrity at the call site.
   */
  checkApproved(requestId: string, expectedAction: string, maxAgeMs: number = 5 * 60 * 1000): { ok: boolean; reason?: string } {
    const req = this.get(requestId)
    if (!req) return { ok: false, reason: 'approval request not found' }
    if (req.status !== 'approved') return { ok: false, reason: `approval status is ${req.status}` }
    if (req.action !== expectedAction) return { ok: false, reason: `approval is for "${req.action}", not "${expectedAction}"` }
    if (req.resolved_at && Date.now() - req.resolved_at > maxAgeMs) {
      return { ok: false, reason: 'approval has expired (>5 min old)' }
    }
    return { ok: true }
  }

  get(id: string): ApprovalRequest | null {
    const db = getDatabase()
    return (db.prepare(
      'SELECT id, action, artifact_type, artifact_id, classification, status, requester, approver, rejection_reason, created_at, resolved_at, expires_at FROM approval_requests WHERE id = ?'
    ).get(id) as ApprovalRequest) || null
  }

  pending(): ApprovalRequest[] {
    const db = getDatabase()
    // Expire stale requests first.
    const now = Date.now()
    db.prepare("UPDATE approval_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at < ?")
      .run(now, now)
    return db.prepare(
      "SELECT id, action, artifact_type, artifact_id, classification, status, requester, approver, rejection_reason, created_at, resolved_at, expires_at FROM approval_requests WHERE status = 'pending' ORDER BY created_at DESC"
    ).all() as ApprovalRequest[]
  }

  history(limit = 50): ApprovalRequest[] {
    const db = getDatabase()
    return db.prepare(
      'SELECT id, action, artifact_type, artifact_id, classification, status, requester, approver, rejection_reason, created_at, resolved_at, expires_at FROM approval_requests ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as ApprovalRequest[]
  }
}

export const twoPersonService = new TwoPersonService()
