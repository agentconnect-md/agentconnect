// The chat access a departing member takes with them (resource-visibility.md §8.3): planned here, applied by `removeMember`, announced after commit.
import type { HttpDeps } from './deps.js'
import type {
  AgentRecord,
  BotRecord,
  BotSecretMaterial,
  IntegrationChannelKey,
  IntegrationRecord,
  MemberChatRelease,
  MemberRemovalResult
} from '../persistence/ports.js'
import { BotId, OrgId, type IntegrationId } from '../domain/ids.js'
import { isGatedAgent } from '../orchestrator/placement.js'
import { convergeDecisionConsumers } from '../orchestrator/integrationPush.js'
import { notifyBotDeleted, notifyIntegrationRemoved } from './uninstall.js'

interface ReleaseLog {
  debug(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

/** A {@link MemberChatRelease} plus what the post-commit notifications need once its rows are gone. */
export interface PlannedChatRelease {
  release: MemberChatRelease
  bots: Array<{ bot: BotRecord; secrets: BotSecretMaterial | null }>
  installs: IntegrationRecord[]
  /** Each DM row's bot and whether it is a shared (relay) bot, whose routes converge per bot. */
  dmBots: Map<IntegrationId, { botId: string; shared: boolean }>
}

/** What removing `userId` closes: bots bound to them, and DMs on restricted agents with their linked chat identities. */
export async function planMemberChatRelease(
  deps: HttpDeps,
  orgId: string,
  userId: string,
  log: ReleaseLog
): Promise<PlannedChatRelease> {
  const org = OrgId(orgId)
  const bots = await deps.repos.bot.listForOrg(org)
  const bound = bots.filter((bot) => deps.platforms.get(bot.platform)?.boundMemberUserId?.(bot) === userId)
  const boundIds = new Set<string>(bound.map((bot) => bot.id))
  const integrations = await deps.repos.integration.listForOrg(org)
  const plan: PlannedChatRelease = {
    release: { botIds: bound.map((bot) => bot.id), directMessages: [] },
    bots: await Promise.all(
      bound.map(async (bot) => ({
        bot,
        secrets: deps.platforms.get(bot.platform)?.sideEffects?.onBotDelete
          ? await deps.repos.botSecret.get(org, bot.id)
          : null
      }))
    ),
    installs: integrations.filter((i) => boundIds.has(i.botId) && i.status === 'active'),
    dmBots: new Map()
  }
  try {
    await planLinkedDirectMessages(deps, org, userId, bots, boundIds, integrations, plan)
  } catch (err) {
    // An identity outage must not keep a member in the organization; their DMs stay as they are, as before.
    log.warn({ err, userId }, 'member removal: linked chat identities unavailable, DMs left as they are')
    plan.release.directMessages = []
    plan.dmBots.clear()
  }
  return plan
}

// The 1:1 DMs of restricted agents whose counterpart is one of this member's linked chat accounts, matched as chat actions are.
async function planLinkedDirectMessages(
  deps: HttpDeps,
  orgId: OrgId,
  userId: string,
  bots: BotRecord[],
  skip: ReadonlySet<string>,
  integrations: IntegrationRecord[],
  plan: PlannedChatRelease
): Promise<void> {
  const identity = deps.logtoIdentity
  const sub = identity ? await deps.repos.user.getOidcSubject(userId) : null
  if (!identity || !sub) return
  const linked = await identity.chatIdentitiesFor(sub)
  if (linked.length === 0) return
  const agents = new Map<string, AgentRecord>((await deps.repos.agent.list(orgId)).map((a) => [a.id, a]))
  const botsById = new Map<string, BotRecord>(bots.map((bot) => [bot.id, bot]))
  const sharedSeen = new Set<string>()
  const add = (row: IntegrationChannelKey, bot: BotRecord) => {
    plan.release.directMessages.push({ integrationId: row.integrationId, channelId: row.channelId })
    plan.dmBots.set(row.integrationId, { botId: bot.id, shared: bot.transport === 'http' })
  }
  for (const install of integrations) {
    const bot = botsById.get(install.botId)
    if (install.status !== 'active' || !bot || skip.has(bot.id)) continue
    const tenant = deps.platforms.get(bot.platform)?.chatMemberTenant?.(bot)
    if (!tenant) continue
    const theirs = new Set(
      linked.filter((l) => l.platform === bot.platform && l.tenant === tenant).map((l) => l.memberId)
    )
    if (theirs.size === 0) continue
    const opened = (row: { kind: string; trigger: string; dmUserId: string | null }) =>
      row.kind === 'im' && row.trigger !== 'off' && row.dmUserId !== null && theirs.has(row.dmUserId)
    if (bot.transport !== 'http') {
      const agent = agents.get(install.agentId)
      if (!agent || !isGatedAgent(agent)) continue
      for (const row of await deps.repos.integrationChannel.listForIntegration(install.id))
        if (opened(row)) add(row, bot)
      continue
    }
    // A shared bot's conversation is gated by its owning agent and repeats one trigger on every sibling row.
    if (sharedSeen.has(bot.id)) continue
    sharedSeen.add(bot.id)
    const rows = await deps.repos.integrationChannel.listForBot(BotId(bot.id))
    const installsOf = new Map(integrations.map((i) => [String(i.id), i]))
    for (const channelId of new Set(rows.filter(opened).map((row) => row.channelId))) {
      const conversation = rows.filter((row) => row.channelId === channelId)
      const ownerId =
        conversation.find((row) => row.agentId)?.agentId ??
        (conversation.length === 1 ? installsOf.get(String(conversation[0]!.integrationId))?.agentId : undefined)
      const owner = ownerId ? agents.get(ownerId) : undefined
      if (owner && isGatedAgent(owner)) for (const row of conversation) add(row, bot)
    }
  }
}

/** After commit: drop the deleted installs from their daemons, run bot teardown, and re-push the agents whose DMs closed. */
export async function announceMemberChatRelease(
  deps: HttpDeps,
  log: ReleaseLog,
  orgId: string,
  plan: PlannedChatRelease,
  result: MemberRemovalResult
): Promise<void> {
  const removed = new Set<string>(result.removedIntegrationIds)
  for (const install of plan.installs) {
    if (!removed.has(install.id)) continue
    try {
      const agent = await deps.repos.agent.get(OrgId(orgId), install.agentId)
      await notifyIntegrationRemoved(deps, log, install, agent)
    } catch (err) {
      log.warn({ err, integrationId: install.id }, 'member removal: integration/remove failed')
    }
  }
  for (const { bot, secrets } of plan.bots) {
    try {
      await notifyBotDeleted(deps, log, bot, secrets)
      if (bot.transport === 'http') await deps.httpBot.syncBot(bot.id)
    } catch (err) {
      log.warn({ err, botId: bot.id }, 'member removal: bot teardown failed')
    }
  }
  if (result.closedDirectMessages.length === 0) return
  const integrationIds: IntegrationId[] = []
  const sharedBots: string[] = []
  for (const row of result.closedDirectMessages) {
    const owner = plan.dmBots.get(row.integrationId)
    if (owner?.shared) sharedBots.push(owner.botId)
    else integrationIds.push(row.integrationId)
  }
  await convergeDecisionConsumers(deps, integrationIds, log, sharedBots)
}
