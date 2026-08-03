/**
 * `CollaborationRouter` — the relay's bot-AGNOSTIC agent-collaboration routing table
 * (agent-collaboration §2.3 / §6.2). Unlike {@link BotArbitrationRouter} (keyed by botId,
 * so two agents in the same channel on DIFFERENT bots aren't co-resolvable), the
 * channel table is keyed by `(orgId, platform, channelId)` and holds every agent's
 * placement + directional call policy in that channel.
 *
 * On top of that it holds the FLAT org-scoped directory (`snap.agents`), which is what
 * `rd/agentmsg` now authorizes against: A2A delivery is postless, so a shared channel
 * is no longer evidence of anything — discovery/authorization depend ONLY on the
 * directional call policy, org-scoped, and an integration-less agent (webchat, hook,
 * dream) exists in no channel row at all. The channel table survives for the ingress
 * questions that are genuinely channel-shaped ({@link isAgentBotAppFor}, shared-bot
 * resolution).
 *
 * The CP ships the whole snapshot via `rc/collab-routes` (FULL-REPLACE). This class
 * holds it and answers the three questions the `rd/agentmsg` router asks:
 *  - is the CLAIMED caller actually this daemon's agent? (§6.2)
 *  - who OWNS the target, and do caller outbound + target inbound policies agree?
 *  - may the caller assert the `coords` it named? ({@link coordsDecision}) — channel
 *    stopped being an authorization key but is still the woken peer's SESSION key, so the
 *    assertion still needs integrity even though membership no longer grants anything.
 *
 * FOLLOW-UP (P2 scope-down, §6.5): per-entry tombstone / TTL-after-CP-disconnect /
 * fail-closed-on-stale is not implemented — `generation` is tracked but a live CP is
 * assumed. Documented in the PR description.
 */
import type { CollabRoutesSnapshot, CollabAgentPlacement, CollabOrgAgent } from '@agentconnect.md/protocol'
import { originKindOf } from '@agentconnect.md/protocol'

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
/** Coordinate-integrity key: deliberately PLATFORM-FREE — see {@link CollaborationRouter.coordsDecision}. */
function coordsKey(orgId: string, channelId: string): string {
  return orgId + SEP + channelId
}

/**
 * The verdict of {@link CollaborationRouter.coordsDecision} (agent-collaboration §6.2).
 * Three outcomes, not two, because a channel-free wake must neither be rejected nor be
 * allowed to keep the coordinate it named:
 *  - `reject`    — the assertion is not admissible; NAK `not_allowed`.
 *  - `asserted`  — use the coordinate as given (a channel row the caller is in).
 *  - `synthetic` — admissible, but the woken session must key off `channel` (derived from
 *                  the TRUSTED caller) instead of the asserted one.
 *
 * The relay only ever acts on `reject`; the `synthetic` channel is minted where the session
 * key actually is (the target daemon), so the two sides cannot disagree about the result.
 * The daemon carries a BYTE-IDENTICAL twin of this type and of {@link coordsDecision} in
 * `packages/daemon/src/cp/cp-collab-routes.ts` — change one, change both.
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

/** Caller-side half of the directional predicate: does A's outbound policy admit B? */
export function outboundAdmits(caller: CollabOrgAgent, targetAgentId: string): boolean {
  return caller.outboundPolicy !== 'selected' || caller.allowedTargetAgentIds.includes(targetAgentId)
}

/** Target-side half: does B's inbound call policy admit A? */
export function inboundAdmits(target: CollabOrgAgent, callerAgentId: string): boolean {
  return target.callPolicy !== 'selected' || target.allowedCallerAgentIds.includes(callerAgentId)
}

