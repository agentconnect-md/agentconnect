/**
 * `ReqRep` — request/reply correlation + retransmit for a dial-out WS client,
 * generic over the wire's frame union so every wire (daemon↔CP `AnyFrame`,
 * relay↔CP `RelayCpFrame`, relay↔daemon `RelayDaemonFrame`) reuses one
 * implementation.
 *
 * Holds an `id → pending` map for client-issued REQs. On ack timeout it
 * retransmits the identical bytes (same `id`) up to `maxTries`, all driven by
 * the injected {@link Clock} so retries are deterministic in tests. `settle(rep)`
 * resolves on a correlated REP and rejects with a {@link WireError} on a
 * correlated `error` frame.
 */
import type { ErrorFrame } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from './clock.js'

/** The minimal frame shape the correlator needs — every wire's envelope satisfies it. */
export interface WireFrameLike {
  id: string
  corr?: string
  type: string
  orgId?: string | undefined
  payload: unknown
}

/** Transport-free representation of a typed wire `error` REP. */
export class WireError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message)
    this.name = 'WireError'
    this.code = code
    this.retryable = retryable
    if (details) this.details = details
  }
}

interface Pending<F> {
  id: string
  /** The REQ as issued — a correlated reply is fenced against its type and org before it settles. */
  request: { type: string; orgId?: string | undefined }
  encoded: string
  resolve: (frame: F) => void
  reject: (err: unknown) => void
  tries: number
  maxTries: number
  timer?: TimerHandle
}

/** Per-request overrides of the retransmit budget (e.g. a single-shot 10s RPC). */
export interface RequestOpts {
  maxTries?: number
  ackTimeoutMs?: number
}

export class ReqRep<F extends WireFrameLike = WireFrameLike> {
  private pending = new Map<string, Pending<F>>()

  constructor(
    private readonly clock: Clock,
    private readonly ackTimeoutMs: number,
    private readonly maxTries = 5
  ) {}

  request(frame: F, write: (encoded: string) => void, opts: RequestOpts = {}): Promise<F> {
    const encoded = JSON.stringify(frame)
    return new Promise<F>((resolve, reject) => {
      const entry: Pending<F> = {
        id: frame.id,
        request: { type: frame.type, ...(frame.orgId ? { orgId: frame.orgId } : {}) },
        encoded,
        resolve,
        reject,
        tries: 1,
        maxTries: opts.maxTries ?? this.maxTries
      }
      this.pending.set(frame.id, entry)
      this.arm(entry, write, opts.ackTimeoutMs ?? this.ackTimeoutMs)
      // A dead transport must reject THIS request — never throw into the caller
      // (or, on the timer path below, crash the process as an uncaught throw).
      try {
        write(encoded)
      } catch (e) {
        this.fail(entry, new WireError('INTERNAL', `send failed: ${(e as Error).message}`, true))
      }
    })
  }

  private arm(entry: Pending<F>, write: (encoded: string) => void, ackTimeoutMs: number): void {
    entry.timer = this.clock.setTimeout(() => {
      if (!this.pending.has(entry.id)) return
      if (entry.tries >= entry.maxTries) {
        this.pending.delete(entry.id)
        entry.reject(new WireError('INTERNAL', `no ack after ${entry.maxTries} tries for ${entry.id}`, true))
        return
      }
      entry.tries += 1
      this.arm(entry, write, ackTimeoutMs)
      try {
        write(entry.encoded)
      } catch (e) {
        this.fail(entry, new WireError('INTERNAL', `send failed: ${(e as Error).message}`, true))
      }
    }, ackTimeoutMs)
  }

  private fail(entry: Pending<F>, err: WireError): void {
    if (!this.pending.has(entry.id)) return
    this.pending.delete(entry.id)
    if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer)
    entry.reject(err)
  }

  /**
   * Settle a pending REQ from an inbound correlated frame. Returns true when
   * `frame.corr` matched a pending REQ (a REP resolves it; an `error` frame
   * rejects with a {@link WireError}), false when it correlates nothing.
   */
  settle(frame: F): boolean {
    const corr = frame.corr
    if (!corr) return false
    if (frame.type === 'error') {
      const e = frame.payload as ErrorFrame
      return this.reject(corr, new WireError(e.code, e.message, e.retryable, e.details))
    }
    const entry = this.pending.get(corr)
    if (!entry) return false
    this.pending.delete(corr)
    if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer)
    entry.resolve(frame)
    return true
  }

  /** The still-pending REQ a reply with `corr` would settle, if any — read before `settle` to fence the reply. */
  requested(corr: string): { type: string; orgId?: string | undefined } | undefined {
    return this.pending.get(corr)?.request
  }

  /** Reject one pending request by correlation id (e.g. a REP whose envelope is
   * valid but whose payload cannot be decoded). Returns false when nothing matches. */
  reject(corr: string, err: unknown): boolean {
    const entry = this.pending.get(corr)
    if (!entry) return false
    this.pending.delete(corr)
    if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer)
    entry.reject(err)
    return true
  }

  inflight(): number {
    return this.pending.size
  }

  rejectAll(err: unknown): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}
