// `ReqRep`: request/reply correlation with Clock-driven same-id retransmit (design §4.5, protocol §4.3).
import type { AnyFrame, ErrorFrame } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { ProtocolError } from '../domain/errors.js'

/** The envelope fields correlation reads; both the daemon and the relay wire satisfy it. */
export interface CorrelatedFrame {
  id: string
  type: string
  corr?: string | undefined
  orgId?: string | undefined
  payload: unknown
}

/** The peer never answered within the request's tries; a {@link ProtocolError} so existing callers are unchanged. */
export class RequestTimeout extends ProtocolError {}

interface Pending<F> {
  id: string
  /** The REQ as issued — a correlated reply is fenced against its type and org (frame-scope). */
  request: { type: string; orgId?: string | undefined }
  encoded: string
  resolve: (frame: F) => void
  reject: (err: unknown) => void
  tries: number
  maxTries: number
  timer?: TimerHandle
}

/** Per-request overrides for controls that legitimately take longer to apply. */
export interface RequestOpts {
  maxTries?: number
  ackTimeoutMs?: number
}

export class ReqRep<F extends CorrelatedFrame = AnyFrame> {
  private pending = new Map<string, Pending<F>>()

  constructor(
    private readonly clock: Clock,
    private readonly ackTimeoutMs: number,
    private readonly maxTries = 5
  ) {}

  /** Send a REQ via `write` and await its REP, resending the same bytes each `ackTimeoutMs` until `maxTries` (then {@link RequestTimeout}). */
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
      write(encoded)
    })
  }

  private arm(entry: Pending<F>, write: (encoded: string) => void, ackTimeoutMs: number): void {
    entry.timer = this.clock.setTimeout(() => {
      if (!this.pending.has(entry.id)) return
      if (entry.tries >= entry.maxTries) {
        this.pending.delete(entry.id)
        entry.reject(new RequestTimeout('INTERNAL', `no ack after ${entry.maxTries} tries for ${entry.id}`))
        return
      }
      entry.tries += 1
      this.arm(entry, write, ackTimeoutMs) // re-arm BEFORE re-send (deterministic ordering)
      write(entry.encoded) // identical id + seq → idempotent (protocol §4.3)
    }, ackTimeoutMs)
  }

  /** Settle the pending REQ a REP/error correlates to; true when one matched, so the FSM does not dispatch the frame. */
  settle(frame: F): boolean {
    const corr = frame.corr
    if (!corr) return false
    if (frame.type === 'error') return this.reject(corr, ProtocolError.fromFrame(frame.payload as ErrorFrame))
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

  /** Reject one pending request by correlation id when the peer's REP envelope
   * is valid but its payload cannot be decoded. */
  reject(corr: string, err: unknown): boolean {
    const entry = this.pending.get(corr)
    if (!entry) return false
    this.pending.delete(corr)
    if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer)
    entry.reject(err)
    return true
  }

  /** Number of in-flight REQs (assertions / shutdown checks). */
  inflight(): number {
    return this.pending.size
  }

  /** Reject all in-flight REQs (socket close). */
  rejectAll(err: unknown): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}
