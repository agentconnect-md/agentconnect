/**
 * `RelayControlSender` — the CP→relay control fan-out (shared-bot-relay.md §9).
 *
 * The mirror of `ControlSender.broadcastRelayRoster` but the OTHER direction: that
 * fans `relay/roster` to daemons (via `connReg`); this fans `rc/daemon-revoke` and
 * the compiled hook rules (`rc/hook-assign` / `rc/hook-remove`, pool-wide —
 * webhook-type ingress is pool-served) to relays (via {@link RelayRegistry}).
 * Kept off `RelayRegistry` itself so the wire (frame building) stays out of the
 * connection index.
 *
 * Fire-and-forget + per-socket isolated: a dead relay socket's error is swallowed
 * (its close removes it from the registry).
 */
import type {
  RcHookAssign,
  RcCollabRoutes,
  RcMcpAssign,
  RcMcpUnassign,
  RcMemoryConnectionAssign,
  RcMemoryConnectionUnassign
} from '@agentconnect.md/protocol'
import { GITLAB_COM_V1_FEATURE } from '@agentconnect.md/protocol'
import type { RelayChannel, RelayRegistry } from '../ws/relay-registry.js'

export class RelayControlSender {
  constructor(private readonly relays: RelayRegistry) {}

  /**
   * Tell every connected relay to immediately drop `daemonId`'s connection and
   * stop routing to it (a key revoke / daemon removal — §9 revocation loop). The relay
   * re-verifies on the daemon's next `rd/hello`, so a daemon with another still-valid
   * key simply reconnects; a fully-removed daemon stays out.
   */
  daemonRevoke(daemonId: string): void {
    this.broadcast((ch) => ch.send('rc/daemon-revoke', { daemonId }))
  }

  /** Upsert one compiled hook rule on every connected relay (the frame is NEVER
   *  logged — it carries the hook's hmacSecret). A gitlab rule goes only to
   *  relays advertising the feature: the widened `kind` is frame-fatal on an
   *  older relay's decoder (§17.3), so gating here IS the negotiation. */
  hookAssign(rule: RcHookAssign): void {
    this.broadcast((ch) => {
      if (rule.kind === 'gitlab' && !ch.features?.includes(GITLAB_COM_V1_FEATURE)) return
      ch.send('rc/hook-assign', rule)
    })
  }

  /** Drop one hook rule pool-wide (hook disabled / deleted / agent unplaced). */
  hookRemove(hookId: string): void {
    this.broadcast((ch) => ch.send('rc/hook-remove', { hookId }))
  }

  /** Load an MCP provider's proxy binding onto every relay (whole-pool BROADCAST —
   *  any relay may serve the agent's HTTPS request). `headers` carry the UPSTREAM
   *  credential — the frame is NEVER logged (centralized-tool-management.md §5.2). */
  mcpAssign(a: RcMcpAssign): void {
    this.broadcast((ch) => ch.send('rc/mcp-assign', a))
  }

  /** Drop an MCP proxy binding pool-wide: whole provider (`{providerId}`) or a single
   *  retired grant hash (`{providerId, grantKeyHash}`). */
  mcpUnassign(u: RcMcpUnassign): void {
    this.broadcast((ch) => ch.send('rc/mcp-unassign', u))
  }

  /** Purpose-separated external-memory proxy binding (upstream-secret-bearing). */
  memoryConnectionAssign(a: RcMemoryConnectionAssign): void {
    this.broadcast((ch) => ch.send('rc/memoryconnection-assign', a))
  }

  memoryConnectionUnassign(u: RcMemoryConnectionUnassign): void {
    this.broadcast((ch) => ch.send('rc/memoryconnection-unassign', u))
  }

  /** Ship one org's bot-agnostic collaboration routing snapshot to EVERY relay
   *  (agent-collaboration §2.3/§6.2). FULL-REPLACE per (orgId) — the relay merges the
   *  org's channels into its table. Pool-wide: any relay may route any org's agent-call.
   *  Bodiless routing/policy metadata. */
  collabRoutes(snapshot: RcCollabRoutes): void {
    this.broadcast((ch) => ch.send('rc/collab-routes', snapshot))
  }

  /** Ship one org's collaboration snapshot to a SINGLE relay channel (on its (re)register
   *  — the reconnect baseline). */
  collabRoutesTo(ch: RelayChannel, snapshot: RcCollabRoutes): void {
    try {
      ch.send('rc/collab-routes', snapshot)
    } catch {
      // dead socket — its onClose removes it from the registry
    }
  }

  private broadcast(send: (ch: RelayChannel) => void): void {
    for (const ch of this.relays.all()) {
      try {
        send(ch)
      } catch {
        // dead socket — its onClose removes it from the registry
      }
    }
  }
}
