/**
 * `routeAgentMsg` — the relay's `rd/agentmsg` routing + authorization (agent-collaboration
 * §2.3 / §6.2 / §6.4). The security-critical seam: it turns an UNTRUSTED cross-daemon
 * agent-call into a TRUSTED forward, or a typed NAK.
 *
 * Steps (§2.5 / §6.2):
 *  a) bind the request to the socket's AUTHENTICATED `fromDaemonId` (passed in — never
 *     the frame's `claimedFromAgentId`);
 *  b) validate `claimedFromAgentId` actually belongs to that daemon via the org-scoped
 *     collaboration directory (a forged claim → reject);
 *  b2) verify the INTEGRITY of the asserted `msg.coords`: if the snapshot knows any
 *     membership at that (org, channel id) — under ANY platform, since the woken session's
 *     key is computed from a narrowed platform — the caller must be a member of one of
 *     them. Membership no longer AUTHORIZES the call, but `coords` is still the woken
 *     peer's session key, so an unchecked assertion would let a caller resume a session in
 *     a channel it cannot reach. An UNKNOWN coordinate on a persisted IM platform fails
 *     CLOSED; an unknown one on a channel-free platform (webchat/dream) is admitted and the
 *     TARGET daemon keys the woken session off the trusted caller instead;
 *  c) resolve the TARGET `toAgentId` in the SAME org → owning daemonId. Channel-free:
 *     A2A delivery is postless, so caller and target need share no channel (and an
 *     integration-less peer has none). `msg.coords` still rides along as the DELIVERY
 *     coordinate for the woken session, not as an authorization input;
 *  d) check the caller's outbound policy AND the target's inbound policy
 *     (cross-org / either denial → typed NAK);
 *  e) increment hopCount (inbound+1, cap 8, §2.4);
 *  f) forward `rd/agentmsg/fwd` with a TRUSTED caller claim (trustedFromAgentId + org/
 *     channel assertion) to the owning daemon and relay its admission verdict back.
 *
 * Per-hop dedup on the stable `deliveryId` (§6.4): a retransmit of the same deliveryId
 * replays the prior verdict without a second forward (no double-wake).
 *
 * FOLLOW-UP (P2 scope-down): retransmit/retry is NOT implemented — this is ACK/NAK +
 * per-hop dedup + the 5s correlator timeout (the forward's `rd/agentmsg/fwd` inherits
 * the connection's ACK_TIMEOUT_MS). Documented in the PR description.
 */
import {
  MAX_AGENT_CALL_HOPS,
  RD_HEADLESS_AGENT_DELIVERY_V1,
  type RdAgentMsg,
  type RdAgentMsgAck,
  type RdAgentMsgReason
} from '@agentconnect.md/protocol'
import type { CollaborationRouter } from './collaboration-router.js'
import { inboundAdmits, outboundAdmits } from './collaboration-router.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { Logger } from './log.js'

export interface AgentMsgRouterDeps {
  router: CollaborationRouter
  daemons: () => RelayDaemonServer | undefined
  log: Logger
}

