import type {
  AgentRecord,
  AgentRepo,
  BotRecord,
  BotRepo,
  BotSecretStore,
  IntegrationRepo
} from '../persistence/ports.js'
import type { BotProfileIconAgent } from './bot-profile-icon.js'
import type { DiscordBotIconSyncer } from './discord-bot-profile.js'
import type { TelegramBotIconSyncer } from './telegram-bot-profile.js'

interface AgentBotIconSyncDeps {
  repos: {
    agent: Pick<AgentRepo, 'get'>
    integration: Pick<IntegrationRepo, 'listForAgent' | 'listForBot'>
    bot: Pick<BotRepo, 'get'>
    botSecret: Pick<BotSecretStore, 'get'>
  }
  syncTelegramBotIcon?: TelegramBotIconSyncer
  syncDiscordBotIcon?: DiscordBotIconSyncer
}

interface AgentBotIconSyncLogger {
  warn(bindings: Record<string, unknown>, message: string): void
}

interface CurrentBotIconState {
  bot: BotRecord
  agent: AgentRecord
  sync: TelegramBotIconSyncer | DiscordBotIconSyncer
  version: string
}

function agentIconVersion(agent: AgentRecord): string {
  const icon = agent.icon
  const iconVersion =
    icon?.kind === 'glyph'
      ? `${icon.kind}:${icon.glyph}:${icon.color}`
      : icon?.kind === 'image'
        ? `${icon.kind}:${icon.generation ?? 'legacy'}`
        : 'runtime'
  return `${agent.lastModifiedAt.getTime()}:${agent.runtime ?? ''}:${iconVersion}`
}

/** Re-read both sides of the dedicated-bot ownership edge. This is deliberately
 * done before and after every provider call: an external write cannot share the
 * database transaction that changes an Agent icon or bot membership. */
async function currentBotIconState(
  deps: AgentBotIconSyncDeps,
  botId: BotRecord['id']
): Promise<CurrentBotIconState | null> {
  const bot = await deps.repos.bot.get(botId)
  if (!bot || bot.shareable || bot.revokedAt) return null

  const sync =
    bot.platform === 'telegram'
      ? deps.syncTelegramBotIcon
      : bot.platform === 'discord'
        ? deps.syncDiscordBotIcon
        : undefined
  if (!sync) return null

  const memberships = await deps.repos.integration.listForBot(bot.id)
  if (memberships.length !== 1) return null
  const membership = memberships[0]!
  if (membership.platform !== bot.platform) return null

  const agent = await deps.repos.agent.get(membership.agentId)
  if (!agent || agent.orgId !== bot.orgId) return null
  return {
    bot,
    agent,
    sync,
    version: `${bot.credentialRevision}:${membership.id}:${agent.id}:${agentIconVersion(agent)}`
  }
}

async function syncBotIconUntilCurrent(
  deps: AgentBotIconSyncDeps,
  botId: BotRecord['id'],
  log: AgentBotIconSyncLogger
): Promise<void> {
  let state = await currentBotIconState(deps, botId)
  while (state) {
    const secret = await deps.repos.botSecret.get(state.bot.id)
    if (!secret) {
      log.warn(
        { agentId: state.agent.id, botId: state.bot.id, platform: state.bot.platform },
        'agent bot icon sync skipped: bot credential is missing'
      )
      return
    }

    try {
      await state.sync(secret.botToken, state.agent)
    } catch (err) {
      log.warn(
        { err, agentId: state.agent.id, botId: state.bot.id },
        'agent bot icon sync failed; the Agent icon remains updated'
      )
    }

    const current = await currentBotIconState(deps, botId)
    if (!current || current.version === state.version) return
    state = current
  }
}

/** Push one changed Agent icon to each dedicated Telegram/Discord bot currently
 * installed on it. Shared identities are deliberately excluded: one platform
 * avatar cannot represent several agents. After each provider call, re-read and
 * repair to the latest icon/current owner so detached requests are latest-wins.
 * Every failure stays cosmetic. */
export async function syncAgentBotIcons(
  deps: AgentBotIconSyncDeps,
  agent: BotProfileIconAgent,
  log: AgentBotIconSyncLogger
): Promise<void> {
  let integrations
  try {
    integrations = await deps.repos.integration.listForAgent(agent.id)
  } catch (err) {
    log.warn({ err, agentId: agent.id }, 'agent bot icon fan-out failed while listing integrations')
    return
  }

  const botIds = [...new Set(integrations.map((integration) => integration.botId))]
  await Promise.all(
    botIds.map(async (botId) => {
      try {
        await syncBotIconUntilCurrent(deps, botId, log)
      } catch (err) {
        log.warn({ err, agentId: agent.id, botId }, 'agent bot icon sync failed; the Agent icon remains updated')
      }
    })
  )
}
