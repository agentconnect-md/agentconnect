/**
 * `channel/agents` handler — the agent-collaboration directory lookup.
 *
 * A daemon-side agent tool asks "who else is in this channel?"; the daemon
 * forwards it as a `channel/agents` REQ. The CP is the ONLY authority for the
 * FULL roster (agents in one channel may run on different daemons), so it joins
 * the channel's active integrations to their agents and replies with their
 * public metadata (name / displayName / description / status). Metadata only —
 * never message content (§1/§12). Reply: `channel/agents/ok` (corr = req id).
 *
 * The roster is org-scoped to the REQUESTING daemon's org (resolved from its
 * authenticated `daemonId`) — a daemon can never enumerate another org's agents.
 *
 * SECURITY (§2.2/§6.1): `requesterAgentId` is derived by the daemon from the MCP
 * session context (never a tool input). Before returning anything, the CP verifies
 * the requester is ACTUALLY a member of the target (platform, channel) — a
 * non-member gets an empty roster, so an agent cannot probe an arbitrary (e.g.
 * private) channel it isn't in. The requester always sees itself; every peer is
 * revealed only when the requester's outbound policy admits the peer AND the
 * peer's inbound policy admits the requester. Discovery is the authorization
 * surface — non-callable peers are not leaked.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleChannelAgents: Handler = async (frame, conn, deps) => {
  if (!isFrame('channel/agents')(frame)) return
  const { platform, channel, requesterAgentId } = frame.payload

  const daemon = await deps.registry.get(DaemonId(conn.daemonId))
  if (!daemon) return // unknown daemon (should not happen post-auth) — drop silently

  const roster = await deps.integration.agentsInChannel(daemon.orgId, platform, channel)

  // Membership check: the requester must itself be in the target channel. This is
  // the roster's own membership set, so a non-member (probing an arbitrary/private
  // channel) sees nothing — fail closed with an empty roster.
  const requester = roster.find((a) => a.agentId === requesterAgentId)
  const visible = requester
    ? roster.filter(
        (a) =>
          a.agentId === requesterAgentId || // always see yourself
          ((requester.outboundPolicy === 'all' || requester.allowedTargetAgentIds.includes(a.agentId)) &&
            (a.callPolicy === 'all' || a.allowedCallerAgentIds.includes(requesterAgentId)))
      )
    : []

  conn.replyTo(frame, 'channel/agents/ok', {
    platform,
    channel,
    agents: visible.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      ...(a.displayName !== null ? { displayName: a.displayName } : {}),
      ...(a.description !== null ? { description: a.description } : {}),
      status: a.status
    }))
  })
}
