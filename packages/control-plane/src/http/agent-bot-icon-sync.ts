import type {
  AgentRecord,
  AgentRepo,
  BotRecord,
  BotRepo,
  BotSecretStore,
  IntegrationRepo
} from '../persistence/ports.js'
import type { BotProfileIconAgent } from './bot-profile-icon.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'

interface AgentBotIconSyncDeps {
  repos: {
    agent: Pick<AgentRepo, 'getUnscoped'>
    integration: Pick<IntegrationRepo, 'listForAgent' | 'listForBot'>
    bot: Pick<BotRepo, 'getUnscoped'>
    botSecret: Pick<BotSecretStore, 'get'>
  }
  /** §9 platform registry. `sideEffects.syncBotProfileIcon` IS the capability
   *  probe this fan-out used to spell as three `bot.platform === … && deps.syncX`
   *  conjunctions: a platform that declares no member is skipped, exactly as
   *  Slack always was (it renders per-message `icon_url` from the public CP
   *  endpoint instead of pushing a bot avatar). Read at CALL time — every reader
   *  of the registry runs long after composition. */
  platforms: CpPlatformRegistry
}

/** The platform's profile-icon pusher, or `undefined` when this platform has no
 *  dedicated-bot avatar to converge. */
function iconPusherFor(deps: AgentBotIconSyncDeps, platform: string) {
  return deps.platforms.get(platform)?.sideEffects?.syncBotProfileIcon
}

interface AgentBotIconSyncLogger {
  warn(bindings: Record<string, unknown>, message: string): void
}

interface CurrentBotIconState {
  bot: BotRecord
  agent: AgentRecord
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
  // Background convergence, not the HTTP surface: both sides of the ownership
  // edge are re-read from system state, exactly like the agent read below
  // (org-scoped-data-layer.md §4).
  const bot = await deps.repos.bot.getUnscoped(botId)
  if (!bot || bot.shareable || bot.revokedAt) return null

  if (!iconPusherFor(deps, bot.platform)) return null

  const memberships = await deps.repos.integration.listForBot(bot.id)
  if (memberships.length !== 1) return null
  const membership = memberships[0]!
  if (membership.platform !== bot.platform) return null

  const agent = await deps.repos.agent.getUnscoped(membership.agentId)
  if (!agent || agent.orgId !== bot.orgId) return null
  return {
    bot,
    agent,
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
      const profileAgent: BotProfileIconAgent = {
        id: state.agent.id,
        icon: state.agent.icon,
        runtime: state.agent.runtime
      }
      // One awaited provider call, no platform branch: which credential the push
      // needs (Feishu resolves its app id from `secrets.appToken ?? bot.feishuAppId`
      // and no-ops without one) is the provider's business, not this fan-out's.
      await iconPusherFor(deps, state.bot.platform)?.(state.bot, secret, profileAgent)
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

/** Push one changed Agent icon to each dedicated bot currently installed on it
 * whose platform declares `sideEffects.syncBotProfileIcon` (Telegram, Discord and
 * Feishu today). Shared identities are deliberately excluded: one platform
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