export class CollaborationRouter {
  private generation = -1
  // (orgId,platform,channel) → (agentId → placement)
  private readonly channels = new Map<string, Map<string, CollabResolved>>()
  // (orgId,channel) → the member maps of EVERY platform row sharing that channel id.
  // The coordinate-integrity index; platform-free on purpose ({@link coordsDecision}).
  private readonly byOrgChannel = new Map<string, Map<string, CollabResolved>[]>()
  // agentId → org-scoped directory entry. Agent ids are globally unique UUIDs, so one
  // agent belongs to exactly one org and a flat index loses no addressing precision.
  private readonly byAgent = new Map<string, CollabOrgAgent>()

  // §6.1 wire-carried origin-kind classification. `snapshotKinds` full-replaces with
  // each snapshot (the CP's authoritative list); `learnedKinds` accumulates from
  // rc/bot-assign and survives snapshot replacement (assigns are pushed per bot, not
  // periodically). Resolution: snapshot → learned → protocol seed → 'chat'.
  private readonly snapshotKinds = new Map<string, string>()
  private readonly learnedKinds = new Map<string, string>()

  /** FULL-REPLACE the table from a CP snapshot. Ignores an older generation (a
   *  reordered/stale re-push) so the newest snapshot wins. */
  replace(snap: CollabRoutesSnapshot): void {
    if (snap.generation < this.generation) return
    this.generation = snap.generation
    this.channels.clear()
    this.byOrgChannel.clear()
    this.byAgent.clear()
    this.snapshotKinds.clear()
    for (const k of snap.platformKinds ?? []) this.snapshotKinds.set(k.platformId, k.originKind)
    for (const a of snap.agents) this.byAgent.set(a.agentId, a)
    // Old-CP fallback: a CP that does not advertise `agent-directory-org-scope-v1` sends
    // no `agents[]` (it decodes to the schema default `[]`). Derive the directory from the
    // channel rows so integration-backed pairs keep resolving across a rolling upgrade;
    // an integration-less agent stays invisible until the CP ships the flat list, which
    // is exactly the pre-change behavior.
    if (snap.agents.length === 0) {
      for (const ch of snap.channels) {
        for (const a of ch.agents) {
          if (!this.byAgent.has(a.agentId)) this.byAgent.set(a.agentId, { ...a, orgId: ch.orgId })
        }
      }
    }
    for (const ch of snap.channels) {
      const byAgent = new Map<string, CollabResolved>()
      for (const a of ch.agents) {
        byAgent.set(a.agentId, { ...a, orgId: ch.orgId, platform: ch.platform, channelId: ch.channelId })
      }
      this.channels.set(key(ch.orgId, ch.platform, ch.channelId), byAgent)
      const ck = coordsKey(ch.orgId, ch.channelId)
      const sharing = this.byOrgChannel.get(ck)
      if (sharing) sharing.push(byAgent)
      else this.byOrgChannel.set(ck, [byAgent])
    }
  }

  /** The placement of `agentId` in `(orgId,platform,channel)`, or undefined if it is
   *  not a member there. */
  resolve(orgId: string, platform: string, channelId: string, agentId: string): CollabResolved | undefined {
    return this.channels.get(key(orgId, platform, channelId))?.get(agentId)
  }

