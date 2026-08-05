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
import { originKindOf } from '@agentconnect.md/protocol'
import { slackMentionAddress, type AgentMentionIdentity } from '@agentconnect.md/message'

export interface CollabResolved extends CollabAgentPlacement {
  orgId: string
}

/**
 * The verdict of {@link CpCollabRoutes.coordsDecision} (agent-collaboration §6.2).
 * Three outcomes, not two, because a channel-free wake must neither be rejected nor be
 * allowed to keep the coordinate it named:
 *  - `reject`    — the assertion is not admissible; NAK / refuse the wake `not_allowed`.
 *  - `asserted`  — use the coordinate as given (a channel row the caller is in).
 *  - `synthetic` — admissible, but the woken session must key off `channel` (derived from
 *                  the TRUSTED caller) instead of the asserted one.
 *
 * This daemon is where the session key is MINTED, so it is the side that acts on
 * `synthetic`; the relay's byte-identical twin (`packages/relay/src/collaboration-router.ts`)
 * only rejects. Change one, change both.
 */
export type CoordsVerdict = { verdict: 'reject' } | { verdict: 'asserted' } | { verdict: 'synthetic'; channel: string }

/**
 * The coordinate a channel-free wake lands on: derived from the TRUSTED caller, never from
 * anything the caller asserted. Collision-free against every real conversation id by
 * construction — Slack/Telegram/Discord/Feishu channel ids never contain `:` and webchat
 * conversation ids are UUIDs — so it can never alias an existing platform session. Two
 * different asserted channels from one caller therefore collapse onto ONE pairwise session,
 * which is the right shape for a postless agent-to-agent conversation (#854).
 */
export function a2aCoordChannel(callerAgentId: string): string {
  return `a2a:${callerAgentId}`
}

export class CpCollabRoutes {
  private generation = -1
  private readonly channels = new Map<string, Map<string, CollabResolved>>()
  // (orgId,channel) → the member maps of EVERY platform row sharing that channel id.
  // The coordinate-integrity index; platform-free on purpose ({@link coordsDecision}).
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

  // §6.1 wire-carried origin-kind classification (snapshot `platformKinds`): how THIS
  // build classifies a platform id a newer CP introduces. Overlaid on the protocol
  // seed; an id neither classifies defaults to 'chat' (fail-closed in coordsDecision).
  private readonly platformKinds = new Map<string, string>()

  private key(orgId: string, platform: string, channelId: string): string {
    return orgId + '\u0000' + platform + '\u0000' + channelId
  }

  /** Coordinate-integrity key: deliberately PLATFORM-FREE — see {@link coordsDecision}. */
  private coordsKey(orgId: string, channelId: string): string {
    return orgId + '\u0000' + channelId
  }

