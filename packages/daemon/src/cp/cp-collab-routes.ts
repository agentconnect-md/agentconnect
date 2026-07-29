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
import type { CollabRoutesSnapshot, CollabAgentPlacement, CollabOrgAgent } from '@agentconnect.md/protocol'

export interface CollabResolved extends CollabAgentPlacement {
  orgId: string
}

export class CpCollabRoutes {
  private generation = -1
  private readonly channels = new Map<string, Map<string, CollabResolved>>()
  // (orgId,channel) → the member maps of EVERY platform row sharing that channel id.
  // The coordinate-integrity index; platform-free on purpose ({@link coordsAdmit}).
  private readonly byOrgChannel = new Map<string, Map<string, CollabResolved>[]>()
  // The daemon snapshot is org-scoped, so platform + channel safely scopes the
  // managed bot-app identities used for platform-message suppression.
  private readonly botAppsByChannel = new Map<string, Set<string>>()
  // Flat agentId → directory name across ALL channels. Agent names are global, so a single
  // map lets the daemon label a REMOTE peer (caller or target of an agent-call) by name in a
  // visible post without knowing the org/channel or having listed it (see agentDisplayLabel).
  private readonly names = new Map<string, { name?: string; displayName?: string }>()
  // FLAT, channel-free directory: agentId → its org-scoped placement + call policy.
  // A2A authorization is channel-free (A2A delivery already is — see the postless
  // note in Daemon.messageAgent, #854), so the authorization input must be a
  // structure an agent with NO IM integration can appear in at all. The
  // channel-keyed maps above structurally cannot express that (see CollabOrgAgent).
  private readonly byAgent = new Map<string, CollabOrgAgent>()

  private key(orgId: string, platform: string, channelId: string): string {
    return orgId + '\u0000' + platform + '\u0000' + channelId
  }

  /** Coordinate-integrity key: deliberately PLATFORM-FREE — see {@link coordsAdmit}. */
  private coordsKey(orgId: string, channelId: string): string {
    return orgId + '\u0000' + channelId
  }