  /**
   * COORDINATE INTEGRITY for `rd/agentmsg` (agent-collaboration §6.2), as ONE atomic
   * decision: may `callerAgentId` assert the delivery coordinate `(orgId, platform,
   * channelId)`, and if so, which channel may the woken session actually key off?
   *
   * Channel is no longer an authorization key, but it is still the woken peer's SESSION
   * key, so an asserted `coords` the caller cannot reach would let it resume (and, with
   * `needsReply`, read back) a target session in a channel it has no access to. Three
   * branches, evaluated in this order:
   *
   * (1) KNOWN coordinate — the snapshot holds a NON-EMPTY membership at (org, channel id):
   *     the caller must be in one of them, else `reject`. Otherwise `asserted`: the wake
   *     deliberately lands in the same thread a human sees. This branch is PLATFORM-FREE
   *     (below), so a DIRECT conversation counts wherever its row exists:
   *     `IntegrationChannel.kind` is `channel | im | mpim` and `channelPlacements` selects
   *     the rows with NO `kind` filter, so an `im`/`mpim` row is an ordinary KNOWN
   *     coordinate with its owning integration's agent as a member.
   *
   * (2) UNKNOWN on any CHAT-SHAPED platform — every id outside the enumerated
   *     session-identity set (`isSessionIdentityPlatform`), including ids this build does
   *     not know — `reject`, FAIL CLOSED. An unrecorded chat coordinate is either a channel
   *     the caller cannot reach or a stale/departed row; admitting it is exactly what let a
   *     caller alias an existing platform session, and admitting an UNKNOWN id would reopen
   *     that hole for every future platform (S1a §6.1 replaced the old
   *     enumerate-the-IM-platforms shape, which silently admitted unknown ids). A brief
   *     snapshot lag can therefore transiently reject a genuine wake — the correct
   *     direction for a security boundary, and the caller retries.
   *     ACCEPTED RECALL LOSS (agent-collaboration §2.5 "what the fail-closed branch actually
   *     covers", §2.7 item 5): a direct-conversation row is only WRITTEN where something
   *     observed it — Slack's authoritative membership snapshot enumerates
   *     `public_channel,private_channel` only, and the two paths that DO emit `im`/`mpim`
   *     (the daemon's `reportGatedConversation` and the CP's shared-bot
   *     `reportConversation`) both fire only for a GATED integration/install's
   *     not-yet-enabled conversations — so an ordinary integration's DM has no row and a
   *     wake asserting it is refused here.
   *     Deliberate, and not a regression: the `hasMembers(caller, target)` check this
   *     replaced refused the identical wake.
   *
   * (3) UNKNOWN and channel-free (exactly the session-identity platforms: `webchat`, and
   *     — since the S1a fleet gate passed — a `hook`/`dream` session's raw platform on a
   *     cross-daemon wake) — `synthetic`. NOT a reject: this is the case the org-scoped
   *     directory exists for.
   *     Instead the asserted channel never becomes the session coordinate at all;
   *     {@link a2aCoordChannel} derives it from the trusted caller, which cannot alias any
   *     platform session. The relay does not apply the substitution (see below), only skips
   *     the rejection. An unrecognised id does NOT land here — it is chat-shaped until the
   *     registry says otherwise (2).
   *
   * Branch (1) running FIRST and platform-free is what keeps (3) from being an escape
   * hatch: relabelling a real channel's coordinate as `webchat` still hits branch 1 and
   * still demands membership.
   *
   * PLATFORM-FREE KEY, platform-keyed BRANCH. The lookup key does NOT include the
   * coordinate platform. Historically it COULD not: the daemon computed session keys
   * through its (now deleted) `narrowPlatform` helper, which folded `feishu` — and any
   * value it did not recognise — into `'slack'`, while snapshot rows are keyed by the
   * INTEGRATION platform, so a platform-keyed lookup searched a different key space than
   * the session key it protects and the old "unknown coordinate passes" branch silently
   * swallowed the mismatch (`coords.platform:'feishu'` over a Slack channel id; an honest
   * narrowed `'slack'` over a `feishu` row). Daemon session keys now carry the raw platform
   * (S1a §6.3), but the channel-id-only match stays: it closes the relabelling dodge in
   * both directions regardless of key regime and keeps this and the daemon's copy
   * expressing literally the same rule; it over-blocks only if one org uses the same
   * channel id on two platforms, which then requires membership in one of them, not a
   * bypass. The platform is consulted ONLY to pick between branch 2 and branch 3, and only
   * for a coordinate branch 1 already found nothing for — where the collapse cannot help an
   * attacker, because branch 3 hands back a caller-derived channel rather than the asserted
   * one.
   *
   * A NON-EMPTY member map is what counts as "known": an agent-less row is not a channel
   * anyone in this org can reach, so gating on it would reject every call naming it while
   * protecting nothing.
   *
   * The target daemon applies a BYTE-IDENTICAL twin of this on its terminal-verify
   * (`CpCollabRoutes.coordsDecision`) and is the side that MINTS the synthetic channel —
   * the relay only rejects.
   */
  coordsDecision(orgId: string, platform: string, channelId: string, callerAgentId: string): CoordsVerdict {
    const sharing = this.byOrgChannel.get(coordsKey(orgId, channelId))
    let known = false
    for (const members of sharing ?? []) {
      if (members.size === 0) continue
      known = true
      if (members.has(callerAgentId)) return { verdict: 'asserted' }
    }
    if (known) return { verdict: 'reject' }
    // Registry-driven fail-closed default (§6.1): the platform's ORIGIN KIND decides the
    // branch — wire-carried classification (snapshot `platformKinds` / rc/bot-assign)
    // overlaid on the protocol seed, defaulting to 'chat' for an id neither classifies.
    // 'chat' ⇒ an unrecorded coordinate is refused, fail-closed. Any other classified
    // kind is channel-free ⇒ synthetic, safe even for kinds this build has never heard
    // of: the substitution derives from the TRUSTED caller and cannot alias a platform
    // session (and the relay only acts on reject anyway).
    if (this.originKindFor(platform) === 'chat') return { verdict: 'reject' }
    return { verdict: 'synthetic', channel: a2aCoordChannel(callerAgentId) }
  }

