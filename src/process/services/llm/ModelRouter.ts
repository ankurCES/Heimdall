import { settingsService } from '../settings/SettingsService'
import type { LlmConfig, LlmConnection } from '@common/types/settings'
import log from 'electron-log'

/**
 * Model routing — heuristic auto-selection of (connection, model) per task.
 *
 * The agentic chat pipeline runs many distinct LLM subtasks (planner,
 * refiner, analyst, vision, code-summary…). Different models are good at
 * different things:
 *
 *   - Planner / refiner: short JSON output, latency matters more than
 *     depth → small/fast models (gemma2:2b, llama3.2:3b, gpt-4o-mini,
 *     haiku, phi-3-mini, gemini-flash, etc.).
 *   - Analyst synthesis: long-form structured briefings → large strong
 *     models (gemma:31b, gpt-4o, claude-opus/sonnet, gemini-pro,
 *     deepseek-v3, qwen2.5:72b, …).
 *   - Vision: image understanding → vision-capable models (llava,
 *     bakllava, gpt-4o, claude-3-*, gemini, qwen-vl, llama3.2-vision).
 *   - Code: detection rule generation, code summarisation → code-tuned
 *     (codellama, qwen-coder, deepseek-coder, codestral, starcoder).
 *
 * The router scores every (connection, model) pair the user has enabled
 * against a per-task profile and returns the best fit, falling back to
 * the user's defaultConnectionId if nothing scores positively.
 *
 * No external API calls — pure pattern matching against model names. The
 * scoring matrix is conservative; new models can be added without touching
 * call sites.
 */

export type TaskClass =
  | 'planner'           // structured JSON; small + fast
  | 'refiner'           // structured JSON; small + fast
  | 'watch_term_refine' // structured JSON; small + fast
  | 'analysis'          // long-form synthesis; large + strong
  | 'briefing'          // long-form synthesis; large + strong
  | 'wargame'           // long-form structured; large + strong
  | 'forecast'          // mostly structured forecasting; mid-large
  | 'vision'            // requires vision capability
  | 'code'              // detection rules, code tasks
  | 'chat'              // general agent chat — balance speed/quality
  | 'tool_call'         // function-calling agent; needs tool support
  | 'summary'           // short paraphrasing; small + fast
  | 'embedding'         // embeddings endpoint (handled separately by VectorDb)

interface Resolved {
  connection: LlmConnection
  model: string
  reason: string
  score: number
}

/** Patterns matched (case-insensitive) against the model id. */
const PATTERNS = {
  // Vision-capable
  vision: /(llava|bakllava|llama3?\.2-vision|llama-3\.2-vision|gpt-4o|gpt-4-vision|claude-3|claude-(?:opus|sonnet|haiku)-3|claude-(?:opus|sonnet)|gemini|qwen.{0,4}vl|moondream|cogvlm|minicpm|pixtral|granite-vision|phi-3-vision|phi3-vision)/i,
  // Code-tuned
  code: /(codellama|code-?llama|qwen.{0,4}coder|deepseek-coder|deepseek-v\d-coder|codestral|starcoder|wizardcoder|magicoder|granite-code|code-?gemma)/i,
  // Small/fast — under ~7B params or designated "fast" tier
  fast: /(:1b|:2b|:3b|:4b|-1b\b|-2b\b|-3b\b|-4b\b|tiny|small|mini\b|nano\b|haiku|gemma2?:2b|gemma2?:3b|gemma:2b|llama3?\.2:1b|llama3?\.2:3b|phi-?3-?mini|phi-?3\.5-?mini|phi3-mini|flash|qwen2?:0\.5b|qwen2?:1\.5b|qwen2?:3b|gpt-4o-mini|gpt-4\.1-mini|gpt-3\.5)/i,
  // Large/strong — 30B+ or premium tier
  large: /(:30b|:31b|:32b|:33b|:34b|:40b|:65b|:70b|:72b|:90b|:110b|:175b|:235b|-70b\b|-72b\b|gpt-4o(?!-mini)|gpt-4(?!o-mini)|gpt-4\.5|claude-3-(?:opus|sonnet)|claude-(?:opus|sonnet)|claude-3\.5-sonnet|claude-(?:opus|sonnet)-4|gemini-(?:1\.5-)?pro|gemini-2-?pro|deepseek-v3|deepseek-v2\.5|qwen2\.5:72b|qwen2:72b|llama-?3-?(?:1|3)?-?70b|llama-?3\.3-?70b|grok|mistral-large|mixtral-8x22b|mixtral-8x7b|command-r-?plus|gemma2?:27b|gemma2?:31b|gemma:31b|nemotron|deepseek-r1)/i,
  // Tool-calling support — known good function-callers
  toolCallCapable: /(gpt-4|gpt-3\.5-turbo|gpt-4o|claude-3|claude-(?:opus|sonnet|haiku)|gemini-(?:1\.5-)?(?:pro|flash)|gemini-2|mistral-large|qwen2|qwen2\.5|llama-?3\.[12]|llama3\.[12]|firefunction|hermes|nous-hermes|granite-3)/i
}

