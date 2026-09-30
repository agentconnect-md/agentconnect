/** Caps concurrent daemon handshakes so a reconnect storm queues at the socket edge, not on the database pool. */
export class HandshakeGate {
  private inFlight = 0

  constructor(readonly limit: number) {}

  /** A slot for one handshake, or undefined when the gate is full; the returned release is idempotent. */
  tryAcquire(): (() => void) | undefined {
    if (this.inFlight >= this.limit) return undefined
    this.inFlight++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.inFlight--
    }
  }

  get size(): number {
    return this.inFlight
  }
}

/** The handshake limit a CP runs with: explicit, or three quarters of its database pool (pg's default of 10 when unset). */
export function handshakeLimit(config: { DATABASE_POOL_MAX?: number; DAEMON_HANDSHAKE_CONCURRENCY?: number }): number {
  return config.DAEMON_HANDSHAKE_CONCURRENCY ?? Math.max(1, Math.floor(((config.DATABASE_POOL_MAX ?? 10) * 3) / 4))
}
