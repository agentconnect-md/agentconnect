// WeCom's send budget per conversation and upload budget per bot: each 30 a minute and 1,000 an hour (official doc, path 101463).

export const WECOM_PER_MINUTE = 30
export const WECOM_PER_HOUR = 1000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
// Conservative choice: a stream refresh is skipped unless this much of each window is left for answers and notices.
const REFRESH_RESERVE_MINUTE = 10
const REFRESH_RESERVE_HOUR = 100
const CONVERSATION_LIMIT = 2_000

/** The budget refused a send before it reached WeCom. */
export class WeComRateLimited extends Error {
  constructor() {
    super('WeCom allows 1,000 messages an hour in one conversation, and this one has used them')
    this.name = 'WeComRateLimited'
  }
}

/** Counts every frame this connection sends to a conversation; whether WeCom counts each stream refresh is undocumented, so each one counts. */
export class WeComSendBudget {
  private readonly sent = new Map<string, number[]>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms).unref?.())
  ) {}

  /** Whether a stream refresh fits with room to spare for the messages that must go out. */
  refreshFits(conversation: string): boolean {
    const { minute, hour } = this.used(conversation)
    return minute < WECOM_PER_MINUTE - REFRESH_RESERVE_MINUTE && hour < WECOM_PER_HOUR - REFRESH_RESERVE_HOUR
  }

  /** Take one slot, waiting out a full minute window; a spent hour window refuses at once. */
  async take(conversation: string): Promise<void> {
    for (;;) {
      const { minute, hour, oldestInMinute } = this.used(conversation)
      if (hour >= WECOM_PER_HOUR) throw new WeComRateLimited()
      if (minute < WECOM_PER_MINUTE) break
      await this.sleep(Math.max(1, oldestInMinute + MINUTE_MS - this.now()))
    }
    this.note(conversation)
  }

  /** Take one slot only if both windows have room now; never waits. */
  tryTake(key: string): boolean {
    const { minute, hour } = this.used(key)
    if (minute >= WECOM_PER_MINUTE || hour >= WECOM_PER_HOUR) return false
    this.note(key)
    return true
  }

  /** Count a frame sent without waiting, such as a refresh `refreshFits` already allowed. */
  note(conversation: string): void {
    const times = this.sent.get(conversation) ?? []
    times.push(this.now())
    this.sent.delete(conversation)
    this.sent.set(conversation, times)
    while (this.sent.size > CONVERSATION_LIMIT) this.sent.delete(this.sent.keys().next().value!)
  }

  private used(conversation: string): { minute: number; hour: number; oldestInMinute: number } {
    const now = this.now()
    const times = (this.sent.get(conversation) ?? []).filter((at) => now - at < HOUR_MS)
    if (times.length) this.sent.set(conversation, times)
    else this.sent.delete(conversation)
    const inMinute = times.filter((at) => now - at < MINUTE_MS)
    return { minute: inMinute.length, hour: times.length, oldestInMinute: inMinute[0] ?? now }
  }
}
