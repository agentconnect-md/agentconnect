/**
 * `RelayRegistry` — the in-memory `relayId → connection` index the CP uses to
 * push C→R EVTs to connected relays (shared-bot-relay.md §9). The relay analogue
 * of the daemon-side {@link ConnectionRegistry}, and just as small: the roster is
 * computed from the durable `relay` table, so this exists ONLY to reach a live
 * relay socket (today: `rc/daemon-revoke`).
 *
 * The stored reference is the minimal {@link RelayChannel} firewall — never the
 * concrete `RelayConnection` — so this module has no cycle with `relay-connection.ts`.
 */
import type { RelayCpFrameType, RELAY_CP_SCHEMAS } from '@agentconnect.md/protocol'
import type { z } from 'zod'

/**
 * Raised by {@link RelayChannel.request} when the frame never reached the wire —
 * a socket past READY, or a transport that threw before writing. Nothing could
 * have been admitted, so the caller may safely ask another relay; every other
 * rejection means the frame WAS written and its answer was lost.
 */
export class RelayNotWritten extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayNotWritten'
  }
}

/** The minimal channel the registry / revoke-sender holds — no `ws` knowledge. */
export interface RelayChannel {
  readonly relayId: string
  /** The features this relay advertised on register (rc/register.features). */
  readonly features?: readonly string[]
  /** Fire-and-forget C→R EVT (e.g. `rc/daemon-revoke`). */
  send<T extends RelayCpFrameType>(type: T, payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>): void
  /** Correlated C→R REQ resolving with the relay's REP payload (e.g. `rc/hook-rerun`).
   *  Single-shot: it rejects on close, on an `error` REP, and on its deadline —
   *  it is never retransmitted, because its frames carry effects. A pre-write
   *  failure rejects with {@link RelayNotWritten}. Optional so a push-only
   *  stand-in still satisfies the firewall; a channel without it is never an
   *  RPC target. */
  request?<T extends RelayCpFrameType>(type: T, payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>): Promise<unknown>
  close(code: number, reason: string): void
}

export class RelayRegistry {
  private byRelay = new Map<string, RelayChannel>()

  add(ch: RelayChannel): void {
    this.byRelay.set(ch.relayId, ch)
  }

  get(relayId: string): RelayChannel | undefined {
    return this.byRelay.get(relayId)
  }

  /** Remove `ch` for `relayId` ONLY if it is still the registered one — a stale old
   *  socket's late close must not evict a freshly-superseded connection. */
  remove(relayId: string, ch: RelayChannel): void {
    if (this.byRelay.get(relayId) === ch) this.byRelay.delete(relayId)
  }

  /** Every connected relay — the fan-out target for a C→R broadcast. */
  all(): RelayChannel[] {
    return [...this.byRelay.values()]
  }
}
