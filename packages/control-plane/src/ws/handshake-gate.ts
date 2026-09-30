/** Frees one gate slot; running it again does nothing. */
export type ReleaseSlot = () => void

const REPORT_EVERY_MS = 10_000

/** Caps the daemon handshake work running at once, so a reconnect storm backs off at the socket edge instead of queuing on the database pool. */
export class HandshakeGate {
  private inFlight = 0
  private readonly queue: Array<() => void> = []
  private refused = 0
  private reportedAt = -Infinity

  constructor(
    readonly limit: number,
    /** Told how many auth steps were refused since the last report, at most once every 10s. */
    private readonly report: (refused: number) => void = () => {}
  ) {}

  /** A slot for an auth step, or undefined while the gate is full or a daemon past auth waits to register. */
  tryAcquire(): ReleaseSlot | undefined {
    if (this.inFlight < this.limit && this.queue.length === 0) return this.grant()
    this.refused++
    const now = Date.now()
    if (now - this.reportedAt >= REPORT_EVERY_MS) {
      this.report(this.refused)
      this.refused = 0
      this.reportedAt = now
    }
    return undefined
  }

  /** A slot for a register step, in arrival order, so a daemon past auth is never sent back to repeat it. */
  acquire(): Promise<ReleaseSlot> {
    if (this.inFlight < this.limit && this.queue.length === 0) return Promise.resolve(this.grant())
    return new Promise((resolve) => this.queue.push(() => resolve(this.grant())))
  }

  get size(): number {
    return this.inFlight
  }

  get waiting(): number {
    return this.queue.length
  }

  private grant(): ReleaseSlot {
    this.inFlight++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.inFlight--
      this.queue.shift()?.()
    }
  }
}

/** The handshake limit a CP runs with: explicit, or three quarters of its database pool (pg's default of 10 when unset). */
export function handshakeLimit(config: { DATABASE_POOL_MAX?: number; DAEMON_HANDSHAKE_CONCURRENCY?: number }): number {
  return config.DAEMON_HANDSHAKE_CONCURRENCY ?? Math.max(1, Math.floor(((config.DATABASE_POOL_MAX ?? 10) * 3) / 4))
}
