/**
 * `channel/agents` handler — the agent-collaboration peer directory lookup.
 *
 * A daemon-side agent tool asks "who can I talk to?"; the daemon forwards it as a
 * `channel/agents` REQ. The CP is the ONLY authority for the FULL roster (peers may
 * run on different daemons), so it replies with their public metadata (name /
 * displayName / description / status). Metadata only — never message content
 * (§1/§12). Reply: `channel/agents/ok` (corr = req id).
 *
 * TWO SCOPES, ONE ROSTER (see `agent-directory-org-scope-v1`): both scopes are the SAME
 * `AgentRepo.orgDirectory` read, behind the SAME org-scoped daemon-ownership bind, filtered
 * by the SAME {@link visibleToRequester} predicate — so they cannot disagree about whether a
 * given agent exists or may be called.
 *  - `channel` ABSENT → the ORG-WIDE directory. This is the default scope now that A2A
 *    delivery is postless (#854): a `sendMessage` with `toAgent` never posts, so the
 *    channel plays no part in DELIVERY and must not act as an authorization key either.
 *    Sessions with no IM integration (webchat, hook, dream, memory-only agents) have no
 *    channel the CP has ever seen, yet must still collaborate. The reply omits `channel`.
 *  - `channel` PRESENT → that same org roster INTERSECTED with the channel's membership
 *    (`IntegrationRepo.agentsInChannel`, used for its id set only). A FILTER on top of the
 *    org scope, never a wider grant. It is a literal intersection on purpose: reading the
 *    channel roster on its own would list an UNPLACED agent whose bot still sits in the
 *    channel (that query joins integrations, not placements), and `buildCollabSnapshot`
 *    drops daemonId-less rows from the `agents[]` that wakes are authorized against — so
 *    such an agent would be discoverable-but-uncallable, the state the design forbids.
 *
 * Authorization is the directional call policy alone, org-scoped to the REQUESTING
 * daemon's org (resolved from its authenticated `daemonId`) — a daemon can never
 * enumerate another org's agents, and a cross-org pair never resolves.
 * `Agent.visibility`/`sharedWith` is deliberately NOT consulted: it governs HUMAN
 * console access, so a `restricted` agent is still a discoverable, callable peer.
 *
 * SECURITY (§2.2/§6.1): `requesterAgentId` is derived by the daemon from the MCP session
 * context (never a tool input), but the CP still must not take the daemon's word for
 * WHICH agent is asking — see the daemon-ownership bind below, the read-side twin of the
 * relay's `claimedFromAgentId` check. On top of that {@link visibleToRequester} requires
 * the requester to appear in the roster it is asking about (fail closed), always shows it
 * itself, and reveals a peer only when the requester's outbound policy admits the peer AND
 * the peer's inbound policy admits the requester. Discovery is the authorization
 * surface — non-callable peers are not leaked. NOTE the one reply that passes NO bind: a
 * channel-filtered ask on a session-identity platform short-circuits to an empty roster
 * before any repo read (see below) — nothing to leak, so nothing to bind.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import { isSessionIdentityPlatform } from '../../persistence/platform.js'
import type { ChannelAgentRecord } from '../../persistence/ports.js'
import type { Handler } from './index.js'

/**
 * The roster visibility filter — the SINGLE authorization predicate, shared verbatim
 * by the org-wide and channel-filtered scopes so the two can never drift.
 *
 * `roster` is always already org-scoped by its query, which is how "cross-org never
 * resolves" is enforced: a foreign requester simply is not in it, and a missing
 * requester fails CLOSED (empty roster) rather than defaulting to open.
 */
export function visibleToRequester<T extends ChannelAgentRecord>(roster: T[], requesterAgentId: string): T[] {
  const requester = roster.find((a) => a.agentId === requesterAgentId)
  if (!requester) return []
  return roster.filter(
    (a) =>
      // Always see yourself: an agent with outboundPolicy 'selected' does not normally
      // list itself in its own allow-list, yet must still appear in its own listing.
      a.agentId === requesterAgentId ||
      ((requester.outboundPolicy === 'all' || requester.allowedTargetAgentIds.includes(a.agentId)) &&
        (a.callPolicy === 'all' || a.allowedCallerAgentIds.includes(requesterAgentId)))
  )
}

