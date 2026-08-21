/**
 * PlatformSendQueue: serialize a connection's outbound chat-platform writes and
 * space them by a minimum interval, so streamed edits don't trip a provider's
 * per-method rate limit. FIFO: preserves the order the converger emits.
 *
 * The first task runs immediately; each subsequent task waits until at least
 * `minIntervalMs` after the previous one *started*. `enqueue` resolves/rejects
 * with the task's own result, so callers can still await a posted message id.
 *
 * Each task is bounded by `taskTimeoutMs`: if a single call hangs (e.g. a provider
 * API stall during a socket reconnect), it is abandoned so the queue keeps moving
 * and a best-effort status update can never block real message delivery. The
 * abandoned call's promise still settles in the background; the caller just sees a
 * timeout rejection (which, for a progress/plan post, the daemon treats as "no ts").
 */
/** True for the queue's own abandonment rejection — the task KEEPS RUNNING and may still land,
 *  so a caller must report "may have been sent", never "nothing was sent". */
export function isSendQueueTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { sendQueueTimeout?: unknown }).sendQueueTimeout === true
}

export class PlatformSendQueue {
  private chain: Promise<unknown> = Promise.resolve()
  // -inf so the very first task never waits, regardless of the clock's origin.
  private lastStart = Number.NEGATIVE_INFINITY

  constructor(
    private readonly minIntervalMs = 350,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly taskTimeoutMs = 30_000
  ) {}

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastStart)
      if (wait > 0) await this.sleep(wait)
      this.lastStart = this.now()
      return this.withTimeout(task())
    })
    // Keep the chain alive even if a task throws/times out, but don't swallow the
    // error for the caller — they get the original rejection from `run`.
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    if (!Number.isFinite(this.taskTimeoutMs) || this.taskTimeoutMs <= 0) return p
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          Object.assign(new Error(`PlatformSendQueue: task exceeded ${this.taskTimeoutMs}ms — abandoned`), {
            sendQueueTimeout: true
          })
        )
      }, this.taskTimeoutMs)
      p.then(
        (v) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }
}
