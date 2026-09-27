// The per-app write budget (google-chat-integration.md §10.8): one token bucket per Chat app on this daemon, under the per-Space queue.

/** Google's project-wide quota: message writes per minute, shared by every organization on one published app. */
export const GOOGLE_CHAT_PROJECT_WRITES_PER_MINUTE = 3_000

/** How many daemons share one app's project quota when nothing says otherwise. */
export const GOOGLE_CHAT_DEFAULT_POOL_SIZE = 4

export interface GoogleChatWriteBudgetSettings {
  /** Writes the bucket admits at once. */
  capacity: number
  /** Tokens added per minute. */
  refillPerMinute: number
}

/** The daemon's `googleChat` config as the budget reads it: the pool size derives the refill, and either knob may override. */
export function googleChatWriteBudgetSettings(
  config: { poolSize?: number; writesPerMinute?: number; writeBurst?: number } = {}
): GoogleChatWriteBudgetSettings {
  const poolSize = Math.max(1, Math.floor(config.poolSize ?? GOOGLE_CHAT_DEFAULT_POOL_SIZE))
  const refillPerMinute = Math.max(
    1,
    config.writesPerMinute ?? Math.floor(GOOGLE_CHAT_PROJECT_WRITES_PER_MINUTE / poolSize)
  )
  return { capacity: Math.max(1, config.writeBurst ?? refillPerMinute), refillPerMinute }
}

/** A token bucket writes wait on in arrival order; a saturated bucket delays a write and never drops it. */
export class GoogleChatWriteBudget {
  private tokens: number
  private updatedAt: number
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly settings: GoogleChatWriteBudgetSettings,
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

/** One bucket per Chat app on this daemon, keyed by the app's project number, since Google's quota is per project. */
export class GoogleChatWriteBudgets {
  private readonly buckets = new Map<string, GoogleChatWriteBudget>()

  constructor(
    private readonly settings: GoogleChatWriteBudgetSettings,
    private readonly now?: () => number,
    private readonly sleep?: (ms: number) => Promise<void>
  ) {}

  for(projectNumber: string): GoogleChatWriteBudget {
    let bucket = this.buckets.get(projectNumber)
    if (!bucket) {
      bucket = new GoogleChatWriteBudget(this.settings, this.now, this.sleep)
      this.buckets.set(projectNumber, bucket)
    }
    return bucket
  }
}
