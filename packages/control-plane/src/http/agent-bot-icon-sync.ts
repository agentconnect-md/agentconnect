import type { BotRepo, BotSecretStore, IntegrationRepo } from '../persistence/ports.js'
import type { BotProfileIconAgent } from './bot-profile-icon.js'
import type { DiscordBotIconSyncer } from './discord-bot-profile.js'
import type { TelegramBotIconSyncer } from './telegram-bot-profile.js'

interface AgentBotIconSyncDeps {
  repos: {
    integration: Pick<IntegrationRepo, 'listForAgent'>
    bot: Pick<BotRepo, 'get'>
    botSecret: Pick<BotSecretStore, 'get'>
  }
  syncTelegramBotIcon?: TelegramBotIconSyncer
  syncDiscordBotIcon?: DiscordBotIconSyncer
}

interface AgentBotIconSyncLogger {
  warn(bindings: Record<string, unknown>, message: string): void
}

/** Push one changed Agent icon to each dedicated Telegram/Discord bot currently
 * installed on it. Shared identities are deliberately excluded: one platform
 * avatar cannot represent several agents. Every failure stays cosmetic. */
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
        const bot = await deps.repos.bot.get(botId)
        if (!bot || bot.shareable || bot.revokedAt) return

        const sync =
          bot.platform === 'telegram'
            ? deps.syncTelegramBotIcon
            : bot.platform === 'discord'
              ? deps.syncDiscordBotIcon
              : undefined
        if (!sync) return

        const secret = await deps.repos.botSecret.get(bot.id)
        if (!secret) {
          log.warn(
            { agentId: agent.id, botId: bot.id, platform: bot.platform },
            'agent bot icon sync skipped: bot credential is missing'
          )
          return
        }
        await sync(secret.botToken, agent)
      } catch (err) {
        log.warn({ err, agentId: agent.id, botId }, 'agent bot icon sync failed; the Agent icon remains updated')
      }
    })
  )
}
