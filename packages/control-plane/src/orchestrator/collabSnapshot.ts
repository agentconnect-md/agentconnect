/**
 * `buildCollabSnapshot` — assemble the bot-AGNOSTIC collaboration routing snapshot
 * (agent-collaboration §2.3/§6.2) from an org's channel placements. Groups the flat
 * placement records into per-channel `CollabChannelRoute`s, dropping unplaced agents
 * (no daemonId ⇒ not routable). Bodiless routing/policy metadata only.
 *
 * The SAME snapshot is shipped to the relay (`rc/collab-routes`, full org) and to a
 * daemon (`register/ok.collabRoutes` / `collaboration/routes` EVT). The daemon copy is
 * the terminal-verify source for REMOTE callers (§2.5 #4).
 *
 * FOLLOW-UP (P2 scope-down, §6.5): `generation` is a plain counter passed by the
 * caller; per-entry tombstone / TTL / fail-closed-on-stale is not implemented.
 */
import type { CollabRoutesSnapshot, CollabChannelRoute } from '@agentconnect.md/protocol'
import type { ChannelPlacementRecord } from '../persistence/ports.js'

export function buildCollabSnapshot(
  orgId: string,
  placements: ChannelPlacementRecord[],
  generation: number
): CollabRoutesSnapshot {
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
      callPolicy: p.callPolicy,
      allowedCallerAgentIds: p.allowedCallerAgentIds,
      outboundPolicy: p.outboundPolicy,
      allowedTargetAgentIds: p.allowedTargetAgentIds,
      name: p.name,
      ...(p.displayName !== undefined ? { displayName: p.displayName } : {})
    })
  }
  return { generation, channels: [...byChannel.values()] }
}