/** Per-task scoring profile. Higher score = better fit. */
interface TaskProfile {
  /** Required capability — if a model fails this, score = -Infinity. */
  required?: 'vision' | 'toolCallCapable'
  /** Bonuses applied when a pattern matches. */
  bonuses: { fast?: number; large?: number; code?: number; vision?: number; toolCallCapable?: number }
  /** Penalties when a pattern matches (e.g. avoid large models for fast tasks). */
  penalties?: { fast?: number; large?: number; code?: number; vision?: number }
}

const TASK_PROFILES: Record<TaskClass, TaskProfile> = {
  planner:           { bonuses: { fast: 50, code: 5 }, penalties: { large: 10 } },
  refiner:           { bonuses: { fast: 50 }, penalties: { large: 8 } },
  watch_term_refine: { bonuses: { fast: 50 }, penalties: { large: 8 } },
  summary:           { bonuses: { fast: 40 }, penalties: { large: 5 } },
  analysis:          { bonuses: { large: 50 }, penalties: { fast: 10 } },
  briefing:          { bonuses: { large: 50 }, penalties: { fast: 10 } },
  wargame:           { bonuses: { large: 45 }, penalties: { fast: 8 } },
  forecast:          { bonuses: { large: 25 } },
  vision:            { required: 'vision', bonuses: { vision: 100, large: 10 } },
  code:              { bonuses: { code: 60, large: 10 }, penalties: { fast: 5 } },
  chat:              { bonuses: { large: 15 } },
  tool_call:         { required: 'toolCallCapable', bonuses: { toolCallCapable: 50, large: 10 } },
  embedding:         { bonuses: {} } // embeddings use their own endpoint
}

class ModelRouterImpl {
  /** All enabled connections, with their models. Multiple "models" per
   *  connection are supported via the comma-separated override the router
   *  honours: `customModel` may contain "model1,model2,model3". */
  enabledModels(): Array<{ conn: LlmConnection; model: string }> {
    const cfg = settingsService.get<LlmConfig>('llm')
    const conns = (cfg?.connections || []).filter((c) => c.enabled)
    const out: Array<{ conn: LlmConnection; model: string }> = []
    for (const conn of conns) {
      const seen = new Set<string>()
      const pushModel = (m: string) => {
        const trimmed = m.trim()
        if (!trimmed || seen.has(trimmed)) return
        seen.add(trimmed)
        out.push({ conn, model: trimmed })
      }
      if (conn.model) pushModel(conn.model)
      // Treat customModel as a comma-separated alt-model list so users can
      // give a single connection access to several models without creating
      // duplicate connection rows.
      if (conn.customModel) for (const m of conn.customModel.split(',')) pushModel(m)
    }
    return out
  }

