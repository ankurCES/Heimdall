import log from 'electron-log'

interface Bucket {
  tokens: number
  lastRefill: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private maxTokens: number
  private refillInterval: number // ms per token

  constructor(requestsPerMinute: number = 30) {
    this.maxTokens = requestsPerMinute
    this.refillInterval = 60000 / requestsPerMinute
  }

  setRate(requestsPerMinute: number): void {
    this.maxTokens = requestsPerMinute
    this.refillInterval = 60000 / requestsPerMinute
  }

  async acquire(domain: string): Promise<void> {
    const bucket = this.getBucket(domain)
    this.refill(bucket)

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return
    }

    // Wait for next token
    const waitTime = this.refillInterval - (Date.now() - bucket.lastRefill)
    if (waitTime > 0) {
      log.debug(`Rate limiter: waiting ${waitTime}ms for ${domain}`)
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }
    this.refill(bucket)
    bucket.tokens = Math.max(0, bucket.tokens - 1)
  }

  canAcquire(domain: string): boolean {
    const bucket = this.getBucket(domain)
    this.refill(bucket)
    return bucket.tokens >= 1
  }

  getUsage(domain: string): { available: number; max: number } {
    const bucket = this.getBucket(domain)
    this.refill(bucket)
    return { available: Math.floor(bucket.tokens), max: this.maxTokens }
  }

  private getBucket(domain: string): Bucket {
    let bucket = this.buckets.get(domain)
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: Date.now() }
      this.buckets.set(domain, bucket)
    }
    return bucket
  }

  /** Remove buckets not accessed in the last hour */
  pruneStale(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    for (const [domain, bucket] of this.buckets) {
      if (bucket.lastRefill < oneHourAgo) {
        this.buckets.delete(domain)
      }
    }
  }

  private refill(bucket: Bucket): void {
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    const tokensToAdd = elapsed / this.refillInterval
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now
  }
}