export const handleChannelAgents: Handler = async (frame, conn, deps) => {
  if (!isFrame('channel/agents')(frame)) return
  const { platform, channel, requesterAgentId } = frame.payload

  const daemon = await deps.registry.get(DaemonId(conn.daemonId))
  if (!daemon) return // unknown daemon (should not happen post-auth) — drop silently

  const roster: ChannelAgentRecord[] = await (async () => {
    // A session-identity platform (`webchat`/`hook`/`dream`) has no persisted
    // integration, so `toDbPlatform` rejects it by design and a repo call would
    // throw — which `ws/connection.ts` turns into close(1011), killing the control
    // socket. Short-circuit BEFORE persistence: reaching the repo with one of these
    // is now impossible by construction, and the correct answer is an EMPTY roster
    // rather than an exception, because such a channel has no CP-side identity to
    // enumerate members of at all. (Channel-free callers send no channel and land
    // in the org-wide scope below.)
    if (channel !== undefined && isSessionIdentityPlatform(platform)) return []

    // ONE org-scoped read, feeding both scopes and the bind (see the header). It is also
    // literally the read `buildCollabSnapshot` builds `agents[]` from, which is what keeps
    // "discoverable" and "callable" from disagreeing.
    const orgRoster = await deps.agent.orgDirectory(daemon.orgId)

    // THE DAEMON-OWNERSHIP BIND (§2.2/§6.1) — the read-side twin of the relay's
    // `claimedFromAgentId` / `caller.daemonId !== fromDaemonId` check. `requesterAgentId`
    // arrives from the daemon, so without this a daemon could name ANY agent of its org and
    // read that agent's policy-filtered peer directory. Binding off `orgRoster` makes the
    // check org-scoped for free: a foreign-org requester is simply absent from it, so it is
    // refused HERE rather than by the downstream filter. Fail CLOSED (empty roster, never an
    // error) so a forged id is indistinguishable from an agent nobody may call.
    //
    // What it does and does NOT buy. It is an INTEGRITY control: only the daemon the CP
    // places an agent on may speak as that agent, and it is the exclusive protection for the
    // fields only this reply carries — `description` (the peer's system-prompt seed) and
    // live `status`. It is NOT a confidentiality boundary for the policy graph: the CP pushes
    // the whole flat org directory (ids, daemonIds, names and all four policy fields) to
    // EVERY daemon in the org as `register/ok.collabRoutes` / `collaboration/routes`, because
    // terminal-verify needs it, so a daemon can compute any org agent's policy-filtered peer
    // set locally without asking. Narrowing that push to the peers a daemon actually needs is
    // a follow-up (§2.7); until then do not write "this makes `callPolicy: 'selected'`
    // unreadable" here, because it does not.
    //
    // Consequence during an agent MOVE: the CP row may already name the TARGET daemon while
    // the source daemon still holds a session, and such an ask is refused. Correct, and in
    // practice near-unreachable — `AgentMoveService` takes the move only when the source is
    // idle and detaches it before the placement CAS — so treat this as fail-closed
    // belt-and-braces, not a window anything depends on.
    const requester = orgRoster.find((a) => a.agentId === requesterAgentId)
    if (requester?.daemonId !== conn.daemonId) return [] // null/undefined never equals a daemonId

    if (channel === undefined) return orgRoster
    // The channel scope is a literal INTERSECTION: `agentsInChannel` supplies the membership
    // id set, the org roster supplies the records (and the placement filter).
    const inChannel = new Set(
      (await deps.integration.agentsInChannel(daemon.orgId, platform, channel)).map((a) => a.agentId)
    )
    return orgRoster.filter((a) => inChannel.has(a.agentId))
  })()

  const visible = visibleToRequester(roster, requesterAgentId)

  conn.replyTo(frame, 'channel/agents/ok', {
    platform,
    // Echo the scope back: absent channel ⇒ the org-wide directory.
    ...(channel !== undefined ? { channel } : {}),
    agents: visible.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      ...(a.displayName !== null ? { displayName: a.displayName } : {}),
      ...(a.description !== null ? { description: a.description } : {}),
      status: a.status
    }))
  })
}
