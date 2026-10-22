// A provider write budget shared by every connection of one app on this daemon: a token bucket writes wait on, under each conversation's own queue.

export interface WriteBudgetSettings {
  /** Writes the bucket admits at once. */
  capacity: number
  /** Tokens added per minute. */
  refillPerMinute: number
}

/** A token bucket writes wait on in arrival order; a saturated bucket delays a write and never drops it. */
export class WriteBudget {
  private tokens: number
  private updatedAt: number
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly settings: WriteBudgetSettings,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms).unref?.())
  ) {
    this.tokens = settings.capacity
    this.updatedAt = now()
  }

  /** Take one write's token, waiting behind earlier takers until the refill covers it. */
  take(): Promise<void> {
    const turn = this.chain.then(() => this.acquire())
    this.chain = turn.then(
      () => undefined,
      () => undefined
    )
    return turn
  }

  /** Tokens available right now, after the refill the elapsed time earned. */
  available(): number {
    this.refill()
    return this.tokens
  }

  private refill(): void {
    const now = this.now()
    const elapsed = Math.max(0, now - this.updatedAt)
    this.tokens = Math.min(this.settings.capacity, this.tokens + (elapsed * this.settings.refillPerMinute) / 60_000)
    this.updatedAt = now
  }

  private async acquire(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await this.sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.settings.refillPerMinute))
    }
  }
}

/** One bucket per key on this daemon, created on first use. */
export class WriteBudgets {
  private readonly buckets = new Map<string, WriteBudget>()

  constructor(
    private readonly settings: WriteBudgetSettings,
    private readonly now?: () => number,
    private readonly sleep?: (ms: number) => Promise<void>
  ) {}

  for(key: string): WriteBudget {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = new WriteBudget(this.settings, this.now, this.sleep)
      this.buckets.set(key, bucket)
    }
    return bucket
  }
}
