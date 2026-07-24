/**
 * `RelayManager` — set-converges the daemon's relay dial-out connections to the
 * roster the CP publishes (shared-bot-relay.md §5, §11). Mirrors the CP-driven
 * `cp-*-registry` converge shape, but — unlike the disk registries — it DOES prune:
 * a relay dropped from the roster (swept / rolled) has its socket torn down.
 *
 * The roster arrives two ways, both funnelling here: the `register/ok.relays`
 * reconcile snapshot on every (re)connect, and the hot `relay/roster` EVT. The
 * daemon only does set-convergence — it never assumes the roster is the full relay
 * fleet — so future CP-side sharding is a CP-only change (§17 invariant).
 */
import type { RelayRosterEntry, RdAgentMsg, RdAgentMsgAck } from '@agentconnect.md/protocol'
import { RelayClient, type RelayClientDeps } from './relay-client.js'

export class RelayManager {
  private readonly clients = new Map<string, RelayClient>() // keyed by relayId

  constructor(private readonly deps: RelayClientDeps) {}

  /**
   * Converge to EXACTLY `roster`: stop clients for relays no longer present (or whose
   * url moved), and start a dial loop for newly-listed relays. Idempotent — re-applying
   * the same roster is a no-op.
   */
  converge(roster: RelayRosterEntry[]): void {
    const desired = new Map(roster.map((r) => [r.relayId, r.url]))
    // Remove: gone from the roster, or the same relayId now advertises a different url.
    for (const [relayId, client] of this.clients) {
      if (desired.get(relayId) !== client.url) {
        void client.stop()
        this.clients.delete(relayId)
      }
    }
    // Add: relays we're not yet dialing.
    for (const { relayId, url } of roster) {
      if (this.clients.has(relayId)) continue
      const client = new RelayClient(relayId, url, this.deps)
      this.clients.set(relayId, client)
      client.start()
    }
  }

  /** Tear down every relay connection (daemon shutdown). */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.stop()))
    this.clients.clear()
  }

  /** Number of relays currently being dialed (observability / tests). */
  size(): number {
    return this.clients.size
  }

  /**
   * Send a cross-daemon agent-call over ANY READY relay (agent-collaboration §2.3/§6.4).
   * The all-to-all roster means any relay this daemon holds can route the call to the
   * target's owning daemon via the CP's collaboration snapshot — so we pick the first
   * READY client. Throws if none is READY (the caller reports the call undeliverable).
   */
  async sendAgentMsg(payload: RdAgentMsg): Promise<RdAgentMsgAck> {
    for (const client of this.clients.values()) {
      if (client.isReady()) return client.sendAgentMsg(payload)
    }
    throw new Error('no READY relay to route agent-call')
  }
}
