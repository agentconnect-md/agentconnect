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
 * (its close removes it from the registry). The one exception is {@link
 * RelayControlSender.hookRerun}, which AWAITS a correlated admission — a console
 * action must not report success for a frame that merely reached a socket.
 */
import type {
  RcHookAssign,
  RcHookRerun,
  RcHookRerunRefusal,
  RcCollabRoutes,
  RcMcpAssign,
  RcMcpUnassign,
  RcMemoryConnectionAssign,
  RcMemoryConnectionUnassign
} from '@agentconnect.md/protocol'
import { GITLAB_RERUN_V1_FEATURE, RcHookRerunResult } from '@agentconnect.md/protocol'
import { advertises, requiredGitlabFeatures, requiredGitlabInstanceFeatures } from '../domain/daemon-features.js'

/** What one Console rerun attempt achieved across the eligible relay pool. */
export type RelayRerunOutcome =
  | { kind: 'admitted' }
  /** The relay that answered definitively declined; nothing ran, anywhere. */
  | { kind: 'refused'; code: RcHookRerunRefusal }
  /** A relay went quiet mid-request: the turn may or may not have started. */
  | { kind: 'ambiguous' }
  /** No connected relay could be asked (none eligible, or none reachable). */
  | { kind: 'unreachable' }
import { RelayNotWritten } from '../ws/relay-registry.js'
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
   *  older relay's decoder (§17.3), so gating here IS the negotiation. A rule on a
   *  self-managed host needs the §24.4 bit too — a relay without it would forward
   *  metadata missing the fence host. */
  hookAssign(rule: RcHookAssign): void {
    this.broadcast((ch) => {
      if (rule.kind === 'gitlab' && !advertises(ch.features, requiredGitlabFeatures(rule.gitlab?.host))) return
      ch.send('rc/hook-assign', rule)
    })
  }

  /** Drop one hook rule pool-wide (hook disabled / deleted / agent unplaced). */
  hookRemove(hookId: string): void {
    this.broadcast((ch) => ch.send('rc/hook-remove', { hookId }))
  }

  /**
   * Hand ONE gitlab rerun to ONE relay (§16.1) and wait for its verdict.
   * Reaching a socket proves nothing: only a relay that answers `admitted` has
   * queued a turn and opened a run row, so the console is told "started" on that
   * REP alone.
   *
   * THE FIRST ANSWERED VERDICT IS FINAL — refusals included. Relay rule tables
   * converge independently, so a peer asked after a refusal may still hold the
   * pre-disable or pre-bump replica and would dispatch under authority this one
   * already revoked; and walking past `limiter_exhausted` would turn a per-hook
   * budget into a pool-wide walk. An ambiguous failure stops for the older
   * reason: the frame was written, so a turn may already have started.
   *
   * The walk therefore only skips relays that could not answer at all —
   * ineligible (`gitlab-rerun-v1`; `gitlab-com-v1` predates the frame and its
   * holder cannot decode it, §17.3) or unreachable before the frame was written.
   *
   * §24.4 adds the host to that eligibility, not just to the frame: a relay denied the
   * self-managed RULE holds none, so asking it would collect a `replay_pending` refusal —
   * and the first answered verdict is final, so that refusal would end the walk before an
   * eligible peer was ever asked.
   */
  async hookRerun(rerun: RcHookRerun): Promise<RelayRerunOutcome> {
    const required = [GITLAB_RERUN_V1_FEATURE, ...requiredGitlabInstanceFeatures(rerun.gitlab.host)]
    for (const ch of this.relays.all()) {
      if (!advertises(ch.features, required) || typeof ch.request !== 'function') continue
      let result: RcHookRerunResult
      try {
        result = RcHookRerunResult.parse(await ch.request('rc/hook-rerun', rerun))
      } catch (e) {
        // Nothing reached the wire, so nothing could have been admitted here.
        if (e instanceof RelayNotWritten) continue
        return { kind: 'ambiguous' }
      }
      return result.admitted ? { kind: 'admitted' } : { kind: 'refused', code: result.code }
    }
    return { kind: 'unreachable' }
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
