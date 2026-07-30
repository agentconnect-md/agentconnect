/**
 * `routeAgentMsg` — the relay's `rd/agentmsg` routing + authorization (agent-collaboration
 * §2.3 / §6.2 / §6.4). The security-critical seam: it turns an UNTRUSTED cross-daemon
 * agent-call into a TRUSTED forward, or a typed NAK.
 *
 * Steps (§2.5 / §6.2):
 *  a) bind the request to the socket's AUTHENTICATED `fromDaemonId` (passed in — never
 *     the frame's `claimedFromAgentId`);
 *  b) validate `claimedFromAgentId` actually belongs to that daemon AND is in the
 *     `(platform, channel)` via the collaboration snapshot (a forged claim → reject);
 *  c) resolve the TARGET `toAgentId` in the SAME org/channel → owning daemonId (the
 *     bot-agnostic fix: target may be on a different bot but same channel);
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
import type { RdAgentMsg, RdAgentMsgAck, RdAgentMsgReason } from '@agentconnect.md/protocol'
import type { CollaborationRouter } from './collaboration-router.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'
import type { Logger } from './log.js'

/** Cap on agent→agent hop depth (agent-collaboration §2.4) — mirrors the daemon. */
const MAX_AGENT_CALL_HOPS = 8

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
    const { platform, channel } = msg.coords

    // (b) Validate the UNTRUSTED claimedFromAgentId: it must resolve to a channel member
    // whose placement is owned by the AUTHENTICATED sending daemon. Bind org from the
    // caller's own placement (the frame carries no org — cross-org can't share a row).
    const orgId = router.channelOrgFor(platform, channel, msg.claimedFromAgentId)
    const caller = orgId ? router.resolve(orgId, platform, channel, msg.claimedFromAgentId) : undefined
    if (!orgId || !caller || caller.daemonId !== fromDaemonId) {
      deps.log.warn(
        `relay: rd/agentmsg rejected — forged/unknown caller ${msg.claimedFromAgentId} on daemon ${fromDaemonId}`
      )
      return nak(msg.deliveryId, 'not_allowed')
    }

    // (c) Resolve the TARGET in the SAME org/channel (bot-agnostic). Not there ⇒ not_found.
    const target = router.resolve(orgId, platform, channel, msg.toAgentId)
    if (!target) return nak(msg.deliveryId, 'not_found')

    // (d) Directional policy: A→B requires caller A to admit B and target B to
    // admit A. A guessed/stale target id therefore cannot bypass the directory.
    if (caller.outboundPolicy === 'selected' && !caller.allowedTargetAgentIds.includes(msg.toAgentId)) {
      deps.log.info(
        `relay: rd/agentmsg not_allowed — ${msg.claimedFromAgentId} outbound policy excludes ${msg.toAgentId}`
      )
      return nak(msg.deliveryId, 'not_allowed')
    }
    if (target.callPolicy === 'selected' && !target.allowedCallerAgentIds.includes(msg.claimedFromAgentId)) {
      deps.log.info(`relay: rd/agentmsg not_allowed — ${msg.claimedFromAgentId} → ${msg.toAgentId} (target selected)`)
      return nak(msg.deliveryId, 'not_allowed')
    }

    // (e) Hop increment + cap (§2.4).
    const hopCount = msg.hopCount + 1
    if (hopCount > MAX_AGENT_CALL_HOPS) return nak(msg.deliveryId, 'hop_limit')

    // (f) Resolve the owning daemon connection and forward with a TRUSTED caller claim.
    const conn = deps.daemons()?.get(target.daemonId)
    if (!conn) return nak(msg.deliveryId, 'offline')

    try {
      return await conn.forwardAgentMsg({
        trustedFromAgentId: msg.claimedFromAgentId, // now VALIDATED — the target may trust it
        orgId,
        toAgentId: msg.toAgentId,
        ...(target.integrationId !== undefined ? { integrationId: target.integrationId } : {}),
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
        // §5.4 report-back request, forwarded opaquely for the same reason: it is an instruction
        // about the caller's OWN lineage, so the relay carries it without minting or validating it.
        ...(msg.needsReply !== undefined ? { needsReply: msg.needsReply } : {}),
        // session-visibility.md §5.1 privacy hint — again the caller's own fact
        // about its own lineage, forwarded verbatim. The relay stores nothing.
        ...(msg.parentPrivate !== undefined ? { parentPrivate: msg.parentPrivate } : {})
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