  /** FULL-REPLACE from a CP snapshot (converge-don't-diff); ignore an older generation.
   *  Tolerates an absent snapshot (a pre-collab CP / hand-built test fixture) as a no-op. */
  replace(snap: CollabRoutesSnapshot | undefined): void {
    if (!snap) return
    if (snap.generation < this.generation) return
    this.generation = snap.generation
    this.channels.clear()
    this.byOrgChannel.clear()
    this.botAppsByChannel.clear()
    this.names.clear()
    this.byAgent.clear()
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
      const ck = this.coordsKey(ch.orgId, ch.channelId)
      const sharing = this.byOrgChannel.get(ck)
      if (sharing) sharing.push(byAgent)
      else this.byOrgChannel.set(ck, [byAgent])
      if (botApps.size > 0) this.botAppsByChannel.set(`${ch.platform}:${ch.channelId}`, botApps)
    }
    // The flat directory is the authority when the CP sends one (it advertises
    // `agent-directory-org-scope-v1`), because it is the only list that includes
    // integration-less agents. FULL-REPLACE applies to it exactly like the
    // channel table: cleared above, rebuilt here, no diffing.
    const flat = snap.agents ?? []
    if (flat.length > 0) {
      for (const a of flat) this.byAgent.set(a.agentId, a)
      return
    }
    // OLD-CP FALLBACK: a CP that predates the flat list sends channel entries only.
    // Derive what we can from them — every channel entry carries its `orgId` and its
    // members are placements — so `admits()` keeps working for integration-backed
    // agents. Integration-less agents are simply absent from such a snapshot, and
    // `admits()` fails closed on them, which is that CP's existing behavior anyway.
    for (const ch of snap.channels) {
      for (const a of ch.agents)
        if (!this.byAgent.has(a.agentId)) this.byAgent.set(a.agentId, { ...a, orgId: ch.orgId })
    }
  }

  /** The org that owns `agentId` per the latest snapshot, or undefined when unknown. */
  orgForAgent(agentId: string): string | undefined {
    return this.byAgent.get(agentId)?.orgId
  }

  /** `agentId`'s org-scoped directory entry (placement + call policy), or undefined. */
  agent(agentId: string): CollabOrgAgent | undefined {
    return this.byAgent.get(agentId)
  }

  /**
   * THE agent-call authorization predicate: may `callerAgentId` discover and wake
   * `targetAgentId`? Channel membership plays no part — only the directional
   * call-policy pair, within one org. Fails CLOSED when either agent is unknown to
   * the snapshot (a missing/stale snapshot never grants access) or the orgs differ.
   *
   * NOTE this is the call policy (`callPolicy`/`outboundPolicy`, labelled "Agent
   * visibility" in the console), NOT `Agent.visibility`/`sharedWith` — the latter
   * governs HUMAN console access and must never affect the peer directory.
   */
  admits(callerAgentId: string, targetAgentId: string): boolean {
    const caller = this.byAgent.get(callerAgentId)
    const target = this.byAgent.get(targetAgentId)
    if (!caller || !target) return false
    if (caller.orgId !== target.orgId) return false
    // A caller always resolves ITSELF: an agent with outboundPolicy 'selected' does
    // not normally list itself in its own allow-list, yet it must still see itself in
    // a directory listing. (A self-WAKE is rejected earlier, with reason 'self'.)
    if (callerAgentId === targetAgentId) return true
    if (caller.outboundPolicy === 'selected' && !caller.allowedTargetAgentIds.includes(targetAgentId)) return false
    if (target.callPolicy === 'selected' && !target.allowedCallerAgentIds.includes(callerAgentId)) return false
    return true
  }

  /** The placement of `agentId` in `(orgId,platform,channel)`, or undefined. */
  resolve(orgId: string, platform: string, channelId: string, agentId: string): CollabResolved | undefined {
    return this.channels.get(this.key(orgId, platform, channelId))?.get(agentId)
  }

  /**
   * COORDINATE INTEGRITY for a wake (§2.5 #4 / agent-collaboration §6.2), as ONE atomic
   * predicate: may `callerAgentId` assert the delivery coordinate `(orgId, channelId)`?
   *
   * Channel stopped being an authorization key — A2A delivery is postless (#854) — but it
   * is still the woken peer's SESSION key, so an asserted `coords` the caller cannot reach
   * would let it RESUME (and, with `needsReply`, read back) a target session living in a
   * channel it has no access to. The rule: if the snapshot knows any NON-EMPTY membership
   * at that coordinate, the caller must be in one of them; if it knows none, the coordinate
   * is not a claim about a shared IM channel and needs no membership evidence. The relay
   * applies the IDENTICAL predicate on the ingress side, and all three wake paths here
   * (`handleRelayAgentMsg` terminal-verify, `localWakeAuthorizationRejection`, and through
   * it `wakeRejectionReason`'s preflight) go through this one method.
   *
   * PLATFORM-FREE ON PURPOSE. The coordinate platform must NOT be part of the key: the
   * woken session's key is computed from {@link Daemon.narrowPlatform}, which folds
   * `feishu` — and any value it does not recognise — into `'slack'`, while snapshot rows
   * are keyed by the INTEGRATION platform. A platform-keyed check therefore searched a
   * different key space than the session key it protects, and the "unknown coordinate
   * passes" branch silently swallowed the mismatch in BOTH directions: `coords.platform:
   * 'feishu'` over a Slack channel id, and (in a Feishu org) an honest narrowed `'slack'`
   * over a `feishu` row. Either missed the row, passed, and still computed a bit-identical
   * child session key. Matching on the channel id alone closes both, keeps the daemon and
   * the relay — which has no `narrowPlatform` — expressing literally the same rule, and
   * over-blocks only if one org uses the same channel id on two platforms (which then
   * demands membership in one of them, not a bypass).
   *
   * A NON-EMPTY member map is what counts as "known": an agent-less row is not a channel
   * anyone in this org can reach, so gating on it would reject every call naming it while
   * protecting nothing.
   *
   * KNOWN LIMIT (follow-up, not closed here): "unknown coordinate" cannot distinguish
   * "not an IM channel" from "an IM channel the CP does not record". Slack DMs and group
   * DMs are deliberately never channel rows (`listBotChannels` skips `is_im`/`is_mpim`),
   * and a row disappears when the bot leaves or the integration goes inactive while the
   * session stays resumable — such coordinates take the pass branch.
   */
  coordsAdmit(orgId: string, channelId: string, callerAgentId: string): boolean {
    const sharing = this.byOrgChannel.get(this.coordsKey(orgId, channelId))
    if (sharing === undefined) return true
    let known = false
    for (const members of sharing) {
      if (members.size === 0) continue
      known = true
      if (members.has(callerAgentId)) return true
    }
    return !known
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
