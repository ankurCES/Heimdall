// RetryWithBackoff — generic exponential-backoff retry helper with
// jitter and configurable retry-decisions.
//
// Usage:
//   const result = await retryWithBackoff(
//     () => fetch(url),
//     { maxAttempts: 4, baseMs: 500, retryOn: (err) => isTransient(err) }
//   )
//
// Backoff schedule (default base 500ms, jitter ±20%):
//   attempt 1 → fail → wait 500ms ± 100ms
//   attempt 2 → fail → wait 1000ms ± 200ms
//   attempt 3 → fail → wait 2000ms ± 400ms
//   attempt 4 → fail → throw

import log from 'electron-log'

export interface RetryOptions {
  /** Total attempts (including the first). Default 3. */
  maxAttempts?: number
  /** Base wait in ms; doubled each attempt. Default 500. */
  baseMs?: number
  /** Cap on wait time. Default 10s. */
  maxBackoffMs?: number
  /** Jitter as a fraction of base wait. Default 0.2 (±20%). */
  jitter?: number
  /** Predicate — return true to retry, false to throw immediately. Default = retry on any throw. */
  retryOn?: (err: Error, attempt: number) => boolean
  /** Optional label for log lines. */
  label?: string
}

export class RetryExhaustedError extends Error {
  constructor(
    public readonly label: string,
    public readonly attempts: number,
    public readonly lastError: Error
  ) {
    super(`Retry exhausted after ${attempts} attempts (${label}): ${lastError.message}`)
    this.name = 'RetryExhaustedError'
  }
}

/** Default: retry on any thrown error. */
const ALWAYS_RETRY = (): boolean => true

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseMs = opts.baseMs ?? 500
  const maxBackoffMs = opts.maxBackoffMs ?? 10_000
  const jitter = opts.jitter ?? 0.2
  const retryOn = opts.retryOn ?? ALWAYS_RETRY
  const label = opts.label ?? 'retry'

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const error = err as Error
      lastError = error
      if (attempt >= maxAttempts || !retryOn(error, attempt)) break

      const wait = computeBackoff(baseMs, attempt, maxBackoffMs, jitter)
      log.debug(`${label}: attempt ${attempt}/${maxAttempts} failed (${error.message.slice(0, 80)}), retrying in ${Math.round(wait)}ms`)
      await sleep(wait)
    }
  }
  throw new RetryExhaustedError(label, maxAttempts, lastError ?? new Error('no error captured'))
}

function computeBackoff(baseMs: number, attempt: number, maxMs: number, jitter: number): number {
  const exp = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exp, maxMs)
  const noise = capped * jitter * (Math.random() * 2 - 1)
  return Math.max(0, capped + noise)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Common predicates for retryOn. */
export const RetryPredicates = {
  /** Network errors and 5xx responses; not 4xx. */
  transientNetwork: (err: Error): boolean => {
    const msg = err.message.toLowerCase()
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('enotfound')
      || msg.includes('econnrefused') || msg.includes('econnaborted')
      || msg.includes('socket hang up') || msg.includes('timeout')
      || msg.includes('network')) return true
    // HTTP status codes embedded in error text
    if (/\b5\d\d\b/.test(msg)) return true
    if (/\b429\b/.test(msg)) return true
    return false
  },

  /** LLM rate limits and overload. */
  llmTransient: (err: Error): boolean => {
    const msg = err.message.toLowerCase()
    return msg.includes('rate limit') || msg.includes('rate_limit')
      || msg.includes('overloaded') || msg.includes('overload')
      || msg.includes('too many') || /\b429\b/.test(msg)
      || msg.includes('timeout') || /\b5\d\d\b/.test(msg)
  },

  /** Never retry — useful for opting out at call sites. */
  never: () => false
}
