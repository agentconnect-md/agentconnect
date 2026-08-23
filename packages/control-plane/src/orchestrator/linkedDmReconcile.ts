/**
 * §14.8 catch-up: open the DM rows that became authorized after the row was created.
 *
 * The seed in `linkedDm.ts` decides at DISCOVERY time, which is the wrong moment for
 * the flow that actually happens. Someone DMs a private agent, is refused, reads the
 * notice, and only THEN links their Slack account — or is only then added to the
 * agent's audience. Either way the row already exists and is Off, and no reporter
 * re-reports an unchanged conversation. Without this, §14.8 would fire only for people
 * whose link and audience seat both predate their first DM.
 *
 * So both writes that can make the §14.8 answer true — a landed identity link, a
 * widened audience — re-ask it for the Off DMs already on record. The rule that
 * results is order-independent: an audience member with a linked identity has an open
 * DM, however the two arrived.
 *
 * Scoped to the pair that JUST became eligible, never to the current state. A stored
 * Off is indistinguishable from an operator's own choice — §14.2 lets an editor close
 * a DM §14.8 opened — so re-deriving from "everyone currently in the audience who is
 * currently linked" would reopen that DM on the next unrelated sharing edit or profile
 * refresh, turning a DEFAULT into a standing rule that overrides the per-conversation
 * control. Hence the callers pass the members just added, and the link path fires only
 * when the identity actually changed.
 *
 * Deliberately ONE-WAY: it opens rows and never closes them, for the same reason. The
 * consequence is that an opened DM stays open — a gated bind rule is
 * conversation-scoped, with no user dimension, so losing the audience seat does not
 * close the conversation the seat opened, and only an editor's Off does. §14.8 records
 * why, and what telling the two apart would cost.
 *
 * Best-effort at every call site: a failure leaves the rows Off, which is where they
 * already were.
 */
import type {
  AgentRecord,
  AgentRepo,
  BotRecord,
  BotRepo,
  IntegrationChannelRepo,
  IntegrationRepo,
  OrgRepo
} from '../persistence/ports.js'
import { AgentId, IntegrationId, OrgId } from '../domain/ids.js'
import type { SlackIdentity } from '../github/logto-identity.js'
import { linkedMemberIds, type LinkedDmDeps } from './linkedDm.js'
import { isGatedAgent } from './placement.js'

export interface LinkedDmReconcileDeps extends LinkedDmDeps {
  orgs: Pick<OrgRepo, 'listForUser'>
  agents: Pick<AgentRepo, 'list'>
  integrations: Pick<IntegrationRepo, 'listForAgent'>
  bots: Pick<BotRepo, 'getUnscoped'>
  channels: Pick<IntegrationChannelRepo, 'listForIntegration' | 'setTrigger'>
  identity?: { slackIdentityFor(sub: string): Promise<SlackIdentity | null> }
  /** Re-converge every integration of an agent whose rows changed — the same push a
   *  visibility flip performs, so an HTTP bot recompiles its relay routes and a direct
   *  install receives a fresh spec. */
  push: (agent: AgentRecord) => Promise<void>
}

/**
 * Open every Off 1:1 DM of `agent` whose counterpart `admits` allows, and push once if
 * anything changed. `admits` is asked per bot because a platform member id means
 * nothing outside its own workspace.
 */
async function openDirectRows(
  agent: AgentRecord,
  admits: (bot: BotRecord) => Promise<ReadonlySet<string>>,
  deps: LinkedDmReconcileDeps
): Promise<number> {
  if (!isGatedAgent(agent)) return 0
  let opened = 0
  for (const integration of await deps.integrations.listForAgent(AgentId(agent.id))) {
    if (integration.status !== 'active') continue
    const bot = await deps.bots.getUnscoped(integration.botId)
    if (!bot) continue
    const rows = await deps.channels.listForIntegration(IntegrationId(integration.id))
    const candidates = rows.filter((row) => row.kind === 'im' && row.trigger === 'off' && row.dmUserId)
    if (candidates.length === 0) continue
    const allowed = await admits(bot)
    if (allowed.size === 0) continue
    for (const row of candidates) {
      if (!allowed.has(row.dmUserId!)) continue
      await deps.channels.setTrigger(IntegrationId(integration.id), row.channelId, 'any')
      opened += 1
    }
  }
  if (opened > 0) await deps.push(agent)
  return opened
}

/**
 * A link just landed on this account: open this person's Off DMs with every private
 * agent they are already in the audience of, across every org they belong to.
 *
 * `identity` is the one that just became true — the caller establishes that by
 * comparing what it read before the change with what it reads after, so a profile
 * refresh that changed nothing (a reauthorization, a link to some other provider)
 * reconciles nothing. Returns how many rows were opened, for the caller's log line.
 */
export async function reconcileLinkedDms(
  userId: string,
  identity: SlackIdentity,
  deps: LinkedDmReconcileDeps
): Promise<number> {
  // The workspace fence: a Slack member id is scoped to its team, so the same `U…` in
  // another workspace is a different person entirely.
  const admits = async (bot: BotRecord): Promise<ReadonlySet<string>> =>
    bot.platform === 'slack' && bot.teamId === identity.teamId ? new Set([identity.userId]) : new Set()
  let opened = 0
  for (const org of await deps.orgs.listForUser(userId)) {
    // Unfiltered on purpose: the audience test below IS the visibility predicate, so a
    // viewer projection would hide nothing it does not already hide.
    for (const agent of await deps.agents.list(OrgId(org.id))) {
      if (!agent.sharedWith.includes(userId)) continue
      opened += await openDirectRows(agent, admits, deps)
    }
  }
  if (opened > 0) deps.log?.debug({ userId, opened }, 'gated DM: opened conversations after an identity link')
  return opened
}

/**
 * An audience just widened: open the Off DMs of the members it GAINED who have a
 * linked identity. The mirror of {@link reconcileLinkedDms} — same rule, other input.
 *
 * `addedUserIds` is the diff, not the audience. Passing the whole current audience
 * would make every later sharing edit reassert the default over an editor's Off.
 */
export async function reconcileAgentLinkedDms(
  agent: AgentRecord,
  addedUserIds: readonly string[],
  deps: LinkedDmReconcileDeps
): Promise<number> {
  if (addedUserIds.length === 0) return 0
  const opened = await openDirectRows(agent, (bot) => linkedMemberIds(addedUserIds, bot, deps), deps)
  if (opened > 0)
    deps.log?.debug({ agentId: agent.id, opened }, 'gated DM: opened conversations after a sharing change')
  return opened
}
