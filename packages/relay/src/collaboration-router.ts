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
 *  - is the asserted `coords` a shared IM channel the caller can actually reach?
 *    ({@link coordsAdmit}) — channel stopped being an authorization key but is still the
 *    woken peer's SESSION key, so the assertion still needs integrity even though
 *    membership no longer grants anything.
 *
 * FOLLOW-UP (P2 scope-down, §6.5): per-entry tombstone / TTL-after-CP-disconnect /
 * fail-closed-on-stale is not implemented — `generation` is tracked but a live CP is
 * assumed. Documented in the PR description.
 */
import type { CollabRoutesSnapshot, CollabAgentPlacement, CollabOrgAgent } from '@agentconnect.md/protocol'

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
/** Coordinate-integrity key: deliberately PLATFORM-FREE — see {@link CollaborationRouter.coordsAdmit}. */
function coordsKey(orgId: string, channelId: string): string {
  return orgId + SEP + channelId
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
  // The coordinate-integrity index; platform-free on purpose ({@link coordsAdmit}).
  private readonly byOrgChannel = new Map<string, Map<string, CollabResolved>[]>()
  // agentId → org-scoped directory entry. Agent ids are globally unique UUIDs, so one
  // agent belongs to exactly one org and a flat index loses no addressing precision.
  private readonly byAgent = new Map<string, CollabOrgAgent>()

  /** FULL-REPLACE the table from a CP snapshot. Ignores an older generation (a
   *  reordered/stale re-push) so the newest snapshot wins. */
  replace(snap: CollabRoutesSnapshot): void {
    if (snap.generation < this.generation) return
    this.generation = snap.generation
    this.channels.clear()
    this.byOrgChannel.clear()
    this.byAgent.clear()
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
   * predicate: may `callerAgentId` assert the delivery coordinate `(orgId, channelId)`?
   *
   * Channel is no longer an authorization key, but it is still the woken peer's SESSION
   * key, so an asserted `coords` the caller cannot reach would let it resume (and, with
   * `needsReply`, read back) a target session in a channel it has no access to. The rule:
   * if the snapshot knows any NON-EMPTY membership at that coordinate, the caller must be
   * in one of them; if it knows none, the coordinate is not a claim about a shared IM
   * channel and needs no membership evidence. The target daemon's terminal-verify applies
   * the IDENTICAL predicate — the two must never disagree.
   *
   * PLATFORM-FREE ON PURPOSE. The coordinate platform must NOT be part of the key: the
   * woken session's key is computed from a NARROWED platform (the daemon's
   * `narrowPlatform` folds `feishu` — and any value it does not recognise — into
   * `'slack'`), while snapshot rows are keyed by the INTEGRATION platform. Keying this
   * check on the raw wire platform therefore searched a different key space than the
   * session key it protects, and the "unknown coordinate passes" branch silently
   * swallowed the mismatch: `coords.platform:'feishu'` over a Slack channel id (or, in a
   * Feishu org, an honest narrowed `'slack'` over a `feishu` row) missed the row, passed,
   * and still computed a bit-identical child session key. Matching on the channel id
   * alone closes both directions and needs no `narrowPlatform` twin on the relay side. It
   * over-blocks only if one org uses the same channel id on two platforms — which then
   * requires membership in one of them, not a bypass.
   *
   * A NON-EMPTY member map is what counts as "known": an agent-less row is not a channel
   * anyone in this org can reach, so gating on it would reject every call naming it while
   * protecting nothing.
   *
   * KNOWN LIMIT (follow-up, not closed here): "unknown coordinate" cannot distinguish
   * "not an IM channel" from "an IM channel the CP does not record". Slack DMs and group
   * DMs are deliberately never channel rows, and a row disappears when the bot leaves or
   * the integration goes inactive while the session stays resumable — such coordinates
   * take the pass branch.
   */
  coordsAdmit(orgId: string, channelId: string, callerAgentId: string): boolean {
    const sharing = this.byOrgChannel.get(coordsKey(orgId, channelId))
    if (sharing === undefined) return true
    let known = false
    for (const members of sharing) {
      if (members.size === 0) continue
      known = true
      if (members.has(callerAgentId)) return true
    }
    return !known
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
