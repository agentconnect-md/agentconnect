/**
 * `buildCollabSnapshot` — assemble the bot-AGNOSTIC collaboration routing snapshot
 * (agent-collaboration §2.3/§6.2) from an org's channel placements. Groups the flat
 * placement records into per-channel `CollabChannelRoute`s, dropping unplaced agents
 * (no daemonId ⇒ not routable), plus the FLAT org-scoped `agents[]` directory built
 * from `orgAgents` — the only carrier for an agent that has no IM integration and so
 * appears in no channel at all. Bodiless routing/policy metadata only.
 *
 * The SAME snapshot is shipped to the relay (`rc/collab-routes`, full org) and to a
 * daemon (`register/ok.collabRoutes` / `collaboration/routes` EVT). The daemon copy is
 * the terminal-verify source for REMOTE callers (§2.5 #4).
 *
 * FOLLOW-UP (P2 scope-down, §6.5): `generation` is a plain counter passed by the
 * caller; per-entry tombstone / TTL / fail-closed-on-stale is not implemented.
 */
import type { CollabRoutesSnapshot, CollabChannelRoute, CollabOrgAgent } from '@agentconnect.md/protocol'
import { KNOWN_PLATFORMS, originKindOf } from '@agentconnect.md/protocol'
import type { ChannelPlacementRecord, OrgAgentRecord } from '../persistence/ports.js'

// §6.1: the origin-kind classification for every platform id this CP build knows,
// shipped on each snapshot so an OLDER daemon/relay can classify an id a newer CP
// introduces. Static today (the seed and the emitted set coincide); the platform
// registry replaces this list when providers land (S3).
const PLATFORM_KINDS = KNOWN_PLATFORMS.map((id) => ({ platformId: id, originKind: originKindOf(id)! }))

export function buildCollabSnapshot(
  orgId: string,
  placements: ChannelPlacementRecord[],
  generation: number,
  orgAgents: OrgAgentRecord[]
): CollabRoutesSnapshot {
  // Sharing is an observed property of ONE conversation, not the bot's `shareable`
  // capacity setting. A bot may be shareable while only one agent is present here;
  // conversely duplicate legacy bot rows may expose the same member id. Count the
  // actual placed agents behind each channel-scoped identity so old daemons receive a
  // truthful compatibility flag.
  const agentsByMentionIdentity = new Map<string, Set<string>>()
  for (const p of placements) {
    if (!p.daemonId || !p.botUserId) continue
    const key = `${p.platform}\u0000${p.channelId}\u0000${p.botUserId}`
    const agents = agentsByMentionIdentity.get(key) ?? new Set<string>()
    agents.add(p.agentId)
    agentsByMentionIdentity.set(key, agents)
  }

  // (platform, channelId) → CollabChannelRoute
  const byChannel = new Map<string, CollabChannelRoute>()
  for (const p of placements) {
    if (!p.daemonId) continue // unplaced agent — not routable
    const key = `${p.platform} ${p.channelId}`
    let route = byChannel.get(key)
    if (!route) {
      route = { orgId, platform: p.platform, channelId: p.channelId, agents: [] }
      byChannel.set(key, route)
    }
    route.agents.push({
      agentId: p.agentId,
      daemonId: p.daemonId,
      integrationId: p.integrationId,
      ...(p.botAppId !== undefined ? { botAppId: p.botAppId } : {}),
      // §8.5 mention-address inputs. Channel-keyed on purpose: an address is only
      // meaningful inside a conversation, which is also why the flat org directory below
      // omits them (an org-wide listing has no single conversation-specific address).
      ...(p.botUserId !== undefined ? { botUserId: p.botUserId } : {}),
      ...(p.botUserId !== undefined &&
      (agentsByMentionIdentity.get(`${p.platform}\u0000${p.channelId}\u0000${p.botUserId}`)?.size ?? 0) > 1
        ? { botShared: true }
        : {}),
      callPolicy: p.callPolicy,
      allowedCallerAgentIds: p.allowedCallerAgentIds,
      outboundPolicy: p.outboundPolicy,
      allowedTargetAgentIds: p.allowedTargetAgentIds,
      name: p.name,
      ...(p.displayName !== undefined ? { displayName: p.displayName } : {})
    })
  }

  // The FLAT org directory, alongside the channel-keyed routes. An agent with no IM
  // integration appears in NO `channels[]` entry, so this list is the only place a
  // holder of the snapshot can learn it exists — and channel-free A2A authorization
  // needs exactly that. Unplaced agents (daemonId null) are dropped for the same
  // reason as in `channels[]`: with no owning daemon there is nothing to route to.
  // No `integrationId`/`botAppId`: both are per-channel reply coordinates, not
  // identity, and this entry is deliberately channel-free.
  const agents: CollabOrgAgent[] = orgAgents
    .filter((a): a is OrgAgentRecord & { daemonId: string } => a.daemonId !== null)
    .map((a) => ({
      orgId,
      agentId: a.agentId,
      daemonId: a.daemonId,
      callPolicy: a.callPolicy,
      allowedCallerAgentIds: a.allowedCallerAgentIds,
      outboundPolicy: a.outboundPolicy,
      allowedTargetAgentIds: a.allowedTargetAgentIds,
      name: a.name,
      ...(a.displayName !== null ? { displayName: a.displayName } : {})
    }))

  return { generation, channels: [...byChannel.values()], agents, platformKinds: PLATFORM_KINDS }
}