  /** §6.1 kind resolution: wire classification → protocol seed → 'chat' (fail-closed). */
  private originKindFor(platform: string): string {
    return this.platformKinds.get(platform) ?? originKindOf(platform) ?? 'chat'
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
    this.platformKinds.clear()
    for (const k of snap.platformKinds ?? []) this.platformKinds.set(k.platformId, k.originKind)
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
    // a directory listing. Postless self-wakes are rejected by the delivery path; a
    // paired channel-root self-wake intentionally uses this self admission.
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
   * decision: may `callerAgentId` assert the delivery coordinate `(orgId, platform,
   * channelId)`, and if so, which channel may the woken session actually key off?
   *
   * Channel stopped being an authorization key — A2A delivery is postless (#854) — but it
   * is still the woken peer's SESSION key, so an asserted `coords` the caller cannot reach
   * would let it RESUME (and, with `needsReply`, read back) a target session living in a
   * channel it has no access to. Three branches, evaluated in this order:
   *
   * (1) KNOWN coordinate — the snapshot holds a NON-EMPTY membership at (org, channel id):
   *     the caller must be in one of them, else `reject`. Otherwise `asserted`, which
   *     preserves the deliberate "land in the same thread a human sees" behavior. This
   *     branch is PLATFORM-FREE (below), so a DIRECT conversation counts wherever its row
   *     exists: `IntegrationChannel.kind` is `channel | im | mpim` and
   *     `IntegrationRepo.channelPlacements` selects the rows with NO `kind` filter, so an
   *     `im`/`mpim` row is an ordinary KNOWN coordinate with its owning integration's agent
   *     as a member.
   *
   * (2) UNKNOWN on any CHAT-SHAPED platform — every id outside the enumerated
   *     session-identity set (`isSessionIdentityPlatform`), including ids this build does
   *     not know — `reject`, FAIL CLOSED. An unrecorded chat coordinate is either a
   *     conversation the caller cannot reach or a stale/departed row; admitting it is
   *     exactly what let a caller alias an existing platform session, and admitting an
   *     UNKNOWN id would reopen that hole for every future platform (S1a §6.1 replaced the
   *     old enumerate-the-IM-platforms shape, which silently admitted unknown ids). A brief
   *     snapshot lag can therefore transiently reject a genuine wake — the correct
   *     direction for a security boundary, and the caller retries.
   *     ACCEPTED RECALL LOSS (agent-collaboration §2.5 "what the fail-closed branch actually
   *     covers", §2.7 item 5): a direct-conversation row is written only after something
   *     observes it. `reportObservedConversation` and the CP shared-bot
   *     `reportConversation` now emit rows for every visibility, so an ordinary DM becomes
   *     known after its first inbound message; a wake that races ahead of observation is
   *     still refused here. Deliberate, and not a regression: the `hasMembers(caller,
   *     target)` check this replaced refused the identical wake.
   *
   * (3) UNKNOWN and channel-free (exactly the session-identity platforms: `webchat`,
   *     `dream`, a target-less `hook` session's own platform) — `synthetic`. NOT a reject:
   *     this is the case the org-scoped directory exists for. Instead the asserted channel
   *     never becomes the session coordinate at all; {@link a2aCoordChannel} derives it
   *     from the trusted caller, which cannot alias any platform session. An unrecognised
   *     id does NOT land here — it is chat-shaped until the registry says otherwise (2).
   *
   * Branch (1) running FIRST and platform-free is what keeps (3) from being an escape hatch:
   * relabelling a real channel's coordinate as `webchat` still hits branch 1 and still
   * demands membership.
   *
   * PLATFORM-FREE KEY, platform-keyed BRANCH. The lookup key does NOT include the coordinate
   * platform. Historically it COULD not: session keys were computed through the deleted
   * `narrowPlatform` helper, which folded `feishu` — and any value it did not recognise —
   * into `'slack'`, while snapshot rows are keyed by the INTEGRATION platform, so a
   * platform-keyed lookup searched a different key space than the session key it protects
   * and the old "unknown coordinate passes" branch silently swallowed the mismatch in BOTH
   * directions (`coords.platform:'feishu'` over a Slack channel id; an honest narrowed
   * `'slack'` over a `feishu` row). Session keys now carry the raw platform (S1a §6.3), but
   * the channel-id-only match stays: it is what closes the relabelling dodge in both
   * directions regardless of key regime, and it keeps this and the relay's copy — which
   * never had a fold — expressing literally the same rule. Re-keying the lookup by platform
   * is a separate decision for the registry-driven rewrite, not a consequence of the fold's
   * removal. The platform is consulted ONLY to pick between branch 2 and branch 3, and only
   * for a coordinate branch 1 already found nothing for, where the collapse cannot help an
   * attacker because branch 3 hands back a caller-derived channel rather than the asserted
   * one.
   *
   * A NON-EMPTY member map is what counts as "known": an agent-less row is not a channel
   * anyone in this org can reach, so gating on it would reject every call naming it while
   * protecting nothing.
   *
   * The relay applies a BYTE-IDENTICAL twin on the ingress side, and all three wake paths
   * here (`handleRelayAgentMsg` terminal-verify, `localWakeDecision`, and through it
   * `wakeRejectionReason`'s preflight) go through this one method.
   *
   * Coordinates carry the RAW session platform end-to-end (S1b, post-fleet-gate): a
   * target-less `hook`/`dream` session's cross-daemon wake now asserts its real platform,
   * takes branch 3 on the relay AND on this twin — exactly like the same-daemon path —
   * and the woken child keys off the caller-derived channel. (Until the S1a fleet gate
   * passed, the daemon clamped these to `'slack'` on emission because an un-upgraded peer
   * read `coords.platform` as a closed enum; that clamp is deleted.)
   */
  coordsDecision(orgId: string, platform: string, channelId: string, callerAgentId: string): CoordsVerdict {
    const sharing = this.byOrgChannel.get(this.coordsKey(orgId, channelId))
    let known = false
    for (const members of sharing ?? []) {
      if (members.size === 0) continue
      known = true
      if (members.has(callerAgentId)) return { verdict: 'asserted' }
    }
    if (known) return { verdict: 'reject' }
    // Registry-driven fail-closed default (§6.1): the platform's ORIGIN KIND decides the
    // branch — wire-carried classification (snapshot `platformKinds`, for ids a newer CP
    // introduces) overlaid on the protocol seed, defaulting to 'chat' for an id neither
    // classifies. 'chat' ⇒ an unrecorded coordinate is refused, fail-closed. Any other
    // classified kind is channel-free ⇒ synthetic, which is safe for kinds this build
    // has never heard of too: the substituted coordinate derives from the TRUSTED caller
    // and can never alias a platform session.
    if (this.originKindFor(platform) === 'chat') return { verdict: 'reject' }
    return { verdict: 'synthetic', channel: a2aCoordChannel(callerAgentId) }
  }

  /** Directory name of `agentId` from the latest snapshot (across any channel), or undefined. */
  nameOf(agentId: string): { name?: string; displayName?: string } | undefined {
    return this.names.get(agentId)
  }

  /**
   * The mention-address directory for ONE conversation
   * (send-message-routing-rework.md §8.5): every agent placed in `(orgId, platform,
   * channelId)` with the public inputs needed to render its exact `@mention` and to
   * resolve an inbound mention back to it.
   *
   * Conversation-scoped on purpose. The same slug can name different agents in
   * different channels, and a bot user id only identifies an agent relative to the
   * conversation's membership — so an org-wide list would resolve mentions to the
   * wrong agent, which for §2.1 routing means delivering to the wrong agent.
   */
  mentionDirectory(orgId: string, platform: string, channelId: string): AgentMentionIdentity[] {
    const members = this.channels.get(this.key(orgId, platform, channelId))
    if (!members) return []
    const identities = [...members.values()].map((a) => ({
      agentId: a.agentId,
      ...(a.botUserId !== undefined ? { botUserId: a.botUserId } : {}),
      ...(a.name !== undefined ? { name: a.name } : {})
    }))
    const counts = new Map<string, number>()
    for (const identity of identities) {
      if (identity.botUserId) counts.set(identity.botUserId, (counts.get(identity.botUserId) ?? 0) + 1)
    }
    // Recompute instead of trusting the wire flag. This corrects an older CP that
    // derived `botShared` from the bot's shareable CAPACITY rather than from the
    // identities actually present in this conversation.
    return identities.map((identity) => ({
      ...identity,
      ...(identity.botUserId && (counts.get(identity.botUserId) ?? 0) > 1 ? { botShared: true } : {})
    }))
  }

  /** The exact address for `agentId` in this conversation, or undefined when it has
   *  none there (no Slack presence, or a shared bot with no slug to disambiguate it). */
  mentionAddress(orgId: string, platform: string, channelId: string, agentId: string): string | undefined {
    const identity = this.mentionDirectory(orgId, platform, channelId).find((agent) => agent.agentId === agentId)
    return identity ? slackMentionAddress(identity) : undefined
  }

  /** True when an inbound app backs another AgentConnect agent in this channel.
   *  This is a suppression hint only; it never grants authorization. */
  isAgentBotApp(platform: string, channelId: string, appId: string): boolean {
    return this.botAppsByChannel.get(`${platform}:${channelId}`)?.has(appId) ?? false
  }
}