  /** Score one model against a task. Returns the score + match reasons. */
  private scoreModel(model: string, task: TaskClass): { score: number; reasons: string[] } {
    const profile = TASK_PROFILES[task]
    const matches = {
      fast: PATTERNS.fast.test(model),
      large: PATTERNS.large.test(model),
      code: PATTERNS.code.test(model),
      vision: PATTERNS.vision.test(model),
      toolCallCapable: PATTERNS.toolCallCapable.test(model)
    }
    if (profile.required && !matches[profile.required]) {
      return { score: -Infinity, reasons: [`missing required capability: ${profile.required}`] }
    }
    let score = 0
    const reasons: string[] = []
    for (const [key, bonus] of Object.entries(profile.bonuses)) {
      if (matches[key as keyof typeof matches] && bonus) {
        score += bonus
        reasons.push(`+${bonus} ${key}`)
      }
    }
    for (const [key, penalty] of Object.entries(profile.penalties || {})) {
      if (matches[key as keyof typeof matches] && penalty) {
        score -= penalty
        reasons.push(`-${penalty} ${key}`)
      }
    }
    return { score, reasons }
  }

  /**
   * Pick the best (connection, model) for the given task.
   *
   * If `connectionIdOverride` is supplied, it pins the connection; the
   * router still picks the best model offered by that connection for the
   * task. Pass null/undefined for full auto.
   *
   * Returns null only when no enabled connections exist or no model meets
   * the required capability (e.g. asking for `vision` but no vision-capable
   * model is configured).
   */
  selectForTask(task: TaskClass, connectionIdOverride?: string): Resolved | null {
    const cfg = settingsService.get<LlmConfig>('llm')
    const all = this.enabledModels()
    if (all.length === 0) {
      log.warn(`ModelRouter[${task}]: no enabled LLM connections`)
      return null
    }

    const candidates = connectionIdOverride
      ? all.filter((m) => m.conn.id === connectionIdOverride)
      : all
    if (candidates.length === 0) {
      log.warn(`ModelRouter[${task}]: connection override ${connectionIdOverride} not found, falling back to all`)
      return this.selectForTask(task)
    }

    // Score every candidate. Tie-break: prefer the user's defaultConnectionId.
    const defaultId = cfg?.defaultConnectionId
    let best: Resolved | null = null
    for (const { conn, model } of candidates) {
      const { score, reasons } = this.scoreModel(model, task)
      if (score === -Infinity) continue
      const tieBreak = conn.id === defaultId ? 0.5 : 0
      const candidate: Resolved = {
        connection: conn,
        model,
        reason: reasons.length ? reasons.join(', ') : 'no specific bonuses',
        score: score + tieBreak
      }
      if (!best || candidate.score > best.score) best = candidate
    }

    if (!best) {
      // No model met requirements (e.g. vision task with no vision model).
      // Fall back to the default connection's primary model so the caller
      // gets *something* to try, with a clear log warning.
      const defaultConn = candidates.find((m) => m.conn.id === defaultId) || candidates[0]
      log.warn(`ModelRouter[${task}]: no model met requirements, falling back to ${defaultConn.conn.name}/${defaultConn.model}`)
      return { connection: defaultConn.conn, model: defaultConn.model, reason: 'fallback (no required-capability match)', score: 0 }
    }

    log.debug(`ModelRouter[${task}]: chose ${best.connection.name}/${best.model} (score ${best.score}, ${best.reason})`)
    return best
  }

  /** Pre-compute the routing matrix for all tasks — shown in the UI so
   *  the analyst can see exactly which model each subtask will use. */
  routingMatrix(): Array<{ task: TaskClass; selection: Resolved | null }> {
    const tasks: TaskClass[] = ['planner', 'refiner', 'watch_term_refine', 'summary', 'chat', 'tool_call', 'analysis', 'briefing', 'wargame', 'forecast', 'code', 'vision']
    return tasks.map((task) => ({ task, selection: this.selectForTask(task) }))
  }
}

export const modelRouter = new ModelRouterImpl()