  /** §6.1 kind resolution: snapshot → assign-learned → protocol seed → 'chat'. */
  private originKindFor(platform: string): string {
    return this.snapshotKinds.get(platform) ?? this.learnedKinds.get(platform) ?? originKindOf(platform) ?? 'chat'
  }

  /** §6.1: record a platform's origin kind carried on `rc/bot-assign`, so a bot on an
   *  id this build does not know still classifies before the next full snapshot. */
  learnPlatformKind(platformId: string, originKind: string | undefined): void {
    if (originKind !== undefined) this.learnedKinds.set(platformId, originKind)
  }

  /** The org-scoped directory entry for `agentId`, or undefined if the directory has
   *  never seen it — every authorization decision below fails CLOSED on that. */
  agent(agentId: string): CollabOrgAgent | undefined {
    return this.byAgent.get(agentId)
  }

  /** Which org owns `agentId`, WITHOUT the caller asserting an org — binds an inbound
   *  `rd/agentmsg` (the frame carries no orgId) to the org its authenticated caller
   *  actually lives in, so a cross-org pair can never resolve (§2.5). Channel-free:
   *  the caller need share no channel with anyone. */
  orgForAgent(agentId: string): string | undefined {
    return this.byAgent.get(agentId)?.orgId
  }

  /** The single authorization predicate: both peers known, same org, the caller's
   *  outbound policy admits the target AND the target's inbound policy admits the
   *  caller. A caller always admits ITSELF — an agent with `outboundPolicy: 'selected'`
   *  does not list itself in its own allow-list yet must still see itself in a
   *  directory listing. Callers that need the NAK reason use the halves directly
   *  ({@link outboundAdmits} / {@link inboundAdmits}). */
  admits(callerAgentId: string, targetAgentId: string): boolean {
    const caller = this.byAgent.get(callerAgentId)
    const target = this.byAgent.get(targetAgentId)
    if (!caller || !target || caller.orgId !== target.orgId) return false
    if (callerAgentId === targetAgentId) return true
    return outboundAdmits(caller, targetAgentId) && inboundAdmits(target, callerAgentId)
  }

  // `channelOrgFor(platform, channel, callerAgentId)` used to bind an inbound `rd/agentmsg`
  // to the org its CHANNEL row resolved in. Removed with the channel-membership predicate:
  // org is now bound from the caller's own directory entry ({@link orgForAgent}), which is
  // strictly better — it works for a caller that shares no channel with anyone and for one
  // with no IM integration at all.

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
