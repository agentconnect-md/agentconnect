/**
 * `RelayRoster` (shared-bot-relay.md §5) — computes the relay roster the daemons
 * dial and pushes hot updates.
 *
 * The roster is a CP-COMPUTED policy artifact derived from the durable `relay`
 * table (`listAlive` within the failover window), NOT from this pod's in-memory
 * connections — so any CP pod computes the same set, and future sharding is a
 * CP-only change (§17). `entries()` feeds `register/ok.relays` on a daemon
 * register; `broadcast()` fans a `relay/roster` EVT to every connected daemon
 * when a relay registers or is swept.
 */
import type { RelayRosterEntry } from '@agentconnect.md/protocol'
import type { RelayRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'

/** The C→D fan-out seam — `ControlSender` implements it. */
export interface RosterBroadcaster {
  broadcastRelayRoster(relays: RelayRosterEntry[]): void
}

export class RelayRoster {
  constructor(
    private readonly relays: RelayRepo,
    private readonly broadcaster: RosterBroadcaster,
    private readonly clock: Clock,
    /** Failover window: relays with no heartbeat within this are excluded. */
    private readonly staleMs: number
  ) {}

  /** The current roster — alive relays as `{ relayId, url }` (the per-instance daemonUrl). */
  async entries(): Promise<RelayRosterEntry[]> {
    const staleSince = new Date(this.clock.now() - this.staleMs)
    const alive = await this.relays.listAlive(staleSince)
    return alive.map((r) => ({ relayId: r.id, url: r.daemonUrl }))
  }

  /** Recompute the roster and fan a `relay/roster` EVT to every connected daemon. */
  async broadcast(): Promise<void> {
    this.broadcaster.broadcastRelayRoster(await this.entries())
  }
}
