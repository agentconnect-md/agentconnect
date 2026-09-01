/**
 * §14.8 — a private agent's DM follows its audience's linked identity.
 *
 * §14.2 gates every conversation of a restricted agent Off because the platform has no
 * per-user ACL: a channel's membership is a room, so the Console (already protected by
 * this design's predicates) has to say who is trusted inside it. A 1:1 DM is the one
 * conversation whose entire human membership is known the moment it is discovered —
 * one bot, one person. When that person's console account is in the agent's OWN
 * `sharedWith` audience, defaulting the row Off protects nobody: it hides the agent
 * from someone already authorized to see, edit, and run it. So that row seeds to the
 * ordinary DM default instead, and "private" starts meaning the same set of people on
 * both surfaces (§14.6's identity-mapping overlay, narrowed to the case where the
 * mapping is an assertion rather than an inference).
 *
 * The link is Logto's — a Slack sign-in, or an Account API link driven by the user's
 * own authenticated session — never an email guess. Both arms must hold: an unlinked
 * member of the audience and a linked non-member both keep today's Off.
 *
 * There is no reverse index from a Slack member id to a console account, and this
 * deliberately does not build one. The audience of a restricted agent is small by
 * construction, so the scan runs the other way: resolve the audience's own linked
 * identities (each a cached per-subject read) and match the reported counterpart
 * against them. Everything here fails CLOSED to the §14.2 default — no sign-in
 * configured, no workspace on the bot, an audience past {@link MAX_AUDIENCE}, or an
 * upstream that cannot answer all leave the row Off, which is exactly today's
 * behavior.
 */
import type { SlackIdentity } from '../github/logto-identity.js'
import type { AgentRecord, BotRecord, ChannelTrigger, ReportedChannel } from '../persistence/ports.js'
import { isGatedAgent } from './placement.js'

/** Concurrent identity reads per resolve — the audience is small and every lookup is
 *  cached per subject, so this only bounds a cold burst. Shared with approvalRoute.ts. */
export const AUDIENCE_CONCURRENCY = 8

/** Audience size past which the scan is refused rather than fanned out upstream. An
 *  agent shared this widely is not the case §14.8 serves, and refusing keeps the
 *  §14.2 default. Shared with approvalRoute.ts (slack-approval-dm.md §4.2). */
export const MAX_AUDIENCE = 200

export interface LinkedDmDeps {
  users: { getOidcSubject(userId: string): Promise<string | null> }
  /** Absent when the deployment has no sign-in configured — then nothing is linked. */
  identity?: { slackIdentityFor(sub: string): Promise<SlackIdentity | null> }
  log?: { debug(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

/** Run `fn` over `values` with at most `limit` in flight, preserving order. */
export async function mapLimited<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const i = next++
      out[i] = await fn(values[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return out
}

/**
 * The platform member ids, among `userIds`, that have linked THIS bot's workspace.
 * Empty for a platform without a linked-identity assertion, a bot whose workspace is
 * unknown, or a deployment without sign-in.
 *
 * Takes an explicit user list rather than reading the audience, because the catch-up
 * paths must ask about the members that just BECAME eligible, not the whole current
 * audience — re-asking for everyone would reopen a DM an editor had since closed.
 */
export async function linkedMemberIds(
  userIds: readonly string[],
  bot: Pick<BotRecord, 'platform' | 'teamId'>,
  deps: LinkedDmDeps
): Promise<ReadonlySet<string>> {
  // Slack only for now: it is the driving case AND the one platform whose linked
  // identity names the same id space a DM report carries. A Feishu link asserts a
  // cross-app `union_id` while its messages carry an app-scoped `open_id`, so
  // matching there needs a resolution step this does not have — and guessing would
  // silently widen a private agent.
  if (!deps.identity || bot.platform !== 'slack' || !bot.teamId) return new Set()
  if (userIds.length === 0) return new Set()
  if (userIds.length > MAX_AUDIENCE) {
    deps.log?.debug({ audience: userIds.length }, 'gated DM: audience too large to resolve — keeping the Off default')
    return new Set()
  }
  const identities = await mapLimited(userIds, AUDIENCE_CONCURRENCY, async (userId) => {
    try {
      const sub = await deps.users.getOidcSubject(userId)
      if (!sub) return null
      const identity = await deps.identity!.slackIdentityFor(sub)
      return identity?.teamId === bot.teamId ? identity.userId : null
    } catch (err) {
      // One member's lookup failing costs that member the default, never the report.
      deps.log?.warn({ err, userId }, 'gated DM: linked-identity lookup failed — keeping the Off default')
      return null
    }
  })
  return new Set(identities.filter((id): id is string => id !== null))
}

/** {@link linkedMemberIds} over a gated agent's whole audience — the seed path, where
 *  every row under consideration is new and there is no operator choice to preserve. */
export async function linkedAudienceMemberIds(
  agent: Pick<AgentRecord, 'visibility' | 'sharedWith'>,
  bot: Pick<BotRecord, 'platform' | 'teamId'>,
  deps: LinkedDmDeps
): Promise<ReadonlySet<string>> {
  return isGatedAgent(agent) ? linkedMemberIds(agent.sharedWith, bot, deps) : new Set()
}

/**
 * The per-conversation seeds a gated install's report deserves: the ordinary DM
 * default for every reported 1:1 DM whose counterpart is in {@link
 * linkedAudienceMemberIds}, and nothing for anything else (which leaves the caller's
 * install-wide Off). Empty when no reported row qualifies, so a caller can skip the
 * identity scan's cost entirely on the common report.
 */
export async function gatedDmSeeds(
  channels: readonly ReportedChannel[],
  agent: Pick<AgentRecord, 'visibility' | 'sharedWith'>,
  bot: Pick<BotRecord, 'platform' | 'teamId'>,
  deps: LinkedDmDeps
): Promise<ReadonlyMap<string, ChannelTrigger>> {
  const seeds = new Map<string, ChannelTrigger>()
  const dms = channels.filter((c) => c.kind === 'im' && c.dmUserId)
  if (dms.length === 0) return seeds
  const linked = await linkedAudienceMemberIds(agent, bot, deps)
  if (linked.size === 0) return seeds
  for (const dm of dms) if (linked.has(dm.dmUserId!)) seeds.set(dm.id, 'any')
  return seeds
}

/** The seam both report paths hold: the daemon WS handler and the shared-bot
 *  orchestrator take this, and the composition root is the only place that knows it
 *  is backed by Logto. Absent ⇒ every gated conversation keeps the §14.2 Off default. */
export type GatedDmSeedResolver = (
  channels: readonly ReportedChannel[],
  agent: Pick<AgentRecord, 'visibility' | 'sharedWith'>,
  bot: Pick<BotRecord, 'platform' | 'teamId'>
) => Promise<ReadonlyMap<string, ChannelTrigger>>
