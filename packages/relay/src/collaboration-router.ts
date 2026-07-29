/**
 * `CollaborationRouter` — the relay's bot-AGNOSTIC agent-collaboration routing table
 * (agent-collaboration §2.3 / §6.2). Unlike {@link BotArbitrationRouter} (keyed by botId,
 * so two agents in the same channel on DIFFERENT bots aren't co-resolvable), this is
 * keyed by `(orgId, platform, channelId)` and holds every agent's placement + call
 * directional policy in that channel — which is what a cross-daemon `rd/agentmsg` needs to
 * resolve `toAgentId → owning daemonId` and authorize the caller.
 *
 * The CP ships the whole snapshot via `rc/collab-routes` (FULL-REPLACE). This class
 * holds it and answers the two questions the `rd/agentmsg` router asks:
 *  - is the CLAIMED caller actually this daemon's agent, in this channel? (§6.2)
 *  - who OWNS the target, and do caller outbound + target inbound policies agree?
 *
 * FOLLOW-UP (P2 scope-down, §6.5): per-entry tombstone / TTL-after-CP-disconnect /
 * fail-closed-on-stale is not implemented — `generation` is tracked but a live CP is
 * assumed. Documented in the PR description.
 */
import type { CollabRoutesSnapshot, CollabAgentPlacement } from '@agentconnect.md/protocol'

/** The resolved placement of one agent in a channel (a snapshot value). */
export interface CollabResolved extends CollabAgentPlacement {
  orgId: string
  platform: string
  channelId: string
}

const SEP = '\u0000'
function key(orgId: string, platform: string, channelId: string): string {
  return orgId + SEP + platform + SEP + channelId
}

export class CollaborationRouter {
  private generation = -1
  // (orgId,platform,channel) → (agentId → placement)
  private readonly channels = new Map<string, Map<string, CollabResolved>>()

  /** FULL-REPLACE the table from a CP snapshot. Ignores an older generation (a
   *  reordered/stale re-push) so the newest snapshot wins. */
  replace(snap: CollabRoutesSnapshot): void {
    if (snap.generation < this.generation) return
    this.generation = snap.generation
    this.channels.clear()
    for (const ch of snap.channels) {
      const byAgent = new Map<string, CollabResolved>()
      for (const a of ch.agents) {
        byAgent.set(a.agentId, { ...a, orgId: ch.orgId, platform: ch.platform, channelId: ch.channelId })
      }
      this.channels.set(key(ch.orgId, ch.platform, ch.channelId), byAgent)
    }
  }

  /** The placement of `agentId` in `(orgId,platform,channel)`, or undefined if it is
   *  not a member there. */
  resolve(orgId: string, platform: string, channelId: string, agentId: string): CollabResolved | undefined {
    return this.channels.get(key(orgId, platform, channelId))?.get(agentId)
  }

  /** Find which org a channel-member agent belongs to WITHOUT the caller asserting an
   *  org — used to bind an inbound `rd/agentmsg` (which carries no orgId) to the org
   *  its `(platform, channel, callerAgentId)` actually resolves in. Cross-org callers
   *  never share a channel row, so caller and target resolve in the SAME org or the
   *  call is rejected (§2.5). */
  channelOrgFor(platform: string, channelId: string, callerAgentId: string): string | undefined {
    for (const byAgent of this.channels.values()) {
      const hit = byAgent.get(callerAgentId)
      if (hit && hit.platform === platform && hit.channelId === channelId) return hit.orgId
    }
    return undefined
  }

  /** Whether `appId` backs an AgentConnect agent alongside `targetAgentId` in the
   *  same org/platform/channel row. Target scoping avoids cross-workspace channel-id
   *  collisions suppressing an unrelated third-party app. */
  isAgentBotAppFor(targetAgentId: string, platform: string, channelId: string, appId: string): boolean {
    for (const byAgent of this.channels.values()) {
      const target = byAgent.get(targetAgentId)
      if (!target || target.platform !== platform || target.channelId !== channelId) continue
      return [...byAgent.values()].some((agent) => agent.botAppId === appId)
    }
    return false
  }
}
