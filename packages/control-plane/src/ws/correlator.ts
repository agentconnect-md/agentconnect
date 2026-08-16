/**
 * `ReqRep` — request/reply correlation + retransmit (design §4.5, protocol §4.3).
 *
 * Holds an `id → pending` map for CP-issued REQs (`route/assign`,
 * `agent/launch`, `daemon/drain`, …). On timeout it retransmits the **same `id`**
 * up to `maxTries`, all driven by the injected `Clock` so retries are
 * deterministic in tests (advance the FakeClock by `ackTimeoutMs`). Whether a
 * retransmit is safe to apply twice is the receiving handler's concern, not
 * something this correlator guarantees. `settle(rep)` resolves on a correlated
 * REP and rejects with a {@link ProtocolError} on a correlated `error` frame.
 *
 * Phase 2 only needs `settle` wired (auth/register are CP REPLIES, not REQs);
 * the `request` path is exercised in Phase 3, but is implemented here so the
 * connection FSM routes REPs through one place.
 */
import { encode, type AnyFrame } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { ProtocolError } from '../domain/errors.js'

interface Pending {
  id: string
  /** The REQ as issued — a correlated reply is fenced against its type and org (frame-scope). */
  request: { type: string; orgId?: string | undefined }
  encoded: string
  resolve: (frame: AnyFrame) => void
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

export class ReqRep {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly clock: Clock,
    private readonly ackTimeoutMs: number,
    private readonly maxTries = 5
  ) {}

  /**
   * Send a REQ envelope via `write` and await its correlated REP. Retransmits
   * the identical bytes on each `ackTimeoutMs` lapse until a REP/error arrives
   * or `maxTries` is exhausted (then rejects with INTERNAL).
   */
  request(frame: AnyFrame, write: (encoded: string) => void, opts: RequestOpts = {}): Promise<AnyFrame> {
    const encoded = encode(frame)
    return new Promise<AnyFrame>((resolve, reject) => {
      const entry: Pending = {
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

  private arm(entry: Pending, write: (encoded: string) => void, ackTimeoutMs: number): void {
    entry.timer = this.clock.setTimeout(() => {
      if (!this.pending.has(entry.id)) return
      if (entry.tries >= entry.maxTries) {
        this.pending.delete(entry.id)
        entry.reject(new ProtocolError('INTERNAL', `no ack after ${entry.maxTries} tries for ${entry.id}`))
        return
      }
      entry.tries += 1
      this.arm(entry, write, ackTimeoutMs) // re-arm BEFORE re-send (deterministic ordering)
      write(entry.encoded) // identical id + seq → idempotent (protocol §4.3)
    }, ackTimeoutMs)
  }

  /**
   * Settle the pending REQ a REP/error correlates to (`frame.corr` === REQ id).
   * Returns true if it matched a pending entry (so the FSM knows not to dispatch
   * it as a fresh inbound frame).
   */
  settle(frame: AnyFrame): boolean {
    const corr = frame.corr
    if (!corr) return false
    if (frame.type === 'error') return this.reject(corr, ProtocolError.fromFrame(frame.payload))
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