export function createAgentMsgRouter(deps: AgentMsgRouterDeps) {
  // Per-hop dedup (§6.4): deliveryId → the verdict we already returned.
  const seen = new Map<string, RdAgentMsgAck>()

  function nak(deliveryId: string, reason: RdAgentMsgReason): RdAgentMsgAck {
    return { deliveryId, delivered: false, reason }
  }

  return async function routeAgentMsg(fromDaemonId: string, msg: RdAgentMsg): Promise<RdAgentMsgAck> {
    // Namespace the dedup key by the AUTHENTICATED source daemon: `deliveryId` is only
    // unique within one daemon process (it's `String(Date.now())`), so two independent
    // source daemons routinely mint the same millisecond value. A bare-deliveryId key
    // would let daemon B's call collide with an unrelated prior call from daemon A.
    const dedupKey = `${fromDaemonId}:${msg.deliveryId}`
    const prior = seen.get(dedupKey)
    if (prior) {
      deps.log.debug(`relay: rd/agentmsg dup ${dedupKey} — replaying verdict`)
      return prior
    }

    const verdict = await route(fromDaemonId, msg)
    if (seen.size >= 4000) seen.clear() // bound the dedup window
    seen.set(dedupKey, verdict)
    return verdict
  }

  async function route(fromDaemonId: string, msg: RdAgentMsg): Promise<RdAgentMsgAck> {
    const { router } = deps
    // (b) Validate the UNTRUSTED claimedFromAgentId against the ORG-SCOPED directory: the
    // claimed id must exist and its placement must be owned by the AUTHENTICATED sending
    // daemon — that daemon-ownership check, not channel membership, is what makes the claim
    // unforgeable. Org is bound from the caller's own entry (the frame carries no org).
    const caller = router.agent(msg.claimedFromAgentId)
    if (!caller || caller.daemonId !== fromDaemonId) {
      deps.log.warn(
        `relay: rd/agentmsg rejected — forged/unknown caller ${msg.claimedFromAgentId} on daemon ${fromDaemonId}`
      )
      return nak(msg.deliveryId, 'not_allowed')
    }
    const orgId = caller.orgId

    // (b2) COORDINATE INTEGRITY. Channel is no longer an authorization key, but it is still
    // the DELIVERY coordinate the target daemon derives the woken session's key from — so an
    // unchecked `coords` lets a caller name a channel it cannot reach and RESUME the target's
    // existing session there (with `needsReply`, reading that conversation back into its own).
    // Same threat model as the `caller.daemonId !== fromDaemonId` check above: a compromised or
    // buggy source daemon asserting something the relay is the only one able to falsify.
    // ONE decision (see CollaborationRouter.coordsDecision): a KNOWN coordinate demands
    // membership; an UNKNOWN one on a PERSISTED IM platform fails CLOSED, because an
    // unrecorded Slack/Telegram/Discord/Feishu conversation — a DM whose row this snapshot
    // has not caught up with, a channel the bot left, an id the caller simply guessed — is
    // precisely how a caller aliases an existing platform session; an UNKNOWN one on a
    // channel-free platform is admitted, and the TARGET DAEMON (not the relay) replaces the
    // asserted channel with a caller-derived one when it mints the session key. The relay
    // therefore forwards `coords` verbatim and acts only on `reject`.
    // A LINEAGE REPLY (§5.3, `lineageReplyTo`) is exempt from this gate: it never keys or
    // creates a session from `coords` — the TARGET daemon dispatches into the exact session
    // named by the high-entropy id and terminally validates possession + ownership — so the
    // aliasing threat the gate closes is absent, and membership would wrongly reject a
    // replier that does not share the origin's channel (an explicitly supported org-scoped
    // case). Org membership (c), directional policy (d), and the hop cap (e) still apply.
    if (
      msg.lineageReplyTo === undefined &&
      router.coordsDecision(orgId, msg.coords.platform, msg.coords.channel, msg.claimedFromAgentId).verdict === 'reject'
    ) {
      deps.log.warn(
        `relay: rd/agentmsg not_allowed — ${msg.claimedFromAgentId} may not assert coords ${msg.coords.platform}:${msg.coords.channel}`
      )
      return nak(msg.deliveryId, 'not_allowed')
    }

    // (c) Resolve the TARGET in the SAME org, channel-free: A2A delivery is postless, so a
    // shared channel is neither required nor evidence of anything. Absent/cross-org ⇒ not_found
    // (cross-org is indistinguishable from nonexistent by design — no cross-org probing).
    const target = router.agent(msg.toAgentId)
    if (!target || target.orgId !== orgId) return nak(msg.deliveryId, 'not_found')

    // (d) Directional policy: A→B requires caller A to admit B and target B to
    // admit A. A guessed/stale target id therefore cannot bypass the directory.
    // Kept as two explicit checks rather than router.admits() so each denial keeps its
    // own log line (the reason an operator can tell the two directions apart).
    if (!outboundAdmits(caller, msg.toAgentId)) {
      deps.log.info(
        `relay: rd/agentmsg not_allowed — ${msg.claimedFromAgentId} outbound policy excludes ${msg.toAgentId}`
      )
      return nak(msg.deliveryId, 'not_allowed')
    }
    if (!inboundAdmits(target, msg.claimedFromAgentId)) {
      deps.log.info(`relay: rd/agentmsg not_allowed — ${msg.claimedFromAgentId} → ${msg.toAgentId} (target selected)`)
      return nak(msg.deliveryId, 'not_allowed')
    }

    // (e) Hop increment + cap (§2.4).
    const hopCount = msg.hopCount + 1
    if (hopCount > MAX_AGENT_CALL_HOPS) return nak(msg.deliveryId, 'hop_limit')

    // (f) Resolve the owning daemon connection and forward with a TRUSTED caller claim.
    const conn = deps.daemons()?.get(target.daemonId)
    if (!conn) return nak(msg.deliveryId, 'offline')

    // (f0) send-message-routing-rework.md §8.4 — capability gate for a REQUIRED-HEADLESS
    // delivery. A `session-reply` must resume the parent SILENTLY (§7); a daemon too old
    // to do that would instead publish the parent's whole ordinary response into its
    // channel. That is precisely the behavior the design removes, so the reply is REFUSED
    // — `unsupported`, distinct from `offline` because the target is reachable and the
    // caller can act on the difference — rather than silently degraded.
    if (msg.deliveryKind === 'session-reply' && !conn.supports(RD_HEADLESS_AGENT_DELIVERY_V1)) {
      deps.log.warn(
        `relay: rd/agentmsg refused — daemon ${target.daemonId} does not support ${RD_HEADLESS_AGENT_DELIVERY_V1}; ` +
          `a session reply must not be downgraded to visible IM output`
      )
      return nak(msg.deliveryId, 'unsupported')
    }

    // Delivery detail, NOT authorization: the DEFINITE reply integration (§6.2). The same
    // agent can reach two channels via two different bots, so prefer its placement in the
    // coords channel and fall back to the directory entry when it has no row there (an
    // integration-less peer legitimately has none).
    const { platform, channel } = msg.coords
    const integrationId = router.resolve(orgId, platform, channel, msg.toAgentId)?.integrationId ?? target.integrationId

    try {
      return await conn.forwardAgentMsg({
        trustedFromAgentId: msg.claimedFromAgentId, // now VALIDATED — the target may trust it
        orgId,
        toAgentId: msg.toAgentId,
        ...(integrationId !== undefined ? { integrationId } : {}),
        text: msg.text,
        coords: msg.coords,
        ...(msg.correlationId !== undefined ? { correlationId: msg.correlationId } : {}),
        hopCount,
        deliveryId: msg.deliveryId,
        // Visible-post ts (if any), forwarded opaquely so the target can dedup the wake against
        // the post it fetches from the shared thread.
        ...(msg.transcriptTs !== undefined ? { transcriptTs: msg.transcriptTs } : {}),
        // Origin lineage (session-concept §5.3) is the caller's own, forwarded opaquely —
        // the relay neither mints nor validates it; it only lets the woken child reply back.
        ...(msg.originSessionId !== undefined ? { originSessionId: msg.originSessionId } : {}),
        ...(msg.originCoords !== undefined ? { originCoords: msg.originCoords } : {}),
        ...(msg.externalOrigin !== undefined ? { externalOrigin: msg.externalOrigin } : {}),
        // §5.3 lineage reply target — opaque to the relay; the TARGET daemon terminally
        // validates it. Coordinate integrity above still applied to `coords` unchanged.
        ...(msg.lineageReplyTo !== undefined ? { lineageReplyTo: msg.lineageReplyTo } : {}),
        // §5.4 report-back request, forwarded opaquely for the same reason: it is an instruction
        // about the caller's OWN lineage, so the relay carries it without minting or validating it.
        ...(msg.needsReply !== undefined ? { needsReply: msg.needsReply } : {}),
        // session-visibility.md §5.1 privacy hint — again the caller's own fact
        // about its own lineage, forwarded verbatim. The relay stores nothing.
        ...(msg.parentPrivate !== undefined ? { parentPrivate: msg.parentPrivate } : {}),
        // §8.3: forwarded so the TARGET applies the same required-headless contract the
        // same-daemon path applies locally. The capability check above already ran, so a
        // target receiving `session-reply` is known to be able to honor it.
        ...(msg.deliveryKind !== undefined ? { deliveryKind: msg.deliveryKind } : {})
      })
    } catch (err) {
      // Forward timed out / socket dropped mid-flight → treat as offline (retransmit is
      // a follow-up). The source's dedup cache still holds this verdict.
      deps.log.warn(`relay: rd/agentmsg forward to ${target.daemonId} failed: ${(err as Error).message}`)
      return nak(msg.deliveryId, 'offline')
    }
  }
}

export type RouteAgentMsg = ReturnType<typeof createAgentMsgRouter>
