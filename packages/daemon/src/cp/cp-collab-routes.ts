/**
 * `CpCollabRoutes` — the daemon-side cache of the bot-agnostic collaboration routing
 * snapshot (agent-collaboration §2.3/§6.2/§6.5). The CP ships it as the
 * `register/ok.collabRoutes` baseline + the `collaboration/routes` EVT; the daemon
 * uses it to TERMINAL-VERIFY (defense in depth, §2.5 #4) a forwarded remote caller's
 * org/channel/placement — it never blindly trusts the relay's minted claim.
 *
 * FOLLOW-UP (P2 scope-down, §6.5): TTL-after-CP-disconnect / tombstone / fail-closed
 * on a STALE snapshot is not implemented — `generation` is tracked, a live CP is
 * assumed. Documented in the PR description.
 */
import type { CollabRoutesSnapshot, CollabAgentPlacement } from '@agentconnect.md/protocol'

export interface CollabResolved extends CollabAgentPlacement {
  orgId: string
}

export class CpCollabRoutes {
  private generation = -1
  private readonly channels = new Map<string, Map<string, CollabResolved>>()
  // Secondary index used by same-daemon delivery, whose trusted MCP request has
  // platform/channel coordinates but no model-controlled org id. A daemon's
  // snapshot is org-scoped; the array keeps the lookup fail-closed even if a
  // malformed snapshot ever repeats the same coordinates across organizations.
  private readonly channelsByCoordinates = new Map<string, Map<string, CollabResolved>[]>()
  // The daemon snapshot is org-scoped, so platform + channel safely scopes the
  // managed bot-app identities used for platform-message suppression.
  private readonly botAppsByChannel = new Map<string, Set<string>>()
  // Flat agentId → directory name across ALL channels. Agent names are global, so a single
  // map lets the daemon label a REMOTE peer (caller or target of an agent-call) by name in a
  // visible post without knowing the org/channel or having listed it (see agentDisplayLabel).
  private readonly names = new Map<string, { name?: string; displayName?: string }>()

  private key(orgId: string, platform: string, channelId: string): string {
    return orgId + '\u0000' + platform + '\u0000' + channelId
  }

  private coordinatesKey(platform: string, channelId: string): string {
    return platform + '\u0000' + channelId
  }

  /** FULL-REPLACE from a CP snapshot (converge-don't-diff); ignore an older generation.
   *  Tolerates an absent snapshot (a pre-collab CP / hand-built test fixture) as a no-op. */
  replace(snap: CollabRoutesSnapshot | undefined): void {
    if (!snap) return
    if (snap.generation < this.generation) return
    this.generation = snap.generation
    this.channels.clear()
    this.channelsByCoordinates.clear()
    this.botAppsByChannel.clear()
    this.names.clear()
    for (const ch of snap.channels) {
      const byAgent = new Map<string, CollabResolved>()
      const botApps = new Set<string>()
      for (const a of ch.agents) {
        byAgent.set(a.agentId, { ...a, orgId: ch.orgId })
        if (a.botAppId) botApps.add(a.botAppId)
        if (a.name !== undefined || a.displayName !== undefined)
          this.names.set(a.agentId, { name: a.name, displayName: a.displayName })
      }
      this.channels.set(this.key(ch.orgId, ch.platform, ch.channelId), byAgent)
      const coordinatesKey = this.coordinatesKey(ch.platform, ch.channelId)
      const coordinateChannels = this.channelsByCoordinates.get(coordinatesKey) ?? []
      coordinateChannels.push(byAgent)
      this.channelsByCoordinates.set(coordinatesKey, coordinateChannels)
      if (botApps.size > 0) this.botAppsByChannel.set(`${ch.platform}:${ch.channelId}`, botApps)
    }
  }

  /** The placement of `agentId` in `(orgId,platform,channel)`, or undefined. */
  resolve(orgId: string, platform: string, channelId: string, agentId: string): CollabResolved | undefined {
    return this.channels.get(this.key(orgId, platform, channelId))?.get(agentId)
  }

  /** True only when every requested agent is present in one org-scoped channel
   *  entry. Used to keep same-daemon delivery aligned with relay membership
   *  checks without trusting an org id from the tool request. */
  hasMembers(platform: string, channelId: string, agentIds: readonly string[]): boolean {
    const channels = this.channelsByCoordinates.get(this.coordinatesKey(platform, channelId)) ?? []
    return channels.some((agents) => agentIds.every((agentId) => agents.has(agentId)))
  }

  /** Directory name of `agentId` from the latest snapshot (across any channel), or undefined. */
  nameOf(agentId: string): { name?: string; displayName?: string } | undefined {
    return this.names.get(agentId)
  }

  /** True when an inbound app backs another AgentConnect agent in this channel.
   *  This is a suppression hint only; it never grants authorization. */
  isAgentBotApp(platform: string, channelId: string, appId: string): boolean {
    return this.botAppsByChannel.get(`${platform}:${channelId}`)?.has(appId) ?? false
  }
}
