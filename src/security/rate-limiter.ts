interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token-bucket limiter keyed by identity or client address. A limit of 0 disables limiting. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string, cost = 1): { allowed: boolean; retryAfterSeconds: number } {
    if (this.limitPerMinute <= 0) return { allowed: true, retryAfterSeconds: 0 };
    const now = this.now();
    const refillPerMs = this.limitPerMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.limitPerMinute, updatedAt: now };
    bucket.tokens = Math.min(this.limitPerMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - bucket.tokens) / refillPerMs / 1_000)) };
  }

  /** Drops buckets that have fully refilled, keeping memory bounded. */
  prune(): void {
    const now = this.now();
    const refillPerMs = this.limitPerMinute / 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) * refillPerMs >= this.limitPerMinute) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
