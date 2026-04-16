import log from 'electron-log'
import { generateId, timestamp } from '@common/utils/id'
import { getDatabase } from '../database'
import { llmService } from '../llm/LlmService'
import { auditChainService } from '../audit/AuditChainService'

/**
 * Cross-cutting H — Memory consolidation.
 *
 * Nightly job: scans chat sessions updated in the last 24-48h that have
 * enough substance (≥4 user/assistant exchanges, ≥800 chars total, no
 * existing auto-consolidated humint for that session), asks the LLM to
 * extract the durable findings + analyst notes, and writes a new
 * humint_reports row with auto_consolidated=1.
 *
 * The humint_recall tool already queries humint_reports, so consolidated
 * memories flow into every future chat automatically.
 *
 * Completely optional: if no LLM is configured the service logs a warn
 * and skips. The nightly cron in process/index.ts runs it regardless —
 * it's a no-op without the model.
 */

export interface ConsolidationRun {
  id: number
  started_at: number
  finished_at: number
  sessions_considered: number
  sessions_consolidated: number
  humints_created: number
  duration_ms: number
}

const MIN_EXCHANGES = 4          // user+assistant messages (= 2 exchanges)
const MIN_CONTENT_CHARS = 800
const LOOKBACK_MS = 48 * 60 * 60 * 1000

const SYSTEM_PROMPT = `You compress intelligence chat sessions into durable analyst findings. Output TWO sections:

FINDINGS:
<2-4 concrete claims the analyst reached in this session, each on its own line, anchored in the source intel cited in the conversation. No speculation. If the session produced no findings, output exactly "NONE".>

NOTES:
<1-3 sentences of context — tradecraft used, gaps identified, caveats. Plain prose.>

Rules:
- Only extract things actually discussed. Do not add external information.
- Prefer specific over generic ("SolarWinds 2024 supply-chain compromise" over "APT activity").
- If the session is small-talk, administrative, or off-topic, output "FINDINGS:\\nNONE\\nNOTES:\\n<why — one sentence>".
- No markdown, no prose wrapper, no bullet characters — exactly the two sections above.`

export class ConsolidationService {
  async runOnce(opts: { lookback_ms?: number } = {}): Promise<ConsolidationRun> {
    const db = getDatabase()
    const started = Date.now()
    const runId = Number(db.prepare(
      'INSERT INTO consolidation_runs (started_at) VALUES (?)'
    ).run(started).lastInsertRowid)

    try {
      const since = started - (opts.lookback_ms ?? LOOKBACK_MS)

      // Candidate sessions: updated in window, NOT already auto-consolidated.
      const sessions = db.prepare(`
        SELECT s.id, s.title, s.updated_at
        FROM chat_sessions s
        WHERE s.updated_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM humint_reports h
            WHERE h.session_id = s.id AND h.auto_consolidated = 1
              AND h.created_at >= s.updated_at
          )
        ORDER BY s.updated_at DESC
      `).all(since) as Array<{ id: string; title: string; updated_at: number }>

      let created = 0
      let consolidated = 0

      for (const s of sessions) {
        const messages = db.prepare(`
          SELECT role, content, created_at
          FROM chat_messages
          WHERE session_id = ? AND role IN ('user', 'assistant')
          ORDER BY created_at ASC
        `).all(s.id) as Array<{ role: string; content: string; created_at: number }>

        if (messages.length < MIN_EXCHANGES) continue
        const totalLen = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
        if (totalLen < MIN_CONTENT_CHARS) continue

        // Build a compact transcript — cap each turn at 1500 chars so a
        // marathon session doesn't overflow the LLM context. Full content
        // is still accessible via the raw chat_messages table if needed.
        const transcript = messages.map((m) =>
          `${m.role === 'user' ? 'ANALYST' : 'MODEL'}: ${(m.content || '').slice(0, 1500)}`
        ).join('\n\n').slice(0, 20000)

        const prompt = `${SYSTEM_PROMPT}\n\nSession title: ${s.title}\n\n---\n${transcript}\n---\n\nOutput the two sections now.`

        let completion = ''
        try {
          completion = await llmService.complete(prompt, undefined, 1500)
        } catch (err) {
          log.warn(`consolidation: skipping session ${s.id} — LLM call failed: ${(err as Error).message}`)
          continue
        }

        const parsed = this.parseOutput(completion)
        if (!parsed || parsed.findings === 'NONE' || !parsed.findings.trim()) {
          consolidated++ // counted as "considered but nothing to extract"
          continue
        }

        const humintId = generateId()
        const now = timestamp()
        db.prepare(`
          INSERT INTO humint_reports
            (id, session_id, analyst_notes, findings, confidence, source_report_ids, tool_calls_used,
             status, auto_consolidated, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'medium', '[]', '[]', 'draft', 1, ?, ?)
        `).run(humintId, s.id, parsed.notes, parsed.findings, now, now)

        try {
          auditChainService.append('consolidation.humint_created', {
            entityType: 'humint_report', entityId: humintId,
            payload: { session_id: s.id, auto: true, findings_len: parsed.findings.length }
          })
        } catch { /* noop */ }

        created++
        consolidated++
      }

      const finished = Date.now()
      db.prepare(
        'UPDATE consolidation_runs SET finished_at=?, sessions_considered=?, sessions_consolidated=?, humints_created=?, duration_ms=? WHERE id=?'
      ).run(finished, sessions.length, consolidated, created, finished - started, runId)

      log.info(`consolidation: ${sessions.length} sessions considered, ${created} humints created, ${finished - started}ms`)

      return {
        id: runId, started_at: started, finished_at: finished,
        sessions_considered: sessions.length, sessions_consolidated: consolidated,
        humints_created: created, duration_ms: finished - started
      }
    } catch (err) {
      db.prepare('UPDATE consolidation_runs SET finished_at=?, error=? WHERE id=?')
        .run(Date.now(), (err as Error).message, runId)
      throw err
    }
  }

  private parseOutput(raw: string): { findings: string; notes: string } | null {
    if (!raw) return null
    const fIdx = raw.search(/\bFINDINGS\s*:/i)
    const nIdx = raw.search(/\bNOTES\s*:/i)
    if (fIdx === -1) return null
    const findings = (nIdx > fIdx ? raw.slice(fIdx, nIdx) : raw.slice(fIdx))
      .replace(/^FINDINGS\s*:/i, '').trim()
    const notes = nIdx !== -1 ? raw.slice(nIdx).replace(/^NOTES\s*:/i, '').trim() : ''
    return { findings, notes }
  }

  latestRun(): ConsolidationRun | null {
    const db = getDatabase()
    return (db.prepare(`
      SELECT id, started_at, finished_at, sessions_considered, sessions_consolidated,
             humints_created, duration_ms
      FROM consolidation_runs
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY id DESC LIMIT 1
    `).get() as ConsolidationRun) || null
  }

  recentRuns(limit = 20): ConsolidationRun[] {
    const db = getDatabase()
    return db.prepare(`
      SELECT id, started_at, finished_at, sessions_considered, sessions_consolidated,
             humints_created, duration_ms
      FROM consolidation_runs
      WHERE finished_at IS NOT NULL
      ORDER BY id DESC LIMIT ?
    `).all(limit) as ConsolidationRun[]
  }
}

export const consolidationService = new ConsolidationService()
